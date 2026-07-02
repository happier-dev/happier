import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createDeferred, flushHookEffects, invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const chainSyncTuningState = vi.hoisted(() => ({
    transcriptFlashListEstimatedItemSize: 120,
    transcriptBackwardPrefetchThresholdPx: 800,
    transcriptOlderLoadCooldownMs: 2500,
    transcriptMaxTurnEntriesPerListItem: 8,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        getSyncTuning: () => chainSyncTuningState,
    },
}));

vi.mock('@/components/sessions/transcript/MessageView', () => ({
    MessageView: () => null,
    MessageViewWithSessionCommon: () => null,
}));

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
    ToolCallsGroupRow: () => null,
    ToolCallsGroupRowWithSessionCommon: () => null,
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

    beforeEach(() => {
        chainSyncTuningState.transcriptFlashListEstimatedItemSize = 120;
        chainSyncTuningState.transcriptBackwardPrefetchThresholdPx = 800;
        chainSyncTuningState.transcriptOlderLoadCooldownMs = 2500;
        chainSyncTuningState.transcriptMaxTurnEntriesPerListItem = 8;
    });

    it('throttles web FlashList scroll events above one frame to reduce scroll-render churn', async () => {
        const { Platform } = await import('react-native');
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        try {
            scrollToIndexShouldReject = false;
            const screen = await renderChainTranscriptList({
                sessionId: 's1',
                messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
                metadata: null,
                interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            });

            const list = screen.findByType('FlashList' as any);
            expect(list.props.scrollEventThrottle).toBe(32);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
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
        const initialScrollToIndexSpy = scrollToIndexSpy;
        if (!initialScrollToIndexSpy) {
            throw new Error('Expected FlashList ref to provide scrollToIndex');
        }

        await act(async () => {
            invokeTestInstanceHandler(list, 'onLayout', { nativeEvent: { layout: { height: 300 } } });
            list.props.onContentSizeChange(0, 600);
            await settleListEffects();
        });

        expect(initialScrollToIndexSpy).toHaveBeenCalledWith(
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
        const initialScrollToIndexSpy = scrollToIndexSpy;
        const initialScrollToOffsetSpy = scrollToOffsetSpy;
        if (!initialScrollToIndexSpy) {
            throw new Error('Expected FlashList ref to provide scrollToIndex');
        }
        if (!initialScrollToOffsetSpy) {
            throw new Error('Expected FlashList ref to provide scrollToOffset');
        }

        await act(async () => {
            invokeTestInstanceHandler(list, 'onLayout', { nativeEvent: { layout: { height: 300 } } });
            list.props.onContentSizeChange(0, 600);
            await settleListEffects(2);
        });

        expect(initialScrollToIndexSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                index: 0,
                animated: false,
                viewPosition: 1,
            }),
        );
        const scrollToOffsetCalls = [
            ...initialScrollToOffsetSpy.mock.calls,
            ...(scrollToOffsetSpy && scrollToOffsetSpy !== initialScrollToOffsetSpy ? scrollToOffsetSpy.mock.calls : []),
        ];
        expect(scrollToOffsetCalls).toEqual(expect.arrayContaining([
            [expect.objectContaining({
                offset: 0,
                animated: false,
            })],
        ]));
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
                    contentOffset: { y: 100 },
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 500 },
                },
            });
            list.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 100 },
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 500 },
                },
            });
            await settleListEffects();
        });

        expect(loadOlder).toHaveBeenCalledTimes(1);
        // Invariant H: the older-load indicator is visible while the user-triggered load is in flight…
        expect(screen.root.findAllByProps({ testID: 'transcript-older-load-progress-overlay' }).length).toBeGreaterThan(0);
        await act(async () => {
            deferred.resolve({ loaded: 1, hasMore: true, status: 'loaded' });
            await settleListEffects();
        });
        // …and settles once the load resolves.
        expect(screen.root.findAllByProps({ testID: 'transcript-older-load-progress-overlay' }).length).toBe(0);
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
                    contentOffset: { y: 100 },
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
            list.props.onScroll({ nativeEvent: { contentOffset: { y: 100 } } });
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

    it('requires a threshold exit and re-entry before chaining another older-page load (anti-burst)', async () => {
        vi.useFakeTimers({ now: new Date(0) });
        try {
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
            const scrollTo = async (y: number) => {
                await act(async () => {
                    list.props.onScroll({
                        nativeEvent: {
                            contentOffset: { y },
                            contentSize: { height: 1000 },
                            layoutMeasurement: { height: 500 },
                        },
                    });
                    await settleListEffects();
                });
            };
            await act(async () => {
                invokeTestInstanceHandler(list, 'onLayout', { nativeEvent: { layout: { height: 500 } } });
                list.props.onContentSizeChange(0, 1000);
                await settleListEffects();
            });

            await scrollTo(100);
            expect(loadOlder).toHaveBeenCalledTimes(1);

            // Parked inside the threshold: cooldown elapsing alone never re-arms (E6 anti-burst).
            await act(async () => {
                await vi.advanceTimersByTimeAsync(5000);
            });
            await scrollTo(120);
            expect(loadOlder).toHaveBeenCalledTimes(1);

            // An observed threshold exit -> re-enter re-arms the machine for exactly one more load.
            await scrollTo(900);
            await scrollTo(100);
            expect(loadOlder).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('re-arms during cooldown only after an observed threshold exit and re-entry', async () => {
        vi.useFakeTimers({ now: new Date(0) });
        try {
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
            const scrollTo = async (y: number) => {
                await act(async () => {
                    list.props.onScroll({
                        nativeEvent: {
                            contentOffset: { y },
                            contentSize: { height: 1000 },
                            layoutMeasurement: { height: 500 },
                        },
                    });
                    await settleListEffects();
                });
            };
            await act(async () => {
                invokeTestInstanceHandler(list, 'onLayout', { nativeEvent: { layout: { height: 500 } } });
                list.props.onContentSizeChange(0, 1000);
                await settleListEffects();
            });

            await scrollTo(100);
            expect(loadOlder).toHaveBeenCalledTimes(1);

            // Exit -> re-enter while the cooldown is still running: no immediate load…
            await scrollTo(900);
            await scrollTo(100);
            expect(loadOlder).toHaveBeenCalledTimes(1);

            // …but the re-arm is honored when the cooldown elapses.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2500);
            });
            expect(loadOlder).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('uses configured backward prefetch pixels for near-top loading', async () => {
        chainSyncTuningState.transcriptBackwardPrefetchThresholdPx = 400;
        scrollToIndexShouldReject = false;
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        const loadOlder = vi.fn(async () => ({ loaded: 1, hasMore: true, status: 'loaded' as const }));

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
        await act(async () => {
            invokeTestInstanceHandler(list, 'onLayout', { nativeEvent: { layout: { height: 500 } } });
            list.props.onContentSizeChange(0, 1000);
            list.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 350 },
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 500 },
                },
            });
            await settleListEffects();
        });

        expect(loadOlder).toHaveBeenCalledTimes(1);
    });

    it('derives the start-reached threshold from the configured pixel distance', async () => {
        chainSyncTuningState.transcriptBackwardPrefetchThresholdPx = 250;
        scrollToIndexShouldReject = false;
        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            loadOlder: vi.fn(async () => ({ loaded: 1, hasMore: true, status: 'loaded' as const })),
        });

        const list = getFlashList(screen);
        expect(list.props.onStartReachedThreshold).toBe(0.2);

        await act(async () => {
            invokeTestInstanceHandler(list, 'onLayout', { nativeEvent: { layout: { height: 500 } } });
            await settleListEffects();
        });

        expect(getFlashList(screen).props.onStartReachedThreshold).toBe(0.5);
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

    it('does not let onStartReached bypass the pinned short-transcript guard', async () => {
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
            list.props.onContentSizeChange(0, 400);
            list.props.onStartReached();
            await settleListEffects();
        });

        expect(loadOlder).not.toHaveBeenCalled();
    });

    it('suspends older loads while the observed offset is at or below zero', async () => {
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
            list.props.onContentSizeChange(0, 1000);
            list.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 0 },
                    contentSize: { height: 1000 },
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
