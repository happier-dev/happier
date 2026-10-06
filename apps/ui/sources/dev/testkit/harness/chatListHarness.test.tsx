import * as React from 'react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createSessionFixture, createTestSessionTranscriptSource, standardCleanup, wrapWithSessionTranscriptSource } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from './serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from './syncSingletonLoader';
import { installTranscriptCommonModuleMocks } from '@/components/sessions/transcript/transcriptTestHelpers';

installTranscriptCommonModuleMocks({
    reactNative: async () =>
        (await import('./chatListHarness')).createChatListHarnessReactNativeMock({ platformOs: 'web' }),
});
installDisconnectedServerSocketBoundary();
vi.mock('@legendapp/list/react-native', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@legendapp/list/react-native')>()),
    ...(await import('./chatListHarness')).createLegendChatListModuleMock(),
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
}));

await loadSyncSingletonForTests();
// Resolve the real transcript graph before installing the scoped scrolling DOM.
const { ChatList } = await import('@/components/sessions/transcript/ChatList');

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
    it('preserves real DOM event lifetime and mutable scroller layout measurements', async () => {
        const { createChatListHarnessWebScroller, withChatListHarnessWebScrollerDom } = await import('./chatListHarness');
        const previousDocument = globalThis.document;
        const previousWindow = globalThis.window;
        const geometry = createChatListHarnessWebScroller({ clientHeight: 400, scrollHeight: 1200, scrollTop: 200 });
        const onKeyDown = vi.fn();
        await withChatListHarnessWebScrollerDom(geometry, async () => {
            const element = document.querySelector('div');
            expect(element).toBeInstanceOf(HTMLElement);
            expect(document.body.contains(element)).toBe(true);
            expect(element?.scrollTop).toBe(200);
            geometry.scrollTop = 300;
            expect(element?.scrollTop).toBe(300);
            if (!element) throw new Error('Expected genuine scroll element');
            element.scrollTop = 5000;
            expect(geometry.scrollTop).toBe(800);
            document.addEventListener('keydown', onKeyDown);
            document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End' }));
            expect(onKeyDown).toHaveBeenCalledOnce();
            document.removeEventListener('keydown', onKeyDown);
            document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home' }));
            expect(onKeyDown).toHaveBeenCalledOnce();
        });
        expect(globalThis.document).toBe(previousDocument);
        expect(globalThis.window).toBe(previousWindow);
    });

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

    it('renders the real Legend chat list inside the installed web scroller DOM and returns the harness', async () => {
        const {
            ChatListHarnessWebElement,
            createChatListHarnessWebScroller,
            resetChatListHarness,
            withRenderedChatListHarnessWebScroller,
        } = await import('./chatListHarness');
        resetChatListHarness({ platformOs: 'web' });
        onTestFinished(standardCleanup);
        const session = createSessionFixture({ serverId: 'test-server', metadata: null });
        const source = createTestSessionTranscriptSource({
            sessionId: session.id,
            serverId: session.serverId,
            messages: [{ kind: 'user-text', id: 'harness-message', localId: null, createdAt: 1, text: 'Harness transcript content' }],
        });

        const scroller = createChatListHarnessWebScroller({
            clientHeight: 400,
            scrollHeight: 1200,
            scrollTop: 200,
        });

        await withRenderedChatListHarnessWebScroller(
            scroller,
            <ChatList session={session} sessionSurfaceKey={JSON.stringify(['test-server', session.id])} />,
            async (screen) => {
                expect(document.querySelector('div')).toBe(scroller);
                expect(screen.findAllByType('LegendList')).toHaveLength(1);
                expect(screen.findAllByType('LegendListItem')).toHaveLength(1);
                expect(screen.getTextContent()).toContain('Harness transcript content');
            },
            {
                dom: { HTMLElement: ChatListHarnessWebElement },
                render: { wrapper: ({ children }) => wrapWithSessionTranscriptSource(<>{children}</>, source) },
            },
        );
    });
});
