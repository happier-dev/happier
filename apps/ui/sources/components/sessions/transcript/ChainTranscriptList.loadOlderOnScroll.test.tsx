import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import {
    createDeferred,
    findSidechainTranscriptRenderer,
    flushHookEffects,
    renderScreen,
    SIDECHAIN_TRANSCRIPT_RENDERER_AXES,
    standardCleanup,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type ChainTranscriptLoadResult = Awaited<ReturnType<NonNullable<
    React.ComponentProps<typeof import('./ChainTranscriptList')['ChainTranscriptList']>['loadOlder']
>>>;

const syncTuningState = vi.hoisted(() => ({
    transcriptEstimatedItemSizePx: 120,
    transcriptBackwardPrefetchThresholdPx: 800,
    transcriptBackwardPrefetchThresholdItems: 12,
    transcriptOlderLoadCooldownMs: 2500,
    transcriptOlderLoadSpinnerDelayMs: 0,
}));

const legendState = vi.hoisted(() => ({
    current: {} as Record<string, unknown>,
}));

const legendChildLayoutState = vi.hoisted(() => ({
    emissionCount: 0,
    emitForItemCount: null as number | null,
    props: null as Readonly<{
        data?: readonly unknown[];
        onStartReached?: (info: Readonly<{ distanceFromStart: number }>) => void;
    }> | null,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        getSyncTuning: () => syncTuningState,
    },
}));

let catchingUpNewerState = false;
vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/store/hooks')>();
    return {
        ...actual,
        useSessionCatchingUpNewer: () => catchingUpNewerState,
    };
});

vi.mock('@/components/sessions/transcript/MessageView', () => ({
    MessageView: (props: any) => React.createElement('MessageView', props),
    MessageViewWithSessionCommon: (props: any) => React.createElement('MessageViewWithSessionCommon', props),
}));

vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    const captured = createCapturingLegendListMock({
        resolveState: () => legendState.current,
    }).module;
    const CapturingLegendList = captured.LegendList;
    const LegendList = React.forwardRef<any, any>((props, ref) => {
        legendChildLayoutState.props = props;
        return React.createElement(CapturingLegendList, { ...props, ref });
    });
    return { LegendList };
});

function LegendChildLayoutCallbackProbe() {
    React.useLayoutEffect(() => {
        const props = legendChildLayoutState.props;
        if (legendChildLayoutState.emitForItemCount !== props?.data?.length) return;
        legendChildLayoutState.emitForItemCount = null;
        legendChildLayoutState.emissionCount += 1;
        props.onStartReached?.({ distanceFromStart: 0 });
    });
    return null;
}

describe('ChainTranscriptList', () => {
    type ChainTranscriptListTestProps =
        Omit<React.ComponentProps<typeof import('./ChainTranscriptList')['ChainTranscriptList']>, 'datasetKey'>
        & { datasetKey?: string };

    async function renderChainTranscriptList(props: ChainTranscriptListTestProps) {
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        return renderScreen(React.createElement(ChainTranscriptList, {
            ...props,
            datasetKey: props.datasetKey ?? JSON.stringify([props.sessionId, 'test-sidechain']),
        }));
    }

    function getLegendList(screen: Awaited<ReturnType<typeof renderChainTranscriptList>>) {
        return screen.findByType('LegendList' as any);
    }

    /** Fires the Legend identity-host View onLayout (the shell onLayout seam under Legend). */
    function fireShellLayout(
        screen: Awaited<ReturnType<typeof renderChainTranscriptList>>,
        height: number,
    ) {
        let node: any = getLegendList(screen).parent;
        while (node && node.type !== 'View') node = node.parent;
        node?.props.onLayout?.({ nativeEvent: { layout: { height } } });
    }

    /** Seeds Legend mock geometry and fires the adapter's synthesized content-size emit. */
    function setShellContentHeight(
        list: { props: Record<string, any> },
        contentHeight: number,
        layoutHeight = 500,
    ) {
        legendState.current = {
            ...legendState.current,
            contentLength: contentHeight,
            scrollLength: layoutHeight,
        };
        list.props.onLoad?.({ elapsedTimeInMs: 0 });
    }

    async function settleListEffects(turns = 1) {
        await flushHookEffects({ cycles: 1, turns });
    }

    const STANDARD_LAYOUT_HEIGHT = 500;
    const STANDARD_CONTENT_HEIGHT = 2000;

    function standardScrollEvent(offsetFromOlderEdge: number) {
        return {
            nativeEvent: {
                contentOffset: { y: Math.max(0, Math.trunc(offsetFromOlderEdge)) },
                contentSize: { height: STANDARD_CONTENT_HEIGHT },
                layoutMeasurement: { height: STANDARD_LAYOUT_HEIGHT },
            },
        };
    }

    afterEach(() => {
        Object.assign(syncTuningState, {
            transcriptEstimatedItemSizePx: 120,
            transcriptBackwardPrefetchThresholdPx: 800,
            transcriptBackwardPrefetchThresholdItems: 12,
            transcriptOlderLoadCooldownMs: 2500,
            transcriptOlderLoadSpinnerDelayMs: 0,
        });
        catchingUpNewerState = false;
        legendState.current = {};
        Object.assign(legendChildLayoutState, {
            emissionCount: 0,
            emitForItemCount: null,
            props: null,
        });
        standardCleanup();
    });

    describe.each(SIDECHAIN_TRANSCRIPT_RENDERER_AXES)('$id renderer axis', (axis) => {
        it('composes the requested renderer with truthful chronological data order', async () => {
            const { Platform } = await import('react-native');
            const originalPlatform = Platform.OS;
            Object.defineProperty(Platform, 'OS', { configurable: true, value: axis.platformOS });
            try {
                const screen = await renderChainTranscriptList({
                    sessionId: 'renderer-axis',
                    messages: [
                        { kind: 'user-text', id: 'oldest', localId: null, createdAt: 1, text: 'first' },
                        { kind: 'agent-text', id: 'newest', localId: null, createdAt: 2, text: 'second', isThinking: false },
                    ],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                });

                const list = findSidechainTranscriptRenderer(screen, axis);
                const renderedIds = list.props.data.map((item: { id: string }) => item.id);
                expect(renderedIds).toEqual(
                    axis.expectedDataOrder === 'oldest-first'
                        ? ['msg:oldest', 'msg:newest']
                        : ['msg:newest', 'msg:oldest'],
                );
            } finally {
                Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
            }
        });
    });

    it('lets dataset B load while A is pending and ignores A exhaustion after the switch', async () => {
        syncTuningState.transcriptOlderLoadCooldownMs = 0;
        const pendingLoads: Array<ReturnType<typeof createDeferred<ChainTranscriptLoadResult>>> = [];
        const loadOlder = vi.fn(() => {
            const deferred = createDeferred<ChainTranscriptLoadResult>();
            pendingLoads.push(deferred);
            return deferred.promise;
        });
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        const baseProps = {
            sessionId: 'dataset-pagination',
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            loadOlder,
        } as const;
        const renderDataset = (sidechainId: string) => React.createElement(ChainTranscriptList, {
            ...baseProps,
            datasetKey: JSON.stringify(['dataset-pagination', sidechainId]),
            messages: [{
                kind: 'agent-text' as const,
                id: `${sidechainId}-message`,
                localId: null,
                createdAt: 1,
                text: sidechainId,
                isThinking: false,
            }],
        });
        const triggerOlderEdgeObservation = async (
            screen: Awaited<ReturnType<typeof renderChainTranscriptList>>,
            offsetY: number,
        ) => {
            const list = getLegendList(screen);
            await act(async () => {
                fireShellLayout(screen, STANDARD_LAYOUT_HEIGHT);
                setShellContentHeight(list, STANDARD_CONTENT_HEIGHT);
                list.props.onScroll(standardScrollEvent(offsetY));
                await settleListEffects();
            });
        };

        const screen = await renderScreen(renderDataset('sidechain-a'));
        await triggerOlderEdgeObservation(screen, 120);
        expect(loadOlder).toHaveBeenCalledTimes(1);

        await screen.update(renderDataset('sidechain-b'));
        await triggerOlderEdgeObservation(screen, 120);
        expect(loadOlder).toHaveBeenCalledTimes(2);

        // B records a fresh exit/re-entry while its own load remains active.
        await triggerOlderEdgeObservation(screen, 900);
        await triggerOlderEdgeObservation(screen, 120);

        await act(async () => {
            pendingLoads[0]?.resolve({ loaded: 0, hasMore: false, status: 'no_more' });
            await settleListEffects();
        });
        expect(screen.root.findAllByProps({ testID: 'transcript-older-load-progress-overlay' }).length).toBeGreaterThan(0);

        await act(async () => {
            pendingLoads[1]?.resolve({ loaded: 1, hasMore: true, status: 'loaded' });
            await settleListEffects();
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            await settleListEffects();
        });
        expect(loadOlder).toHaveBeenCalledTimes(3);

        await act(async () => {
            pendingLoads[2]?.resolve({ loaded: 1, hasMore: true, status: 'loaded' });
            await settleListEffects();
        });
    });

    it('uses native Legend visible canonical item proximity when estimated pixel geometry is far away', async () => {
        const { Platform } = await import('react-native');
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        syncTuningState.transcriptBackwardPrefetchThresholdPx = 40;
        syncTuningState.transcriptBackwardPrefetchThresholdItems = 2;
        syncTuningState.transcriptOlderLoadCooldownMs = 0;
        const loadOlder = vi.fn(async () => ({ loaded: 1, hasMore: true, status: 'loaded' as const }));
        const messages = Array.from({ length: 12 }, (_, index) => ({
            kind: 'agent-text' as const,
            id: `message-${index}`,
            localId: null,
            createdAt: index,
            text: `message ${index}`,
            isThinking: false,
        }));

        try {
            const screen = await renderChainTranscriptList({
                sessionId: 'native-legend-item-proximity',
                messages,
                metadata: null,
                interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                loadOlder,
            });
            const list = getLegendList(screen);
            const scrollAtEstimateFarGeometry = () => list.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 8_000 },
                    contentSize: { height: 10_000 },
                    layoutMeasurement: { height: 500 },
                },
            });

            await act(async () => {
                fireShellLayout(screen, 500);
                setShellContentHeight(list, 10_000);
                legendState.current = { ...legendState.current, start: 7, end: 9 };
                scrollAtEstimateFarGeometry();
                await settleListEffects(2);
            });
            expect(loadOlder).not.toHaveBeenCalled();

            await act(async () => {
                legendState.current = { ...legendState.current, start: 1, end: 3 };
                scrollAtEstimateFarGeometry();
                await settleListEffects(3);
            });
            expect(loadOlder).toHaveBeenCalledTimes(1);

            await act(async () => {
                legendState.current = { ...legendState.current, start: 7, end: 9 };
                scrollAtEstimateFarGeometry();
                legendState.current = { ...legendState.current, start: 1, end: 3 };
                scrollAtEstimateFarGeometry();
                await settleListEffects(3);
            });
            expect(loadOlder).toHaveBeenCalledTimes(2);

            await act(async () => {
                scrollAtEstimateFarGeometry();
                await settleListEffects(2);
            });
            expect(loadOlder).toHaveBeenCalledTimes(2);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('publishes same-dataset item geometry before the Legend child layout callback', async () => {
        const { Platform } = await import('react-native');
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        syncTuningState.transcriptBackwardPrefetchThresholdPx = 40;
        syncTuningState.transcriptBackwardPrefetchThresholdItems = 2;
        syncTuningState.transcriptOlderLoadCooldownMs = 0;
        const loadOlder = vi.fn(async () => ({ loaded: 1, hasMore: true, status: 'loaded' as const }));
        const createMessages = (count: number) => Array.from({ length: count }, (_, index) => ({
            kind: 'agent-text' as const,
            id: `message-${index}`,
            localId: null,
            createdAt: index,
            text: `message ${index}`,
            isThinking: false,
        }));
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        const baseProps = {
            sessionId: 'same-dataset-child-layout',
            datasetKey: JSON.stringify(['same-dataset-child-layout', 'sidechain-a']),
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            loadOlder,
        } as const;

        try {
            const screen = await renderScreen(React.createElement(React.Fragment, null,
                React.createElement(ChainTranscriptList, {
                    ...baseProps,
                    messages: createMessages(4),
                }),
                React.createElement(LegendChildLayoutCallbackProbe),
            ));
            const list = getLegendList(screen);

            await act(async () => {
                fireShellLayout(screen, 500);
                setShellContentHeight(list, 10_000);
                legendState.current = { ...legendState.current, start: 0, end: 3 };
                legendChildLayoutState.emitForItemCount = 12;
                await screen.update(React.createElement(React.Fragment, null,
                    React.createElement(ChainTranscriptList, {
                        ...baseProps,
                        messages: createMessages(12),
                    }),
                    React.createElement(LegendChildLayoutCallbackProbe),
                ));
                await settleListEffects(3);
            });

            expect(legendChildLayoutState.emissionCount).toBe(1);
            expect(loadOlder).toHaveBeenCalledTimes(1);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('throttles web scroll events above one frame to reduce scroll-render churn', async () => {
        const { Platform } = await import('react-native');
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        try {
            const screen = await renderChainTranscriptList({
                sessionId: 's1',
                messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
                metadata: null,
                interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            });

            const list = getLegendList(screen);
            expect(list.props.scrollEventThrottle).toBe(32);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('does not call loadOlder more than once while a load is in flight', async () => {
                const { ChainTranscriptList } = await import('./ChainTranscriptList');
        const deferred = createDeferred<ChainTranscriptLoadResult>();
        const loadOlder = vi.fn(async () => await deferred.promise);

        const screen = await renderScreen(
            React.createElement(ChainTranscriptList, {
                sessionId: 's1',
                datasetKey: JSON.stringify(['s1', 'test-sidechain']),
                messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
                metadata: null,
                interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                loadOlder,
            }),
        );

        const list = getLegendList(screen);
        expect(typeof list.props.onScroll).toBe('function');

        await act(async () => {
            fireShellLayout(screen, 500);
            setShellContentHeight(list, 1000);
            list.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 120 },
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
            deferred.resolve({ loaded: 0, hasMore: false, status: 'no_more' });
            await settleListEffects();
        });
        // …and settles once the load resolves.
        expect(screen.root.findAllByProps({ testID: 'transcript-older-load-progress-overlay' }).length).toBe(0);
    });

    it('loads older when scrolled near the top (even if onStartReached is not fired)', async () => {
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

        const list = getLegendList(screen);
        expect(typeof list.props.onScroll).toBe('function');

        await act(async () => {
            fireShellLayout(screen, 500);
            setShellContentHeight(list, 1000);
            list.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 120 },
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

    it('requires a threshold exit and re-entry before chaining another older-page load (anti-burst)', async () => {
        vi.useFakeTimers({ now: new Date(0) });
        try {
                        const loadOlder = vi.fn(async () => ({ loaded: 1, hasMore: true, status: 'loaded' as const }));

            const screen = await renderChainTranscriptList({
                sessionId: 's1',
                messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
                metadata: null,
                interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                loadOlder,
            });

            const list = getLegendList(screen);
            const scrollTo = async (y: number) => {
                await act(async () => {
                    list.props.onScroll(standardScrollEvent(y));
                    await settleListEffects();
                });
            };
            await act(async () => {
                fireShellLayout(screen, STANDARD_LAYOUT_HEIGHT);
                setShellContentHeight(list, STANDARD_CONTENT_HEIGHT);
                await settleListEffects();
            });

            await scrollTo(120);
            expect(loadOlder).toHaveBeenCalledTimes(1);

            // Parked inside the threshold: cooldown elapsing alone never re-arms (E6 anti-burst).
            await act(async () => {
                await vi.advanceTimersByTimeAsync(5000);
            });
            await scrollTo(160);
            expect(loadOlder).toHaveBeenCalledTimes(1);

            // An observed threshold exit -> re-enter re-arms the machine for exactly one more load.
            await scrollTo(900);
            await scrollTo(120);
            expect(loadOlder).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('re-arms during cooldown only after an observed threshold exit and re-entry', async () => {
        vi.useFakeTimers({ now: new Date(0) });
        try {
                        const loadOlder = vi.fn(async () => ({ loaded: 1, hasMore: true, status: 'loaded' as const }));

            const screen = await renderChainTranscriptList({
                sessionId: 's1',
                messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
                metadata: null,
                interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                loadOlder,
            });

            const list = getLegendList(screen);
            const scrollTo = async (y: number) => {
                await act(async () => {
                    list.props.onScroll(standardScrollEvent(y));
                    await settleListEffects();
                });
            };
            await act(async () => {
                fireShellLayout(screen, STANDARD_LAYOUT_HEIGHT);
                setShellContentHeight(list, STANDARD_CONTENT_HEIGHT);
                await settleListEffects();
            });

            await scrollTo(120);
            expect(loadOlder).toHaveBeenCalledTimes(1);

            // Exit -> re-enter while the cooldown is still running: no immediate load…
            await scrollTo(900);
            await scrollTo(120);
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
    it('does not load older before the configured top prefetch distance', async () => {
        Object.assign(syncTuningState, {
            transcriptBackwardPrefetchThresholdPx: 40,
        });
                const loadOlder = vi.fn(async () => ({ loaded: 1, hasMore: true, status: 'loaded' as const }));

        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            loadOlder,
        });

        const list = getLegendList(screen);
        await act(async () => {
            fireShellLayout(screen, 500);
            setShellContentHeight(list, 1000);
            list.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 60 },
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 500 },
                },
            });
            await settleListEffects();
        });

        expect(loadOlder).not.toHaveBeenCalled();
    });

    it('derives the start-reached threshold from the configured pixel distance', async () => {
        Object.assign(syncTuningState, {
            transcriptBackwardPrefetchThresholdPx: 250,
        });

        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            loadOlder: vi.fn(async () => ({ loaded: 1, hasMore: true, status: 'loaded' as const })),
        });

        const list = getLegendList(screen);
        await act(async () => {
            fireShellLayout(screen, 500);
            await settleListEffects();
        });

        expect(getLegendList(screen).props.onStartReachedThreshold).toBe(0.5);
    });

    it('loads older on web-like scroll events where layout/content sizes are not present', async () => {
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

        const list = getLegendList(screen);
        expect(typeof list.props.onScroll).toBe('function');

        await act(async () => {
            fireShellLayout(screen, 500);
            setShellContentHeight(list, 1000);
            list.props.onScroll({ nativeEvent: { contentOffset: { y: 120 } } });
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

    it('loads older from an exact web edge using the genuine-top scroll frame', async () => {
        const { Platform } = await import('react-native');
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        try {
                        const deferred = createDeferred<{ loaded: number; hasMore: boolean; status: 'loaded' }>();
            const loadOlder = vi.fn(async () => await deferred.promise);
            const webScroller = {
                scrollTop: 0,
                scrollHeight: 1000,
                clientHeight: 500,
            };

            const screen = await renderChainTranscriptList({
                sessionId: 's1',
                messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
                metadata: null,
                interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                loadOlder,
            });

            const list = getLegendList(screen);
            await act(async () => {
                fireShellLayout(screen, 500);
                setShellContentHeight(list, 500);
                // The genuine-top web scroll frame (scrollTop 0) is now classified 'edge-reached', so it
                // loads directly — one step earlier than the redundant `onStartReached` nudge below.
                list.props.onScroll({ nativeEvent: { contentOffset: { y: webScroller.scrollTop }, target: webScroller } });
                await settleListEffects();
            });
            expect(loadOlder).toHaveBeenCalledTimes(1);

            // The redundant edge callback does not double-load while the first load is in flight.
            await act(async () => {
                list.props.onStartReached();
                await settleListEffects();
            });
            expect(loadOlder).toHaveBeenCalledTimes(1);
            const loadOlderPromise = loadOlder.mock.results[0]?.value as Promise<unknown> | undefined;
            await act(async () => {
                deferred.resolve({ loaded: 1, hasMore: true, status: 'loaded' });
                if (loadOlderPromise) {
                    await loadOlderPromise;
                }
                await settleListEffects();
            });
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('re-arms a parked-inside web viewport from a genuine-top frame after cooldown (edge-reached classification)', async () => {
        // Sidechain twin of the main ChatList genuine-top closer
        // (ChatList.flashListV2.test.tsx "re-arms a parked-inside web viewport from a genuine-top
        // frame after cooldown"). A continuous web DOM-scroll parked inside the threshold (a tall top
        // row keeps the offset off zero) must re-arm an older-load when the genuine top (scrollTop 0)
        // is finally reached, even though `onStartReached` never fires — proving the fix is
        // independent of the top row's kind/height.
        const { Platform } = await import('react-native');
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        vi.useFakeTimers({ now: new Date(0) });
        try {
            const loadOlder = vi.fn(async () => ({ loaded: 1, hasMore: true, status: 'loaded' as const }));
            const { ChainTranscriptList } = await import('./ChainTranscriptList');
            const renderProjection = (messageCount: number) => React.createElement(ChainTranscriptList, {
                sessionId: 's1',
                datasetKey: JSON.stringify(['s1', 'test-sidechain']),
                messages: Array.from({ length: messageCount }, (_, index) => ({
                    kind: 'agent-text' as const,
                    id: `m${4 - messageCount + index}`,
                    localId: null,
                    createdAt: 4 - messageCount + index,
                    text: `message ${4 - messageCount + index}`,
                    isThinking: false,
                })),
                metadata: null,
                interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                loadOlder,
            });
            // A tall content surface so the viewport can park inside the threshold without being at
            // the genuine top (scrollHeight - clientHeight = 1500px of scroll runway).
            const scrollEl = {
                scrollTop: 100,
                scrollHeight: 2000,
                clientHeight: 500,
            };

            const screen = await renderScreen(renderProjection(1));

            const list = getLegendList(screen);
            const scrollTo = async (scrollTop: number) => {
                scrollEl.scrollTop = scrollTop;
                await act(async () => {
                    list.props.onScroll({ nativeEvent: { contentOffset: { y: scrollEl.scrollTop }, target: scrollEl }, target: scrollEl });
                    await settleListEffects();
                });
            };

            await act(async () => {
                fireShellLayout(screen, 500);
                setShellContentHeight(list, 2000);
                await settleListEffects();
            });

            // Park inside the threshold (a tall top row keeps the offset off zero): one load fires.
            await scrollTo(100);
            expect(loadOlder).toHaveBeenCalledTimes(1);
            scrollEl.scrollHeight = 2120;
            await screen.update(renderProjection(2));

            // Cooldown elapses while still parked inside, with NO observed threshold exit. A further
            // mid-band scroll must NOT chain another load (anti-burst).
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2500);
            });
            await scrollTo(80);
            expect(loadOlder).toHaveBeenCalledTimes(1);

            // Reaching the genuine top (scrollTop 0) is classified 'edge-reached', which satisfies the
            // machine's exact-edge re-arm and loads exactly one more older page — independent of any
            // threshold exit and of the top row's kind/height.
            await scrollTo(0);
            expect(loadOlder).toHaveBeenCalledTimes(2);

            // The positive page result must be paired with its real projection commit. MVCP settles
            // that projection off the exact edge, revoking the transient exact-edge commit before
            // cooldown; a later mid-band frame therefore cannot widen the re-arm band.
            scrollEl.scrollTop = 120;
            scrollEl.scrollHeight = 2240;
            await screen.update(renderProjection(3));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2500);
            });
            await scrollTo(120);
            expect(loadOlder).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('re-arms a parked-inside web viewport from a near-top fractional frame after cooldown (EPSILON classification)', async () => {
        // Sidechain twin of the main ChatList EPSILON closer. The web scroll element reports
        // `scrollTop` as an integer-rounded (dpr=1) or sub-pixel-residue (Retina) value, so a viewport
        // resting at the genuine top is rarely EXACTLY 0 — it commonly settles at ~1. The near-top
        // frame must still classify 'edge-reached' (genuine-top epsilon) and re-arm an older-load.
        const { Platform } = await import('react-native');
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        vi.useFakeTimers({ now: new Date(0) });
        try {
            const loadOlder = vi.fn(async () => ({ loaded: 1, hasMore: true, status: 'loaded' as const }));
            const { ChainTranscriptList } = await import('./ChainTranscriptList');
            const renderProjection = (messageCount: number) => React.createElement(ChainTranscriptList, {
                sessionId: 's1',
                datasetKey: JSON.stringify(['s1', 'test-sidechain']),
                messages: Array.from({ length: messageCount }, (_, index) => ({
                    kind: 'agent-text' as const,
                    id: `m${4 - messageCount + index}`,
                    localId: null,
                    createdAt: 4 - messageCount + index,
                    text: `message ${4 - messageCount + index}`,
                    isThinking: false,
                })),
                metadata: null,
                interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                loadOlder,
            });
            const scrollEl = {
                scrollTop: 100,
                scrollHeight: 2000,
                clientHeight: 500,
            };

            const screen = await renderScreen(renderProjection(1));

            const list = getLegendList(screen);
            const scrollTo = async (scrollTop: number) => {
                scrollEl.scrollTop = scrollTop;
                await act(async () => {
                    list.props.onScroll({ nativeEvent: { contentOffset: { y: scrollEl.scrollTop }, target: scrollEl }, target: scrollEl });
                    await settleListEffects();
                });
            };

            await act(async () => {
                fireShellLayout(screen, 500);
                setShellContentHeight(list, 2000);
                await settleListEffects();
            });

            // Park inside the threshold: one load fires.
            await scrollTo(100);
            expect(loadOlder).toHaveBeenCalledTimes(1);
            scrollEl.scrollHeight = 2120;
            await screen.update(renderProjection(2));

            // Cooldown elapses while still parked inside, with NO observed threshold exit.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2500);
            });
            await scrollTo(80);
            expect(loadOlder).toHaveBeenCalledTimes(1);

            // Reaching the genuine top reports a near-top fractional scrollTop (1), NOT exactly 0. The
            // EPSILON classifier marks it 'edge-reached', re-arming the machine and loading one more.
            await scrollTo(1);
            expect(loadOlder).toHaveBeenCalledTimes(2);

            // Commit the positive page with settled DOM geometry outside the exact-edge epsilon.
            // The subsequent frame proves the fractional edge classification did not widen the band.
            scrollEl.scrollTop = 120;
            scrollEl.scrollHeight = 2240;
            await screen.update(renderProjection(3));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2500);
            });
            await scrollTo(120);
            expect(loadOlder).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('renders the catch-up overlay while sync is catching this session up to newer activity', async () => {
        // §13 wiring: the sidechain is non-inverted with no live-tail pinned-following composer, so the
        // overlay shows whenever the per-session catch-up signal is in flight (no pinned gate, inset 0).
        catchingUpNewerState = true;
        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            loadOlder: vi.fn(async () => ({ loaded: 0, hasMore: false, status: 'no_more' as const })),
        });

        expect(screen.findByTestId('transcript-catch-up-progress-overlay')).toBeTruthy();
    });

    it('does not render the catch-up overlay when the session is not catching up', async () => {
        catchingUpNewerState = false;
        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            loadOlder: vi.fn(async () => ({ loaded: 0, hasMore: false, status: 'no_more' as const })),
        });

        expect(screen.findByTestId('transcript-catch-up-progress-overlay')).toBeNull();
    });

    it('does not load older while pinned at the bottom of a short transcript', async () => {
                const loadOlder = vi.fn(async () => ({ loaded: 1, hasMore: true, status: 'loaded' as const }));

        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            loadOlder,
        });

        const list = getLegendList(screen);
        await act(async () => {
            fireShellLayout(screen, 500);
            setShellContentHeight(list, 600);
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

    it('does not let the rendered older edge bypass the pinned short-transcript guard', async () => {
                const loadOlder = vi.fn(async () => ({ loaded: 1, hasMore: true, status: 'loaded' as const }));

        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            loadOlder,
        });

        const list = getLegendList(screen);
        await act(async () => {
            fireShellLayout(screen, 500);
            setShellContentHeight(list, 400);
            list.props.onEndReached();
            await settleListEffects();
        });

        expect(loadOlder).not.toHaveBeenCalled();
    });

    it('suspends older loads while the observed offset is at or below zero', async () => {
                const loadOlder = vi.fn(async () => ({ loaded: 1, hasMore: true, status: 'loaded' as const }));

        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            loadOlder,
        });

        const list = getLegendList(screen);
        await act(async () => {
            fireShellLayout(screen, 500);
            setShellContentHeight(list, 1000);
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
});
