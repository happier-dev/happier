import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

describe('chatListHarness', () => {
    it('captures FlashList props and drives initial fill for FlashList ChatList tests', async () => {
        const harnessModule = await import('./chatListHarness');

        const resetFlashListChatListHarness = Reflect.get(harnessModule, 'resetFlashListChatListHarness');
        const createFlashListChatListModuleMock = Reflect.get(harnessModule, 'createFlashListChatListModuleMock');
        const requireCapturedFlashListProps = Reflect.get(harnessModule, 'requireCapturedFlashListProps');
        const triggerFlashListChatListInitialFill = Reflect.get(harnessModule, 'triggerFlashListChatListInitialFill');

        expect(typeof resetFlashListChatListHarness).toBe('function');
        expect(typeof createFlashListChatListModuleMock).toBe('function');
        expect(typeof requireCapturedFlashListProps).toBe('function');
        expect(typeof triggerFlashListChatListInitialFill).toBe('function');

        if (
            typeof resetFlashListChatListHarness !== 'function' ||
            typeof createFlashListChatListModuleMock !== 'function' ||
            typeof requireCapturedFlashListProps !== 'function' ||
            typeof triggerFlashListChatListInitialFill !== 'function'
        ) {
            return;
        }

        resetFlashListChatListHarness();

        const flashListModule = await createFlashListChatListModuleMock();
        const onLayout = vi.fn();
        const onContentSizeChange = vi.fn();
        const ref = React.createRef<unknown>();
        const FlashListComponent = flashListModule.FlashList as any;

        await act(async () => {
            FlashListComponent.render?.(
                {
                    ref,
                    data: [],
                    onLayout,
                    onContentSizeChange,
                },
                ref,
            );
        });

        const capturedFlashListProps = requireCapturedFlashListProps();
        expect(capturedFlashListProps.onLayout).toBe(onLayout);
        expect(capturedFlashListProps.onContentSizeChange).toBe(onContentSizeChange);

        await triggerFlashListChatListInitialFill({
            layoutHeight: 320,
            layoutWidth: 400,
            contentHeight: 960,
            contentWidth: 400,
        });

        expect(onLayout).toHaveBeenCalledWith({
            nativeEvent: {
                layout: {
                    height: 320,
                    width: 400,
                },
            },
        });
        expect(onContentSizeChange).toHaveBeenCalledWith(400, 960);
    });

    it('creates reusable fake web elements for transcript DOM anchoring scenarios', async () => {
        const harnessModule = await import('./chatListHarness');
        const createFlashListChatListWebElement = Reflect.get(harnessModule, 'createFlashListChatListWebElement');
        const FlashListChatListWebElement = Reflect.get(harnessModule, 'FlashListChatListWebElement');

        expect(typeof createFlashListChatListWebElement).toBe('function');
        expect(typeof FlashListChatListWebElement).toBe('function');
        if (typeof createFlashListChatListWebElement !== 'function') {
            return;
        }

        const parent = createFlashListChatListWebElement(null, { top: 0, bottom: 400 });
        const child = createFlashListChatListWebElement('transcript-item-u1', { top: 50, bottom: 150 });

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
        const createFlashListChatListWebScroller = Reflect.get(harnessModule, 'createFlashListChatListWebScroller');
        const createFlashListChatListWebElement = Reflect.get(harnessModule, 'createFlashListChatListWebElement');

        expect(typeof createFlashListChatListWebScroller).toBe('function');
        expect(typeof createFlashListChatListWebElement).toBe('function');
        if (
            typeof createFlashListChatListWebScroller !== 'function'
            || typeof createFlashListChatListWebElement !== 'function'
        ) {
            return;
        }

        const anchor = createFlashListChatListWebElement('transcript-anchor-message-u1', { top: 120, bottom: 180 });
        const scroller = createFlashListChatListWebScroller({
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
        const withFlashListChatListWebScrollerDom = Reflect.get(harnessModule, 'withFlashListChatListWebScrollerDom');
        const createFlashListChatListWebElement = Reflect.get(harnessModule, 'createFlashListChatListWebElement');
        const FlashListChatListWebElement = Reflect.get(harnessModule, 'FlashListChatListWebElement');

        expect(typeof withFlashListChatListWebScrollerDom).toBe('function');
        expect(typeof createFlashListChatListWebElement).toBe('function');
        expect(typeof FlashListChatListWebElement).toBe('function');
        if (
            typeof withFlashListChatListWebScrollerDom !== 'function'
            || typeof createFlashListChatListWebElement !== 'function'
            || typeof FlashListChatListWebElement !== 'function'
        ) {
            return;
        }

        const previousHTMLElement = (globalThis as any).HTMLElement;
        const scroller = createFlashListChatListWebElement(null, { top: 0, bottom: 300 });

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                expect((globalThis as any).HTMLElement).toBe(FlashListChatListWebElement);
                expect((globalThis as any).document.querySelector()).toBe(scroller);
            },
            { HTMLElement: FlashListChatListWebElement },
        );

        expect((globalThis as any).HTMLElement).toBe(previousHTMLElement);
    });

    it('renders a FlashList chat list inside the installed web scroller DOM and returns the harness', async () => {
        vi.doMock('@/components/sessions/transcript/ChatList', () => ({
            ChatList: () => React.createElement('MockChatList'),
        }));

        try {
            const harnessModule = await import('./chatListHarness');
            const withRenderedFlashListChatListWebScroller = Reflect.get(harnessModule, 'withRenderedFlashListChatListWebScroller');
            const createFlashListChatListWebScroller = Reflect.get(harnessModule, 'createFlashListChatListWebScroller');

            expect(typeof withRenderedFlashListChatListWebScroller).toBe('function');
            expect(typeof createFlashListChatListWebScroller).toBe('function');
            if (
                typeof withRenderedFlashListChatListWebScroller !== 'function'
                || typeof createFlashListChatListWebScroller !== 'function'
            ) {
                return;
            }

            const scroller = createFlashListChatListWebScroller({
                clientHeight: 400,
                scrollHeight: 1200,
                scrollTop: 200,
            });

            await withRenderedFlashListChatListWebScroller(
                scroller,
                React.createElement('MockChatList'),
                async (screen: any) => {
                    expect((globalThis as any).document.querySelector()).toBe(scroller);
                    expect(screen.root.findByType('MockChatList')).toBeTruthy();
                },
                {
                    initialFill: false,
                    dom: { HTMLElement: Reflect.get(harnessModule, 'FlashListChatListWebElement') },
                },
            );
        } finally {
            vi.doUnmock('@/components/sessions/transcript/ChatList');
            vi.resetModules();
        }
    });
});
