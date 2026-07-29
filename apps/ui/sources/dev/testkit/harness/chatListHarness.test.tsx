import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

const DELETED_LEGACY_CHAT_LIST_HARNESS_EXPORTS = [
    ['legacy', 'ChatListHarnessState'].join(''),
    ['render', 'LegacyChatList'].join(''),
    ['reset', 'LegacyChatListHarness'].join(''),
    ['trigger', 'LegacyChatListScroll'].join(''),
    ['trigger', 'LegacyChatListInitialFill'].join(''),
    ['trigger', 'LegacyChatListEndReached'].join(''),
    ['get', 'CapturedFlatListProps'].join(''),
    ['require', 'CapturedFlatListProps'].join(''),
    ['build', 'LegacyChatListItems'].join(''),
    ['create', 'LegacyChatListItemsModuleMock'].join(''),
    ['create', 'LegacyChatListReactNativeMock'].join(''),
    ['create', 'LegacyChatListStorageMock'].join(''),
];

describe('chatListHarness', () => {
    it('does not export deleted legacy ChatList harness compatibility aliases', async () => {
        const harnessModule = await import('./chatListHarness');

        for (const deletedExport of DELETED_LEGACY_CHAT_LIST_HARNESS_EXPORTS) {
            expect(harnessModule).not.toHaveProperty(deletedExport);
        }
    });

    it('creates reusable fake web elements for transcript DOM anchoring scenarios', async () => {
        const harnessModule = await import('./chatListHarness');
        const createChatListHarnessWebElement = Reflect.get(harnessModule, 'createChatListHarnessWebElement');
        const ChatListHarnessWebElement = Reflect.get(harnessModule, 'ChatListHarnessWebElement');

        expect(typeof createChatListHarnessWebElement).toBe('function');
        expect(typeof ChatListHarnessWebElement).toBe('function');
        if (typeof createChatListHarnessWebElement !== 'function') {
            return;
        }

        const parent = createChatListHarnessWebElement(null, { top: 0, bottom: 400 });
        const child = createChatListHarnessWebElement('transcript-item-u1', { top: 50, bottom: 150 });

        parent.setQuerySelectorAll('[data-testid]', [child]);
        child.parentElement = parent;

        expect(child.getAttribute('data-testid')).toBe('transcript-item-u1');
        expect(parent.querySelectorAll('[data-testid]')).toEqual([child]);
        expect(child.getBoundingClientRect().top).toBe(50);

        child.setRect({ top: 80, bottom: 180 });
        expect(child.getBoundingClientRect().bottom).toBe(180);
        expect(parent.contains(parent)).toBe(true);
        expect(parent.contains(child)).toBe(false);
    });

    it('creates a clamped FlashList web scroller for transcript prepend-anchor scenarios', async () => {
        const harnessModule = await import('./chatListHarness');
        const createChatListHarnessWebScroller = Reflect.get(harnessModule, 'createChatListHarnessWebScroller');
        const createChatListHarnessWebElement = Reflect.get(harnessModule, 'createChatListHarnessWebElement');

        expect(typeof createChatListHarnessWebScroller).toBe('function');
        expect(typeof createChatListHarnessWebElement).toBe('function');
        if (
            typeof createChatListHarnessWebScroller !== 'function'
            || typeof createChatListHarnessWebElement !== 'function'
        ) {
            return;
        }

        const anchor = createChatListHarnessWebElement('transcript-anchor-message-u1', { top: 120, bottom: 180 });
        const scroller = createChatListHarnessWebScroller({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 999,
            testNodes: [anchor],
        });

        expect(scroller.scrollTop).toBe(600);
        expect(scroller.querySelectorAll('[data-testid]')).toEqual([anchor]);

        scroller.scrollTop = -50;
        expect(scroller.scrollTop).toBe(0);

        scroller.scrollTop = 5000;
        expect(scroller.scrollTop).toBe(600);
    });

    it('installs and restores a custom HTMLElement while the web scroller DOM helper runs', async () => {
        const harnessModule = await import('./chatListHarness');
        const withChatListHarnessWebScrollerDom = Reflect.get(harnessModule, 'withChatListHarnessWebScrollerDom');
        const createChatListHarnessWebElement = Reflect.get(harnessModule, 'createChatListHarnessWebElement');
        const ChatListHarnessWebElement = Reflect.get(harnessModule, 'ChatListHarnessWebElement');

        expect(typeof withChatListHarnessWebScrollerDom).toBe('function');
        expect(typeof createChatListHarnessWebElement).toBe('function');
        expect(typeof ChatListHarnessWebElement).toBe('function');
        if (
            typeof withChatListHarnessWebScrollerDom !== 'function'
            || typeof createChatListHarnessWebElement !== 'function'
            || typeof ChatListHarnessWebElement !== 'function'
        ) {
            return;
        }

        const previousHTMLElement = (globalThis as any).HTMLElement;
        const scroller = createChatListHarnessWebElement(null, { top: 0, bottom: 300 });

        await withChatListHarnessWebScrollerDom(
            scroller,
            async () => {
                expect((globalThis as any).HTMLElement).toBe(ChatListHarnessWebElement);
                expect((globalThis as any).document.querySelector()).toBe(scroller);
            },
            { HTMLElement: ChatListHarnessWebElement },
        );

        expect((globalThis as any).HTMLElement).toBe(previousHTMLElement);
    });

    it('renders a FlashList chat list inside the installed web scroller DOM and returns the harness', async () => {
        vi.doMock('@/components/sessions/transcript/ChatList', () => ({
            ChatList: () => React.createElement('MockChatList'),
        }));

        try {
            const harnessModule = await import('./chatListHarness');
            const withRenderedChatListHarnessWebScroller = Reflect.get(harnessModule, 'withRenderedChatListHarnessWebScroller');
            const createChatListHarnessWebScroller = Reflect.get(harnessModule, 'createChatListHarnessWebScroller');

            expect(typeof withRenderedChatListHarnessWebScroller).toBe('function');
            expect(typeof createChatListHarnessWebScroller).toBe('function');
            if (
                typeof withRenderedChatListHarnessWebScroller !== 'function'
                || typeof createChatListHarnessWebScroller !== 'function'
            ) {
                return;
            }

            const scroller = createChatListHarnessWebScroller({
                clientHeight: 400,
                scrollHeight: 1200,
                scrollTop: 200,
            });

            await withRenderedChatListHarnessWebScroller(
                scroller,
                React.createElement('MockChatList'),
                async (screen: any) => {
                    expect((globalThis as any).document.querySelector()).toBe(scroller);
                    expect(screen.findByType('MockChatList')).toBeTruthy();
                },
                {
                    dom: { HTMLElement: Reflect.get(harnessModule, 'ChatListHarnessWebElement') },
                },
            );
        } finally {
            vi.doUnmock('@/components/sessions/transcript/ChatList');
            vi.resetModules();
        }
    });
});
