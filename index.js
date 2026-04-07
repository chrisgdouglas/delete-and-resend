(() => {
    'use strict';

    const EXTENSION_ID = 'delete-and-resend';
    const BUTTON_CLASS = 'dar-message-action';
    const BUTTON_ATTR = 'data-dar-button';
    const BUTTON_SELECTOR = `.${BUTTON_CLASS}[${BUTTON_ATTR}]`;
    const CHAT_SELECTOR = '#chat';
    const MESSAGE_SELECTOR = '.mes';
    const ACTION_ROW_SELECTORS = [
        '.mes_buttons',
        '.extraMesButtons',
    ];

    let fallbackObserver = null;
    let refreshQueued = false;
    let fallbackObserverEnabled = false;

    function log(...args) {
        console.debug(`[${EXTENSION_ID}]`, ...args);
    }

    function getContextSafe() {
        const getContext = window?.SillyTavern?.getContext;
        return typeof getContext === 'function' ? getContext() : null;
    }

    function getChatRoot() {
        return document.querySelector(CHAT_SELECTOR);
    }

    function getTextarea() {
        return document.querySelector('#send_textarea');
    }

    function getSendButton() {
        return document.querySelector('#send_but');
    }

    function getExistingButton() {
        return document.querySelector(BUTTON_SELECTOR);
    }

    function getLastUserMessageIndex(chat) {
        if (!Array.isArray(chat)) return -1;

        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];
            if (message && message.is_user && !message.is_system) {
                return i;
            }
        }

        return -1;
    }

    function getMessageElementByIndex(index) {
        return document.querySelector(`${CHAT_SELECTOR} ${MESSAGE_SELECTOR}[mesid="${index}"]`);
    }

    function getActionRow(messageElement) {
        if (!messageElement) return null;

        for (const selector of ACTION_ROW_SELECTORS) {
            const row = messageElement.querySelector(selector);
            if (row) return row;
        }

        return null;
    }

    function createButton() {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `menu_button interactable ${BUTTON_CLASS}`;
        button.setAttribute(BUTTON_ATTR, 'true');
        button.setAttribute('title', 'Delete & Resend');
        button.setAttribute('aria-label', 'Delete & Resend');
        button.innerHTML = '<i class="fa-solid fa-trash-arrow-up"></i>';

        button.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();

            const messageIndex = Number(button.dataset.messageIndex);
            if (!Number.isInteger(messageIndex)) {
                toastr?.warning?.('Could not determine message index.');
                return;
            }

            await handleDeleteAndResend(messageIndex);
        });

        return button;
    }

    function renumberRenderedMessages(startIndex = 0) {
        const chatRoot = getChatRoot();
        if (!chatRoot) return;

        const messages = [...chatRoot.querySelectorAll(`${MESSAGE_SELECTOR}[mesid]`)];
        for (const element of messages) {
            const current = Number(element.getAttribute('mesid'));
            if (!Number.isInteger(current) || current < startIndex) continue;
            element.setAttribute('mesid', String(current - 1));
        }
    }

    function removeRenderedMessageAt(index) {
        const element = getMessageElementByIndex(index);
        if (!element) return false;

        element.remove();
        renumberRenderedMessages(index + 1);
        return true;
    }

    function withFallbackObserverPaused(fn) {
        const wasEnabled = fallbackObserverEnabled;
        fallbackObserverEnabled = false;
        try {
            return fn();
        } finally {
            fallbackObserverEnabled = wasEnabled;
        }
    }

    async function deleteMessageFromChat(ctx, messageIndex) {
        const isTailDelete = messageIndex === ctx.chat.length - 1;

        ctx.chat.splice(messageIndex, 1);

        if (isTailDelete) {
            // Current ST source has a dedicated delete-last-message path separate from full reload.
            // We mimic the lightweight behavior: remove the tail DOM node and emit MESSAGE_DELETED.
            withFallbackObserverPaused(() => {
                const removed = removeRenderedMessageAt(messageIndex);
                if (!removed) {
                    log('Tail delete DOM node not found; continuing with state save.');
                }
            });
        } else {
            // Non-tail delete: update the DOM surgically and renumber mesid attributes.
            withFallbackObserverPaused(() => {
                const removed = removeRenderedMessageAt(messageIndex);
                if (!removed) {
                    log('Non-tail delete DOM node not found; scheduled refresh will repair UI.');
                }
            });
        }

        if (ctx.eventSource && ctx.eventTypes?.MESSAGE_DELETED) {
            await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_DELETED, messageIndex);
        }

        if (typeof ctx.saveChat === 'function') {
            await ctx.saveChat();
        }
    }

    async function resendText(textarea, sendButton, text) {
        textarea.value = text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
        sendButton.click();
    }

    async function handleDeleteAndResend(messageIndex) {
        const ctx = getContextSafe();
        const textarea = getTextarea();
        const sendButton = getSendButton();

        if (!ctx || !Array.isArray(ctx.chat)) {
            toastr?.warning?.('SillyTavern chat context is not ready yet.');
            return;
        }

        if (!textarea || !sendButton) {
            toastr?.warning?.('Could not find the chat input or send button.');
            return;
        }

        const message = ctx.chat[messageIndex];
        if (!message || !message.is_user || message.is_system) {
            toastr?.info?.('That message is no longer available.');
            scheduleRefresh();
            return;
        }

        const text = typeof message.mes === 'string' ? message.mes : '';
        if (!text.length) {
            toastr?.info?.('The selected message is empty.');
            return;
        }

        try {
            await deleteMessageFromChat(ctx, messageIndex);
            await resendText(textarea, sendButton, text);
            scheduleRefresh();
        } catch (error) {
            console.error(`[${EXTENSION_ID}] Delete & Resend failed:`, error);

            // Only now use full reload as a recovery path.
            try {
                if (typeof ctx.reloadCurrentChat === 'function') {
                    await ctx.reloadCurrentChat();
                }
            } catch (reloadError) {
                console.error(`[${EXTENSION_ID}] Recovery reload failed:`, reloadError);
            }

            toastr?.error?.('Delete & Resend failed. See console for details.');
            scheduleRefresh();
        }
    }

    function placeButtonOnLastUserMessage() {
        const ctx = getContextSafe();
        const existingButton = getExistingButton();

        if (!ctx || !Array.isArray(ctx.chat)) {
            if (existingButton) existingButton.remove();
            return;
        }

        const lastUserIndex = getLastUserMessageIndex(ctx.chat);
        if (lastUserIndex < 0) {
            if (existingButton) existingButton.remove();
            return;
        }

        const messageElement = getMessageElementByIndex(lastUserIndex);
        if (!messageElement) {
            return;
        }

        const actionRow = getActionRow(messageElement);
        if (!actionRow) {
            return;
        }

        if (
            existingButton &&
            existingButton.dataset.messageIndex === String(lastUserIndex) &&
            actionRow.contains(existingButton)
        ) {
            return;
        }

        withFallbackObserverPaused(() => {
            if (existingButton) {
                existingButton.remove();
            }

            const button = createButton();
            button.dataset.messageIndex = String(lastUserIndex);
            actionRow.appendChild(button);
        });
    }

    function scheduleRefresh() {
        if (refreshQueued) return;
        refreshQueued = true;

        queueMicrotask(() => {
            refreshQueued = false;
            placeButtonOnLastUserMessage();
        });
    }

    function attachEventDrivenRefresh() {
        const ctx = getContextSafe();
        if (!ctx?.eventSource || !ctx?.eventTypes) return false;

        const eventKeys = [
            'APP_INITIALIZED',
            'APP_READY',
            'CHAT_CHANGED',
            'MESSAGE_SENT',
            'MESSAGE_RECEIVED',
            'MESSAGE_EDITED',
            'MESSAGE_DELETED',
            'MESSAGE_UPDATED',
            'USER_MESSAGE_RENDERED',
            'CHARACTER_MESSAGE_RENDERED',
        ];

        let attached = false;

        for (const key of eventKeys) {
            const eventName = ctx.eventTypes[key];
            if (!eventName) continue;
            ctx.eventSource.on(eventName, scheduleRefresh);
            attached = true;
        }

        return attached;
    }

    function attachFallbackObserver() {
        const chatRoot = getChatRoot();
        if (!chatRoot) return;

        fallbackObserverEnabled = true;
        fallbackObserver = new MutationObserver((mutations) => {
            if (!fallbackObserverEnabled) return;

            // Fallback only for structural changes in the chat area.
            const relevant = mutations.some(m => m.type === 'childList');
            if (relevant) {
                scheduleRefresh();
            }
        });

        fallbackObserver.observe(chatRoot, {
            childList: true,
            subtree: true,
        });
    }

    function boot() {
        const attachedEvents = attachEventDrivenRefresh();

        // Events first; mutation observer is only a safety net.
        attachFallbackObserver();

        log('booted', { attachedEvents });
        scheduleRefresh();
    }

    const ctx = getContextSafe();
    if (ctx?.eventSource && ctx?.eventTypes?.APP_INITIALIZED) {
        ctx.eventSource.once(ctx.eventTypes.APP_INITIALIZED, boot);
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
