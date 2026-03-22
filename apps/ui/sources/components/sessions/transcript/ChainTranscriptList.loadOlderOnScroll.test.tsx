import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createDeferred, flushHookEffects, invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/sync', () => ({
    sync: {
        getSyncTuning: () => ({
            transcriptFlashListEstimatedItemSize: 120,
        }),
    },
}));

vi.mock('@/components/sessions/transcript/MessageView', () => ({
    MessageView: () => null,
}));

let scrollToEndSpy: ReturnType<typeof vi.fn> | null = null;
let scrollToIndexSpy: ReturnType<typeof vi.fn> | null = null;
let scrollToOffsetSpy: ReturnType<typeof vi.fn> | null = null;
let scrollToIndexShouldReject = false;

vi.mock('@shopify/flash-list', () => ({
    FlashList: React.forwardRef((props: any, ref: any) => {
        scrollToEndSpy = vi.fn();
        scrollToIndexSpy = vi.fn((params: any) => {
            if (scrollToIndexShouldReject) {
                return Promise.reject(new Error('missing layout'));
            }
            return Promise.resolve(params);
        });
        scrollToOffsetSpy = vi.fn();
        const instance = {
            scrollToEnd: scrollToEndSpy,
            scrollToIndex: scrollToIndexSpy,
            scrollToOffset: scrollToOffsetSpy,
        };
        if (typeof ref === 'function') ref(instance);
        else if (ref && typeof ref === 'object') ref.current = instance;
        return React.createElement('FlashList', props);
    }),
}));

describe('ChainTranscriptList', () => {
    async function renderChainTranscriptList(props: React.ComponentProps<typeof import('./ChainTranscriptList')['ChainTranscriptList']>) {
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        return renderScreen(React.createElement(ChainTranscriptList, props));
    }

    function getFlashList(screen: Awaited<ReturnType<typeof renderChainTranscriptList>>) {
        return screen.findByType('FlashList' as any);
    }

    async function settleListEffects(turns = 1) {
        await flushHookEffects({ cycles: 1, turns });
    }

    afterEach(() => {
        standardCleanup();
    });

    it('does not pass deprecated estimatedItemSize to FlashList v2', async () => {
        scrollToIndexShouldReject = false;
        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
        });

        const list = screen.findByType('FlashList' as any);
        expect(list.props.estimatedItemSize).toBeUndefined();
        expect(list.props.overrideProps).toBeUndefined();
    });

    it('pins to the last transcript item instead of scrolling into the footer on first layout', async () => {
        scrollToIndexShouldReject = false;
        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            footer: React.createElement('Footer'),
        });

        const list = getFlashList(screen);

        await act(async () => {
            invokeTestInstanceHandler(list, 'onLayout', { nativeEvent: { layout: { height: 300 } } });
            list.props.onContentSizeChange(0, 600);
            await settleListEffects();
        });

        expect(scrollToIndexSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                index: 0,
                animated: false,
                viewPosition: 1,
            }),
        );
        expect(scrollToEndSpy).not.toHaveBeenCalled();
    });

    it('falls back to an estimated last-item offset when scrollToIndex cannot measure yet', async () => {
        scrollToIndexShouldReject = true;
        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [
                { kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'first', isThinking: false },
                { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, text: 'second', isThinking: false },
            ],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            footer: React.createElement('Footer'),
        });

        const list = getFlashList(screen);

        await act(async () => {
            invokeTestInstanceHandler(list, 'onLayout', { nativeEvent: { layout: { height: 300 } } });
            list.props.onContentSizeChange(0, 600);
            await settleListEffects(2);
        });

        expect(scrollToIndexSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                index: 0,
                animated: false,
                viewPosition: 1,
            }),
        );
        expect(scrollToOffsetSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                offset: 0,
                animated: false,
            }),
        );
        expect(scrollToEndSpy).not.toHaveBeenCalled();
    });

    it('does not call loadOlder more than once while a load is in flight', async () => {
        scrollToIndexShouldReject = false;
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        const deferred = createDeferred<{ loaded: number; hasMore: boolean; status: 'loaded' }>();
        const loadOlder = vi.fn(async () => await deferred.promise);

        const screen = await renderScreen(
            React.createElement(ChainTranscriptList, {
                sessionId: 's1',
                messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
                metadata: null,
                interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                loadOlder,
            }),
        );

        const list = getFlashList(screen);
        expect(typeof list.props.onScroll).toBe('function');
        expect(typeof list.props.onLayout).toBe('function');
        expect(typeof list.props.onContentSizeChange).toBe('function');

        await act(async () => {
            invokeTestInstanceHandler(list, 'onLayout', { nativeEvent: { layout: { height: 500 } } });
            list.props.onContentSizeChange(0, 1000);
            list.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 0 },
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 500 },
                },
            });
            list.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 0 },
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 500 },
                },
            });
            await settleListEffects();
        });

        expect(loadOlder).toHaveBeenCalledTimes(1);
        deferred.resolve({ loaded: 1, hasMore: true, status: 'loaded' });
    });

    it('loads older when scrolled near the top (even if onStartReached is not fired)', async () => {
        scrollToIndexShouldReject = false;
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        const deferred = createDeferred<{ loaded: number; hasMore: boolean; status: 'loaded' }>();
        const loadOlder = vi.fn(async () => await deferred.promise);

        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            loadOlder,
        });

        const list = getFlashList(screen);
        expect(typeof list.props.onScroll).toBe('function');
        expect(typeof list.props.onLayout).toBe('function');
        expect(typeof list.props.onContentSizeChange).toBe('function');

        await act(async () => {
            invokeTestInstanceHandler(list, 'onLayout', { nativeEvent: { layout: { height: 500 } } });
            list.props.onContentSizeChange(0, 1000);
            list.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 0 },
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 500 },
                },
            });
            await settleListEffects();
            expect(loadOlder).toHaveBeenCalledTimes(1);
            const loadOlderPromise = loadOlder.mock.results[0]?.value as Promise<unknown> | undefined;
            expect(loadOlderPromise).toBeInstanceOf(Promise);
            deferred.resolve({ loaded: 1, hasMore: true, status: 'loaded' });
            if (loadOlderPromise) {
                await loadOlderPromise;
            }
            await settleListEffects();
        });

        expect(loadOlder).toHaveBeenCalledTimes(1);
    });

    it('loads older on web-like scroll events where layout/content sizes are not present', async () => {
        scrollToIndexShouldReject = false;
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        const deferred = createDeferred<{ loaded: number; hasMore: boolean; status: 'loaded' }>();
        const loadOlder = vi.fn(async () => await deferred.promise);

        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            loadOlder,
        });

        const list = getFlashList(screen);
        expect(typeof list.props.onScroll).toBe('function');
        expect(typeof list.props.onLayout).toBe('function');
        expect(typeof list.props.onContentSizeChange).toBe('function');

        await act(async () => {
            invokeTestInstanceHandler(list, 'onLayout', { nativeEvent: { layout: { height: 500 } } });
            list.props.onContentSizeChange(0, 1000);
            list.props.onScroll({ nativeEvent: { contentOffset: { y: 0 } } });
            await settleListEffects();
            expect(loadOlder).toHaveBeenCalledTimes(1);
            const loadOlderPromise = loadOlder.mock.results[0]?.value as Promise<unknown> | undefined;
            expect(loadOlderPromise).toBeInstanceOf(Promise);
            deferred.resolve({ loaded: 1, hasMore: true, status: 'loaded' });
            if (loadOlderPromise) {
                await loadOlderPromise;
            }
            await settleListEffects();
        });

        expect(loadOlder).toHaveBeenCalledTimes(1);
    });

    it('does not load older while pinned at the bottom of a short transcript', async () => {
        scrollToIndexShouldReject = false;
        const loadOlder = vi.fn(async () => ({ loaded: 1, hasMore: true, status: 'loaded' as const }));

        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            loadOlder,
        });

        const list = getFlashList(screen);
        await act(async () => {
            invokeTestInstanceHandler(list, 'onLayout', { nativeEvent: { layout: { height: 500 } } });
            list.props.onContentSizeChange(0, 600);
            list.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 100 },
                    contentSize: { height: 600 },
                    layoutMeasurement: { height: 500 },
                },
            });
            await settleListEffects();
        });

        expect(loadOlder).not.toHaveBeenCalled();
    });

    it('preserves the viewport when older messages prepend above the current position on web', async () => {
        scrollToIndexShouldReject = false;
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        const scrollEl: any = {
            scrollTop: 100,
            scrollHeight: 1000,
            clientHeight: 500,
        };
        const loadOlder = vi.fn(async () => {
            scrollEl.scrollHeight = 1300;
            return { loaded: 5, hasMore: true, status: 'loaded' as const };
        });

        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            loadOlder,
        });

        const list = getFlashList(screen);
        await act(async () => {
            invokeTestInstanceHandler(list, 'onLayout', { nativeEvent: { layout: { height: 500 } } });
            list.props.onContentSizeChange(0, 1000);
            list.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 100 },
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 500 },
                    target: scrollEl,
                },
                target: scrollEl,
            });
            await settleListEffects(3);
        });

        expect(loadOlder).toHaveBeenCalledTimes(1);
        expect(scrollEl.scrollTop).toBe(400);
    });
});
