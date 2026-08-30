// @vitest-environment jsdom

/**
 * Identity-stability contract for the M6 scroll observation host.
 *
 * The host receives a fresh deps object from ChatList during normal renders. Returned shell
 * callbacks and interaction props must stay stable when the individual dependency fields are
 * unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import { createTranscriptLifecycleHost } from '@/components/sessions/transcript/viewport/lifecycle/lifecycleHost';
import { createSessionOpenLatch } from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';
import { sync } from '@/sync/sync';

import { useTranscriptScrollObservationHost } from './useTranscriptScrollObservationHost';

type ScrollObservationHostDeps = Parameters<typeof useTranscriptScrollObservationHost>[0];
type TargetWindowState = NonNullable<ScrollObservationHostDeps['targetWindowHostFacts']['activeWindowState']>;
type TargetWindowLoadResult = Awaited<ReturnType<typeof sync.loadTargetWindowMessages>>;

function createRef<T>(current: T): { current: T } {
    return { current };
}

function createScrollElement(): HTMLElement {
    // DOM system-boundary fixture: the host reads only these scroll metrics.
    return {
        clientHeight: 600,
        scrollHeight: 1200,
        scrollTop: 600,
    } as unknown as HTMLElement;
}

function createStableMembers() {
    const lifecycleHost = createTranscriptLifecycleHost();
    return {
        activeTargetWindowTargetRef: createRef<ScrollObservationHostDeps['activeTargetWindowTargetRef']['current']>(null),
        applyBlankRecoveryEffects: vi.fn(),
        applyEntryRestoreOwnerEffects: vi.fn(),
        applyNativeBottomFollowCompletionHostEffects: vi.fn(),
        applyNativeDragActiveMirrorEffectsRef: createRef(() => {}),
        applyNativeMountSettlePassiveDriftRepinObservation: vi.fn(),
        applyNativeUserScrollTakeoverHostEffects: vi.fn(),
        applyWebPassiveLiveTailCorrectionEffectRef: createRef(() => false),
        webDomObservation: createWebDomScrollObservation(),
        bottomFollowModeStateRef: createRef({ dragSession: null, mode: 'following' }),
        cancelScheduledPinToBottom: vi.fn(),
        captureNativeBottomFollowPreviousFollow: vi.fn(() => false),
        captureWebBottomFollowPreviousMetrics: vi.fn(() => null),
        commitBottomFollowModeState: vi.fn(),
        commitJumpToBottomDistanceForVisibility: vi.fn(),
        commitScrollPinEvent: vi.fn(),
        commitScrollPinState: vi.fn(),
        composerInsetHeightRef: createRef(0),
        currentSessionIdRef: createRef('s1'),
        dispatchViewportLifecycleEvent: vi.fn<ScrollObservationHostDeps['dispatchViewportLifecycleEvent']>(() => ({
            effects: [],
            state: lifecycleHost.getState(),
        })),
        emitViewportChange: vi.fn(),
        entryRestoreOwner: {
            hasOpenTransaction: vi.fn(() => false),
            visibleDistanceForOpenNativeEntry: vi.fn(() => null),
        },
        deferViewportAnchorCapture: vi.fn(),
        firstPaintTelemetryRef: createRef({ recorded: true }),
        getBottomFollowGestureActiveRef: createRef(() => false),
        hasNativeContentMeasurementForCurrentSession: vi.fn(() => false),
        hasNativeInitialViewportAppliedForCurrentSession: vi.fn(() => false),
        lastExplicitWebScrollIntentAtMsRef: createRef(Number.NEGATIVE_INFINITY),
        lastNativePinOffsetRef: createRef(null),
        lastPinOffsetForIntentRef: createRef(null),
        lastRouteJumpProtectionClearingWebMovementAtMsRef: createRef(Number.NEGATIVE_INFINITY),
        lastScrollOffsetForIntentRef: createRef(null),
        lastUserScrollIntentAtMsRef: createRef(Number.NEGATIVE_INFINITY),
        lifecycleHost,
        listContentHeightRef: createRef(0),
        listDataRef: createRef([]),
        listLayoutHeightRef: createRef(0),
        listRef: createRef<ScrollObservationHostDeps['listRef']['current']>(null),
        loadOlderInFlightRef: createRef(false),
        markNativeInitialViewportAppliedForCurrentSession: vi.fn(),
        measurementHost: {
            observeContentSizeChange: vi.fn(() => []),
        },
        nativeBottomFollowRearmedAfterDragRef: createRef(false),
        nativeListDragActiveRef: createRef(false),
        nativeMomentumScrollActiveRef: createRef(false),
        nativeMountSettleAutoPinSuppressedRef: createRef(false),
        nativeMountSettleDeadlineReachedRef: createRef(false),
        nativePrependTelemetryStateRef: createRef(() => 'closed'),
        nativeTranscriptTouchStartYRef: createRef(null),
        observeMountSettleMetrics: vi.fn(),
        observeNativeBlankRecovery: vi.fn(),
        observeNativeConfirmation: vi.fn(() => false),
        observeNativeEntryRestoreHostFacts: vi.fn(() => []),
        observeNativePrependOwner: vi.fn(),
        observeWebGenuineScrollMovement: vi.fn(() => ({
            webMovedSinceLastObservation: null,
            webObservedUpwardIntent: false,
            webObservedUserScrollMovement: false,
        })),
        observeWebTranscriptNavigationVisibilityForSession: vi.fn(),
        olderPagination: {
            getSnapshot: vi.fn(() => ({ phase: 'idle', suspendedReasons: [] })),
            isReadyForLoad: vi.fn(() => true),
            isNearOlderEdge: vi.fn((input: { itemsToOlderEdge?: number | null; offsetY: number; scrollable: boolean }) => (
                input.scrollable &&
                (
                    (typeof input.itemsToOlderEdge === 'number' && input.itemsToOlderEdge <= 12) ||
                    input.offsetY <= 400
                )
            )),
            onScrollObservation: vi.fn(),
        },
        pendingJumpSeqViewportPromotionRef: createRef(null),
        pendingNativeMountSettleBottomPinRef: createRef(false),
        pinEnabledRef: createRef(true),
        pinNativeInitialFollowBottomViewportIfReady: vi.fn(),
        pinThresholdPxRef: createRef(72),
        preemptExplicitJumpForUserTakeover: vi.fn(),
        preemptEntryRestoreTransaction: vi.fn(),
        prepareNativeContentMaterializationAutoPin: vi.fn(),
        prependHost: {
            applyNativeEffects: vi.fn(),
            hasOpenNativeTransaction: vi.fn(() => false),
            observeWeb: vi.fn(),
            refreshInFlightWebAnchor: vi.fn(),
            retargetPendingWebAnchorForUserScroll: vi.fn(),
            trustedNativeScroll: vi.fn(() => []),
        },
        promotedJumpSeqViewportProtectionRef: createRef(null),
        promotePendingJumpSeqViewportSnapshot: vi.fn(() => false),
        readCurrentNativeDistanceFromBottom: vi.fn(() => null),
        readItemsToOlderEdge: vi.fn<() => number | null>(() => null),
        readItemsToNewerEdge: vi.fn<() => number | null>(() => null),
        recordFirstListPaint: vi.fn(),
        recordListLayoutWidth: vi.fn(),
        recordNativeVisibleWindowTelemetry: vi.fn(),
        recordScrollObservedTelemetry: vi.fn(),
        recordStablePaintTelemetry: vi.fn(),
        recordViewportTelemetryEvent: vi.fn(),
        resolveEffectiveListPaintMetrics: vi.fn(() => null),
        resolveNativeObservedScrollOffset: vi.fn<ScrollObservationHostDeps['resolveNativeObservedScrollOffset']>(() => null),
        resolveTranscriptMountSettleBottomDistanceNoiseFloorPx: vi.fn(() => null),
        resolveViewportReachedEdge: vi.fn((edge: 'start' | 'end') => edge === 'start' ? 'older' : 'newer'),
        resolveViewportTelemetryMode: vi.fn(() => 'follow-bottom'),
        resolveWebScrollMetrics: vi.fn<() => WebTranscriptScrollMetrics | null>(() => null),
        resolveWebViewportTelemetryDiagnostics: vi.fn(() => ({})),
        requestAutomaticLiveTailPin: vi.fn(),
        runEntryRestoreAttempt: vi.fn(),
        scheduleViewportAnchorCaptureRef: createRef(() => {}),
        scrollPinRef: createRef({ isPinned: true, lastActivityKey: null, newActivityCount: 0 }),
        sessionEntryViewportRef: createRef(null),
        setListContentHeight: vi.fn(),
        setListLayoutHeight: vi.fn(),
        shouldCommitContentHeightState: vi.fn(() => true),
        shouldIgnoreNativeInvalidScrollObservation: vi.fn(() => false),
        shouldSuppressGenericViewportStateForProtectedJumpSeq: vi.fn(() => false),
        targetWindowActiveRef: createRef(false),
        targetWindowEdgeLoadInFlightRef: createRef<'newer' | 'older' | null>(null),
        targetWindowHostFacts: { activeWindowState: null } as ScrollObservationHostDeps['targetWindowHostFacts'],
        updateNativeInitialViewportPendingObservation: vi.fn(),
        updateNativeViewportPaintObserved: vi.fn(),
        verifyNativeSliceEntryRestoreTransaction: vi.fn(),
        viewportCommandController: { activeOwner: vi.fn(() => 'follow') },
        wantsPinnedRef: createRef(true),
        verifyWebEntryRestoreTransaction: vi.fn(),
    };
}

function buildDeps(members: ReturnType<typeof createStableMembers>): ScrollObservationHostDeps {
    return {
        ...members,
        isLoaded: false,
        isWarmKeepAliveInstance: false,
        latestCommittedActivityKey: 'activity-1',
        nativeMountSettleStable: false,
        pinEnabled: true,
        pinThresholdPx: 72,
        platformOS: 'web',
        routeJumpSeq: null,
        sessionActive: true,
        sessionId: 's1',
        showFirstPaintPlaceholder: false,
        userIntentRecentMs: 500,
        usesNativeFlashListBottomMaintenance: true,
    } as unknown as ScrollObservationHostDeps;
}

function targetWindowState(overrides: Partial<TargetWindowState> = {}): TargetWindowState {
    return {
        activatedAtMs: 1,
        hasMoreNewer: false,
        hasMoreOlder: true,
        isWindowMode: true,
        newerCursor: null,
        olderCursor: 40,
        targetSeq: 50,
        windowId: 'window-50',
        windowMaxSeq: 60,
        windowMinSeq: 40,
        ...overrides,
    };
}

function targetWindowLoadResult(
    overrides: Partial<TargetWindowLoadResult> = {},
): TargetWindowLoadResult {
    return {
        appliedSeqs: [],
        hasMoreNewer: false,
        hasMoreOlder: true,
        newerCursor: null,
        olderCursor: 40,
        rawSeqs: [],
        status: 'loaded',
        targetPresent: true,
        targetSeq: 50,
        windowId: 'window-50',
        ...overrides,
    };
}

function activateTargetWindow(
    members: ReturnType<typeof createStableMembers>,
    activeWindowState: TargetWindowState = targetWindowState(),
): void {
    members.targetWindowActiveRef.current = true;
    members.activeTargetWindowTargetRef.current = {
        kind: 'seq',
        seq: activeWindowState.targetSeq ?? 50,
    };
    members.targetWindowHostFacts = { activeWindowState };
}

describe('useTranscriptScrollObservationHost identity stability', () => {
    afterEach(() => {
        document.body.replaceChildren();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('does not attach resize resources when continuous follow belongs to the renderer', async () => {
        const members = createStableMembers();
        const element = createScrollElement();
        members.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element,
            scrollHeight: 1200,
            scrollTop: 600,
        });
        const observe = vi.fn();
        const resizeObserverConstructor = vi.fn(() => ({ disconnect: vi.fn(), observe }));
        vi.stubGlobal('ResizeObserver', resizeObserverConstructor);
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            {
                initialProps: {
                    ...buildDeps(members),
                    continuousFollowOwner: 'renderer',
                },
            },
        );

        expect(resizeObserverConstructor).not.toHaveBeenCalled();
        expect(observe).not.toHaveBeenCalled();
        expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 100);
        expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 250);

        await hook.unmount();
    });

    it('uses one ResizeObserver without retry or polling for app-owned web viewport changes', async () => {
        const members = createStableMembers();
        const element = createScrollElement();
        members.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element,
            scrollHeight: 1200,
            scrollTop: 600,
        });
        const observe = vi.fn();
        const disconnect = vi.fn();
        const notifyResizeRef = { current: () => {} };
        vi.stubGlobal('ResizeObserver', class {
            constructor(callback: () => void) {
                notifyResizeRef.current = callback;
            }
            disconnect = disconnect;
            observe = observe;
        });
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: buildDeps(members) },
        );

        expect(observe).toHaveBeenCalledWith(element);
        expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 100);
        expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 250);
        Object.defineProperty(element, 'clientHeight', { configurable: true, value: 500 });
        notifyResizeRef.current();
        expect(members.requestAutomaticLiveTailPin).toHaveBeenCalledWith(
            expect.objectContaining({ clientHeight: 600, element }),
            'viewport-resized',
            false,
        );

        await hook.unmount();
        expect(disconnect).toHaveBeenCalledOnce();
    });

    it('keeps shell callbacks and interaction props stable across fresh deps object identities', async () => {
        const members = createStableMembers();
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: buildDeps(members) },
        );

        const first = hook.getCurrent();

        await hook.rerender(buildDeps(members));
        await hook.rerender(buildDeps(members));

        const second = hook.getCurrent();
        expect(second.onLayout).toBe(first.onLayout);
        expect(second.onContentSizeChange).toBe(first.onContentSizeChange);
        expect(second.onScroll).toBe(first.onScroll);
        expect(second.platformInteractionProps).toBe(first.platformInteractionProps);
        expect(second.nativeFlashListScrollOverrideProps).toBe(first.nativeFlashListScrollOverrideProps);

        await hook.unmount();
    });

    it('re-evaluates the existing older-pagination owner after a content commit at exact web top', async () => {
        const members = createStableMembers();
        const element = createScrollElement();
        Object.defineProperties(element, {
            scrollTop: { configurable: true, value: 0 },
            scrollHeight: { configurable: true, value: 1200 },
            clientHeight: { configurable: true, value: 600 },
        });
        members.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element,
            scrollHeight: 1200,
            scrollTop: 0,
        });
        members.wantsPinnedRef.current = false;
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(members), isLoaded: true } },
        );

        hook.getCurrent().observeCommittedProjectionLayout();

        expect(members.olderPagination.onScrollObservation).toHaveBeenCalledWith({
            itemsToOlderEdge: null,
            offsetY: 0,
            scrollable: true,
            trigger: 'layout-committed',
        });
        await hook.unmount();
    });

    it.each([
        ['standard', (edge: 'start' | 'end') => edge === 'start' ? 'older' as const : 'newer' as const],
        ['inverted', (edge: 'start' | 'end') => edge === 'start' ? 'newer' as const : 'older' as const],
    ])('re-evaluates canonical older pagination from committed native item-edge facts in %s orientation', async (
        _orientation,
        resolveReachedEdge,
    ) => {
        const members = createStableMembers();
        members.readItemsToOlderEdge.mockReturnValue(0);
        members.listContentHeightRef.current = 1200;
        members.listLayoutHeightRef.current = 600;
        members.listRef.current = {
            getAbsoluteLastScrollOffset: () => 0,
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        members.resolveNativeObservedScrollOffset.mockReturnValue({
            canonicalOffsetY: 0,
            distanceFromLiveTailPx: 600,
        });
        members.wantsPinnedRef.current = false;
        members.bottomFollowModeStateRef.current = { dragSession: null, mode: 'released' };
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(members), isLoaded: true, platformOS: 'ios' } },
        );

        members.resolveViewportReachedEdge.mockImplementation(resolveReachedEdge);
        hook.getCurrent().observeCommittedProjectionLayout();

        expect(members.olderPagination.onScrollObservation).toHaveBeenCalledWith({
            itemsToOlderEdge: 0,
            offsetY: 0,
            scrollable: true,
            trigger: 'layout-committed',
        });
        await hook.unmount();
    });

    it('does not treat an unknown native committed visible range as edge or exit evidence', async () => {
        const members = createStableMembers();
        members.readItemsToOlderEdge.mockReturnValue(null);
        members.listContentHeightRef.current = 1200;
        members.listLayoutHeightRef.current = 600;
        members.listRef.current = {
            getAbsoluteLastScrollOffset: () => 0,
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        members.resolveNativeObservedScrollOffset.mockReturnValue({
            canonicalOffsetY: 0,
            distanceFromLiveTailPx: 600,
        });
        members.wantsPinnedRef.current = false;
        members.bottomFollowModeStateRef.current = { dragSession: null, mode: 'released' };
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(members), isLoaded: true, platformOS: 'ios' } },
        );
        members.olderPagination.onScrollObservation.mockClear();

        hook.getCurrent().observeCommittedProjectionLayout();

        expect(members.olderPagination.onScrollObservation).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('dispatches one captured native committed item-edge fact even if the live reader changes', async () => {
        const members = createStableMembers();
        members.readItemsToOlderEdge
            .mockReturnValueOnce(0)
            .mockReturnValue(null);
        members.listContentHeightRef.current = 1200;
        members.listLayoutHeightRef.current = 600;
        members.listRef.current = {
            getAbsoluteLastScrollOffset: () => 0,
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        members.resolveNativeObservedScrollOffset.mockReturnValue({
            canonicalOffsetY: 0,
            distanceFromLiveTailPx: 600,
        });
        members.wantsPinnedRef.current = false;
        members.bottomFollowModeStateRef.current = { dragSession: null, mode: 'released' };
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(members), isLoaded: true, platformOS: 'ios' } },
        );
        members.olderPagination.onScrollObservation.mockClear();

        hook.getCurrent().observeCommittedProjectionLayout();

        expect(members.olderPagination.onScrollObservation).toHaveBeenCalledWith({
            itemsToOlderEdge: 0,
            offsetY: 0,
            scrollable: true,
            trigger: 'layout-committed',
        });
        await hook.unmount();
    });

    it('serializes opposite target-window edge loads through one in-flight owner', async () => {
        const members = createStableMembers();
        members.targetWindowActiveRef.current = true;
        members.activeTargetWindowTargetRef.current = { kind: 'seq', seq: 50 };
        members.targetWindowHostFacts = {
            activeWindowState: {
                activatedAtMs: 1,
                hasMoreNewer: true,
                hasMoreOlder: true,
                isWindowMode: true,
                newerCursor: 60,
                olderCursor: 40,
                targetSeq: 50,
                windowId: 'window-50',
                windowMaxSeq: 60,
                windowMinSeq: 40,
            },
        };
        const loadTargetWindowMessages = vi
            .spyOn(sync, 'loadTargetWindowMessages')
            .mockImplementation(() => new Promise(() => {}));
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(members), isLoaded: true } },
        );

        hook.getCurrent().onStartReached();
        hook.getCurrent().onEndReached();

        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);
        expect(loadTargetWindowMessages).toHaveBeenCalledWith(
            's1',
            { kind: 'seq', seq: 50 },
            { direction: 'older' },
        );
        await hook.unmount();
    });

    it('releases a landed jump window at the same older edge after placement ownership closes', async () => {
        const members = createStableMembers();
        const sessionOpenLatch = createSessionOpenLatch();
        sessionOpenLatch.arm({
            entryKind: 'jump',
            isNativeFlashListBottomMaintenanceEnabled: false,
            nativeFirstPaintFallbackDelayMs: 450,
            nowMs: 1_000,
            platform: 'web',
            sessionId: 's1',
            shouldFollowBottom: false,
            webInitialPinRetryDelaysMs: [50, 100],
            webInitialPinStabilizeMs: 250,
            webOpenPhaseDeadlineDelayMs: 30_000,
        });
        let placementTransactionOpen = true;
        members.olderPagination.isReadyForLoad.mockImplementation(
            () => sessionOpenLatch.initialFillStatus() === 'done' && !placementTransactionOpen,
        );
        const element = createScrollElement();
        Object.defineProperties(element, {
            scrollTop: { configurable: true, value: 0 },
            scrollHeight: { configurable: true, value: 1_200 },
            clientHeight: { configurable: true, value: 600 },
        });
        members.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element,
            scrollHeight: 1_200,
            scrollTop: 0,
        });
        members.targetWindowActiveRef.current = true;
        members.activeTargetWindowTargetRef.current = { kind: 'seq', seq: 50 };
        members.targetWindowHostFacts = {
            activeWindowState: {
                activatedAtMs: 1,
                hasMoreNewer: true,
                hasMoreOlder: true,
                isWindowMode: true,
                newerCursor: 60,
                olderCursor: 40,
                targetSeq: 50,
                windowId: 'window-50',
                windowMaxSeq: 60,
                windowMinSeq: 40,
            },
        };
        const loadTargetWindowMessages = vi
            .spyOn(sync, 'loadTargetWindowMessages')
            .mockResolvedValue({
                appliedSeqs: [],
                hasMoreNewer: true,
                hasMoreOlder: true,
                newerCursor: 60,
                olderCursor: 30,
                rawSeqs: [],
                status: 'loaded',
                targetPresent: true,
                targetSeq: 50,
                windowId: 'window-50',
            });
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(members), isLoaded: true } },
        );

        hook.getCurrent().onStartReached();
        expect(loadTargetWindowMessages).not.toHaveBeenCalled();

        placementTransactionOpen = false;
        expect(sessionOpenLatch.onJumpEntrySettled({ sessionId: 's1' })).toBe(true);
        hook.getCurrent().observeCommittedProjectionLayout();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);
        expect(loadTargetWindowMessages).toHaveBeenCalledWith(
            's1',
            { kind: 'seq', seq: 50 },
            { direction: 'older' },
        );
        await hook.unmount();
    });

    it('keeps active-window proximity off the ordinary tail cursor and routes its reached threshold to the window owner', async () => {
        const members = createStableMembers();
        const element = createScrollElement();
        Object.defineProperties(element, {
            scrollTop: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, value: 1200 },
            clientHeight: { configurable: true, value: 600 },
        });
        members.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element,
            scrollHeight: 1200,
            scrollTop: 100,
        });
        members.wantsPinnedRef.current = false;
        members.targetWindowActiveRef.current = true;
        members.activeTargetWindowTargetRef.current = { kind: 'seq', seq: 50 };
        members.targetWindowHostFacts = {
            activeWindowState: {
                activatedAtMs: 1,
                hasMoreNewer: true,
                hasMoreOlder: true,
                isWindowMode: true,
                newerCursor: 60,
                olderCursor: 40,
                targetSeq: 50,
                windowId: 'window-50',
                windowMaxSeq: 60,
                windowMinSeq: 40,
            },
        };
        const loadTargetWindowMessages = vi
            .spyOn(sync, 'loadTargetWindowMessages')
            .mockImplementation(() => new Promise(() => {}));
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(members), isLoaded: true } },
        );

        hook.getCurrent().onScroll({
            nativeEvent: {
                contentOffset: { x: 0, y: 100 },
                contentSize: { height: 1200, width: 0 },
                layoutMeasurement: { height: 600, width: 0 },
            },
        } as never);
        expect(members.olderPagination.onScrollObservation).not.toHaveBeenCalled();
        expect(loadTargetWindowMessages).toHaveBeenCalledWith(
            's1',
            { kind: 'seq', seq: 50 },
            { direction: 'older' },
        );

        hook.getCurrent().onStartReached();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);
        expect(members.olderPagination.onScrollObservation).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('does not storm a failed target cursor while proximity remains inside the threshold', async () => {
        const members = createStableMembers();
        const element = createScrollElement();
        members.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element,
            scrollHeight: 1200,
            scrollTop: 100,
        });
        members.wantsPinnedRef.current = false;
        members.targetWindowActiveRef.current = true;
        members.activeTargetWindowTargetRef.current = { kind: 'seq', seq: 50 };
        members.targetWindowHostFacts = {
            activeWindowState: {
                activatedAtMs: 1,
                hasMoreNewer: false,
                hasMoreOlder: true,
                isWindowMode: true,
                newerCursor: null,
                olderCursor: 40,
                targetSeq: 50,
                windowId: 'window-50',
                windowMaxSeq: 60,
                windowMinSeq: 40,
            },
        };
        const loadTargetWindowMessages = vi
            .spyOn(sync, 'loadTargetWindowMessages')
            .mockResolvedValue({
                appliedSeqs: [],
                hasMoreNewer: false,
                hasMoreOlder: true,
                newerCursor: null,
                olderCursor: 40,
                rawSeqs: [],
                status: 'not_ready',
                targetPresent: true,
                targetSeq: 50,
                windowId: 'window-50',
            });
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(members), isLoaded: true } },
        );
        const scrollNearOlder = () => hook.getCurrent().onScroll({
            nativeEvent: {
                contentOffset: { x: 0, y: 100 },
                contentSize: { height: 1200, width: 0 },
                layoutMeasurement: { height: 600, width: 0 },
            },
        } as never);

        scrollNearOlder();
        await Promise.resolve();
        scrollNearOlder();
        scrollNearOlder();

        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('retries the exact still-near target cursor after the existing pagination cooldown', async () => {
        vi.useFakeTimers();
        const members = createStableMembers();
        activateTargetWindow(members);
        const cooldownMs = sync.getSyncTuning().transcriptOlderLoadCooldownMs;
        const loadTargetWindowMessages = vi
            .spyOn(sync, 'loadTargetWindowMessages')
            .mockResolvedValueOnce(targetWindowLoadResult({
                status: 'retryable_error',
                targetPresent: false,
            }))
            .mockResolvedValue(targetWindowLoadResult());
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            {
                initialProps: {
                    ...buildDeps(members),
                    continuousFollowOwner: 'renderer',
                    isLoaded: true,
                },
            },
        );

        hook.getCurrent().onStartReached();
        await flushHookEffects();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(Math.max(0, cooldownMs - 1));
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(cooldownMs > 0 ? 1 : 0);
        await flushHookEffects();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(2);
        expect(loadTargetWindowMessages).toHaveBeenLastCalledWith(
            's1',
            { kind: 'seq', seq: 50 },
            { direction: 'older' },
        );

        await vi.advanceTimersByTimeAsync(cooldownMs * 2);
        await flushHookEffects();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
        await hook.unmount();
    });

    it('does not schedule or retry a persistent target-window not-ready result', async () => {
        vi.useFakeTimers();
        const members = createStableMembers();
        activateTargetWindow(members);
        const loadTargetWindowMessages = vi
            .spyOn(sync, 'loadTargetWindowMessages')
            .mockResolvedValue(targetWindowLoadResult({
                status: 'not_ready',
                targetPresent: false,
            }));
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            {
                initialProps: {
                    ...buildDeps(members),
                    continuousFollowOwner: 'renderer',
                    isLoaded: true,
                },
            },
        );

        hook.getCurrent().onStartReached();
        await flushHookEffects();
        expect(vi.getTimerCount()).toBe(0);

        await vi.advanceTimersByTimeAsync(sync.getSyncTuning().transcriptOlderLoadCooldownMs * 2);
        await flushHookEffects();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        await hook.unmount();
    });

    it('drains an already-near target edge when shared pagination readiness opens', async () => {
        const members = createStableMembers();
        activateTargetWindow(members);
        let ready = false;
        members.olderPagination.isReadyForLoad.mockImplementation(() => ready);
        const loadTargetWindowMessages = vi
            .spyOn(sync, 'loadTargetWindowMessages')
            .mockResolvedValue(targetWindowLoadResult());
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            {
                initialProps: {
                    ...buildDeps(members),
                    continuousFollowOwner: 'renderer',
                    isLoaded: true,
                },
            },
        );

        hook.getCurrent().onStartReached();
        expect(loadTargetWindowMessages).not.toHaveBeenCalled();

        ready = true;
        await hook.rerender({
            ...buildDeps(members),
            continuousFollowOwner: 'renderer',
            isLoaded: true,
        });
        await flushHookEffects();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('cancels a pending target-window retry when the window identity changes', async () => {
        vi.useFakeTimers();
        const members = createStableMembers();
        activateTargetWindow(members);
        const loadTargetWindowMessages = vi
            .spyOn(sync, 'loadTargetWindowMessages')
            .mockResolvedValue(targetWindowLoadResult({
                status: 'retryable_error',
                targetPresent: false,
            }));
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            {
                initialProps: {
                    ...buildDeps(members),
                    continuousFollowOwner: 'renderer',
                    isLoaded: true,
                },
            },
        );

        hook.getCurrent().onStartReached();
        await flushHookEffects();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);

        activateTargetWindow(members, targetWindowState({
            newerCursor: 160,
            olderCursor: 140,
            targetSeq: 150,
            windowId: 'window-150',
            windowMaxSeq: 160,
            windowMinSeq: 140,
        }));
        await hook.rerender({
            ...buildDeps(members),
            continuousFollowOwner: 'renderer',
            isLoaded: true,
        });
        await flushHookEffects();
        expect(vi.getTimerCount()).toBe(0);

        await vi.advanceTimersByTimeAsync(sync.getSyncTuning().transcriptOlderLoadCooldownMs * 2);
        await flushHookEffects();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('cancels a pending target-window retry after a real threshold exit', async () => {
        vi.useFakeTimers();
        const members = createStableMembers();
        const element = createScrollElement();
        members.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element,
            scrollHeight: 2_000,
            scrollTop: 900,
        });
        members.wantsPinnedRef.current = false;
        activateTargetWindow(members);
        const loadTargetWindowMessages = vi
            .spyOn(sync, 'loadTargetWindowMessages')
            .mockResolvedValue(targetWindowLoadResult({
                status: 'retryable_error',
                targetPresent: false,
            }));
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            {
                initialProps: {
                    ...buildDeps(members),
                    continuousFollowOwner: 'renderer',
                    isLoaded: true,
                },
            },
        );

        hook.getCurrent().onStartReached();
        await flushHookEffects();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);

        hook.getCurrent().onScroll({
            nativeEvent: {
                contentOffset: { x: 0, y: 900 },
                contentSize: { height: 2_000, width: 0 },
                layoutMeasurement: { height: 600, width: 0 },
            },
        } as never);
        expect(vi.getTimerCount()).toBe(0);

        await vi.advanceTimersByTimeAsync(sync.getSyncTuning().transcriptOlderLoadCooldownMs * 2);
        await flushHookEffects();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        await hook.unmount();
    });

    it('cancels a pending target-window retry on unmount and stays quiescent', async () => {
        vi.useFakeTimers();
        const members = createStableMembers();
        activateTargetWindow(members);
        const loadTargetWindowMessages = vi
            .spyOn(sync, 'loadTargetWindowMessages')
            .mockResolvedValue(targetWindowLoadResult({
                status: 'retryable_error',
                targetPresent: false,
            }));
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            {
                initialProps: {
                    ...buildDeps(members),
                    continuousFollowOwner: 'renderer',
                    isLoaded: true,
                },
            },
        );

        hook.getCurrent().onStartReached();
        await flushHookEffects();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);

        await hook.unmount();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(sync.getSyncTuning().transcriptOlderLoadCooldownMs * 2);
        await flushHookEffects();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('chains a successful target cursor advance but rearms a failed cursor only after a real edge exit', async () => {
        const members = createStableMembers();
        const element = createScrollElement();
        const setWebMetrics = (scrollTop: number) => {
            members.resolveWebScrollMetrics.mockReturnValue({
                clientHeight: 600,
                element,
                scrollHeight: 1200,
                scrollTop,
            });
        };
        setWebMetrics(100);
        members.wantsPinnedRef.current = false;
        members.targetWindowActiveRef.current = true;
        members.activeTargetWindowTargetRef.current = { kind: 'seq', seq: 50 };
        const activeWindowState = {
            activatedAtMs: 1,
            hasMoreNewer: false,
            hasMoreOlder: true,
            isWindowMode: true as const,
            newerCursor: null,
            olderCursor: 40,
            targetSeq: 50,
            windowId: 'window-50',
            windowMaxSeq: 60,
            windowMinSeq: 40,
        };
        members.targetWindowHostFacts = { activeWindowState };
        const loadTargetWindowMessages = vi
            .spyOn(sync, 'loadTargetWindowMessages')
            .mockResolvedValueOnce({
                appliedSeqs: [39],
                hasMoreNewer: false,
                hasMoreOlder: true,
                newerCursor: null,
                olderCursor: 30,
                rawSeqs: [39],
                status: 'loaded',
                targetPresent: true,
                targetSeq: 50,
                windowId: 'window-50',
            })
            .mockResolvedValue({
                appliedSeqs: [],
                hasMoreNewer: false,
                hasMoreOlder: true,
                newerCursor: null,
                olderCursor: 30,
                rawSeqs: [],
                status: 'not_ready',
                targetPresent: true,
                targetSeq: 50,
                windowId: 'window-50',
            });
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(members), isLoaded: true } },
        );
        const scroll = () => hook.getCurrent().onScroll({
            nativeEvent: {
                contentOffset: { x: 0, y: 100 },
                contentSize: { height: 1200, width: 0 },
                layoutMeasurement: { height: 600, width: 0 },
            },
        } as never);

        scroll();
        await Promise.resolve();
        members.targetWindowHostFacts = {
            activeWindowState: { ...activeWindowState, olderCursor: 30, windowMinSeq: 30 },
        };
        await hook.rerender({ ...buildDeps(members), isLoaded: true });
        scroll();
        await Promise.resolve();
        scroll();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(2);

        setWebMetrics(900);
        scroll();
        setWebMetrics(100);
        scroll();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(3);
        await hook.unmount();
    });

    it('rearms the newer cursor only after a real newer-threshold exit and re-entry', async () => {
        const members = createStableMembers();
        const element = createScrollElement();
        const setWebMetrics = (scrollTop: number) => {
            members.resolveWebScrollMetrics.mockReturnValue({
                clientHeight: 600,
                element,
                scrollHeight: 1200,
                scrollTop,
            });
        };
        setWebMetrics(500);
        members.wantsPinnedRef.current = false;
        members.targetWindowActiveRef.current = true;
        members.activeTargetWindowTargetRef.current = { kind: 'seq', seq: 50 };
        members.targetWindowHostFacts = {
            activeWindowState: {
                activatedAtMs: 1,
                hasMoreNewer: true,
                hasMoreOlder: false,
                isWindowMode: true,
                newerCursor: 60,
                olderCursor: null,
                targetSeq: 50,
                windowId: 'window-50',
                windowMaxSeq: 60,
                windowMinSeq: 40,
            },
        };
        const loadTargetWindowMessages = vi
            .spyOn(sync, 'loadTargetWindowMessages')
            .mockResolvedValue({
                appliedSeqs: [],
                hasMoreNewer: true,
                hasMoreOlder: false,
                newerCursor: 60,
                olderCursor: null,
                rawSeqs: [],
                status: 'not_ready',
                targetPresent: true,
                targetSeq: 50,
                windowId: 'window-50',
            });
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(members), isLoaded: true } },
        );
        const scroll = () => hook.getCurrent().onScroll({
            nativeEvent: {
                contentOffset: { x: 0, y: 500 },
                contentSize: { height: 1200, width: 0 },
                layoutMeasurement: { height: 600, width: 0 },
            },
        } as never);

        scroll();
        await Promise.resolve();
        scroll();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);
        expect(loadTargetWindowMessages).toHaveBeenLastCalledWith(
            's1',
            { kind: 'seq', seq: 50 },
            { direction: 'newer' },
        );

        setWebMetrics(0);
        scroll();
        setWebMetrics(500);
        scroll();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(2);
        await hook.unmount();
    });

    it('does not inherit near-edge eligibility across target-window identities', async () => {
        const members = createStableMembers();
        const element = createScrollElement();
        members.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element,
            scrollHeight: 1200,
            scrollTop: 100,
        });
        members.wantsPinnedRef.current = false;
        members.targetWindowActiveRef.current = true;
        members.activeTargetWindowTargetRef.current = { kind: 'seq', seq: 50 };
        const windowA = {
            activatedAtMs: 1,
            hasMoreNewer: true,
            hasMoreOlder: true,
            isWindowMode: true as const,
            newerCursor: 60,
            olderCursor: 40,
            targetSeq: 50,
            windowId: 'window-a',
            windowMaxSeq: 60,
            windowMinSeq: 40,
        };
        members.targetWindowHostFacts = { activeWindowState: windowA };
        let finishWindowA: (() => void) | null = null;
        const loadTargetWindowMessages = vi
            .spyOn(sync, 'loadTargetWindowMessages')
            .mockImplementationOnce(() => new Promise((resolve) => {
                finishWindowA = () => resolve({
                    appliedSeqs: [39],
                    hasMoreNewer: true,
                    hasMoreOlder: true,
                    newerCursor: 60,
                    olderCursor: 30,
                    rawSeqs: [39],
                    status: 'loaded',
                    targetPresent: true,
                    targetSeq: 50,
                    windowId: 'window-a',
                });
            }))
            .mockImplementation(() => new Promise(() => {}));
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(members), isLoaded: true } },
        );
        const scroll = () => hook.getCurrent().onScroll({
            nativeEvent: {
                contentOffset: { x: 0, y: 100 },
                contentSize: { height: 1200, width: 0 },
                layoutMeasurement: { height: 600, width: 0 },
            },
        } as never);

        scroll();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);

        members.activeTargetWindowTargetRef.current = { kind: 'seq', seq: 500 };
        members.targetWindowHostFacts = {
            activeWindowState: {
                ...windowA,
                newerCursor: 510,
                olderCursor: 490,
                targetSeq: 500,
                windowId: 'window-b',
                windowMaxSeq: 510,
                windowMinSeq: 490,
            },
        };
        members.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element,
            scrollHeight: 2200,
            scrollTop: 1000,
        });
        await hook.rerender({ ...buildDeps(members), isLoaded: true });
        scroll();
        (finishWindowA as (() => void) | null)?.();
        await Promise.resolve();
        await Promise.resolve();

        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('drains a newly near window B after window A releases the shared in-flight owner without publishing stale A state', async () => {
        const members = createStableMembers();
        const element = createScrollElement();
        members.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element,
            scrollHeight: 1200,
            scrollTop: 100,
        });
        members.wantsPinnedRef.current = false;
        members.targetWindowActiveRef.current = true;
        members.activeTargetWindowTargetRef.current = { kind: 'seq', seq: 50 };
        const windowA = {
            activatedAtMs: 1,
            hasMoreNewer: false,
            hasMoreOlder: true,
            isWindowMode: true as const,
            newerCursor: null,
            olderCursor: 40,
            targetSeq: 50,
            windowId: 'window-a',
            windowMaxSeq: 60,
            windowMinSeq: 40,
        };
        members.targetWindowHostFacts = { activeWindowState: windowA };
        let finishWindowA: ((value: Awaited<ReturnType<typeof sync.loadTargetWindowMessages>>) => void) | null = null;
        const loadTargetWindowMessages = vi
            .spyOn(sync, 'loadTargetWindowMessages')
            .mockImplementationOnce(() => new Promise((resolve) => {
                finishWindowA = resolve;
            }))
            .mockImplementation(() => new Promise(() => {}));
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(members), isLoaded: true } },
        );
        const scrollNearOlder = () => hook.getCurrent().onScroll({
            nativeEvent: {
                contentOffset: { x: 0, y: 100 },
                contentSize: { height: 1200, width: 0 },
                layoutMeasurement: { height: 600, width: 0 },
            },
        } as never);

        scrollNearOlder();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);

        const windowBTarget = { kind: 'seq' as const, seq: 500 };
        members.activeTargetWindowTargetRef.current = windowBTarget;
        members.targetWindowHostFacts = {
            activeWindowState: {
                ...windowA,
                olderCursor: 490,
                targetSeq: 500,
                windowId: 'window-b',
                windowMaxSeq: 510,
                windowMinSeq: 490,
            },
        };
        await hook.rerender({ ...buildDeps(members), isLoaded: true });
        scrollNearOlder();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);

        (finishWindowA as ((value: Awaited<ReturnType<typeof sync.loadTargetWindowMessages>>) => void) | null)?.({
            appliedSeqs: [39],
            hasMoreNewer: false,
            hasMoreOlder: true,
            newerCursor: null,
            olderCursor: 30,
            rawSeqs: [39],
            status: 'loaded',
            targetPresent: true,
            targetSeq: 50,
            windowId: 'window-a',
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(members.activeTargetWindowTargetRef.current).toEqual(windowBTarget);
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(2);
        expect(loadTargetWindowMessages).toHaveBeenLastCalledWith(
            's1',
            { kind: 'seq', seq: 500 },
            { direction: 'older' },
        );
        await hook.unmount();
    });

    it('does not drain a pending target-window continuation after its owner unmounts', async () => {
        const members = createStableMembers();
        members.targetWindowActiveRef.current = true;
        members.activeTargetWindowTargetRef.current = { kind: 'seq', seq: 50 };
        members.targetWindowHostFacts = {
            activeWindowState: {
                activatedAtMs: 1,
                hasMoreNewer: true,
                hasMoreOlder: true,
                isWindowMode: true,
                newerCursor: 60,
                olderCursor: 40,
                targetSeq: 50,
                windowId: 'window-a',
                windowMaxSeq: 60,
                windowMinSeq: 40,
            },
        };
        let finishOlder!: (value: Awaited<ReturnType<typeof sync.loadTargetWindowMessages>>) => void;
        const loadTargetWindowMessages = vi
            .spyOn(sync, 'loadTargetWindowMessages')
            .mockImplementationOnce(() => new Promise((resolve) => {
                finishOlder = resolve;
            }))
            .mockImplementation(() => new Promise(() => {}));
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(members), isLoaded: true } },
        );

        hook.getCurrent().onStartReached();
        hook.getCurrent().onEndReached();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);
        await hook.unmount();

        finishOlder({
            appliedSeqs: [39],
            hasMoreNewer: true,
            hasMoreOlder: true,
            newerCursor: 60,
            olderCursor: 30,
            rawSeqs: [39],
            status: 'loaded',
            targetPresent: true,
            targetSeq: 50,
            windowId: 'window-a',
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);
    });

    it('serializes an underfilled two-direction window older-first and then services newer without another gesture', async () => {
        const members = createStableMembers();
        const element = createScrollElement();
        members.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element,
            scrollHeight: 400,
            scrollTop: 0,
        });
        members.wantsPinnedRef.current = false;
        members.targetWindowActiveRef.current = true;
        members.activeTargetWindowTargetRef.current = { kind: 'seq', seq: 50 };
        members.targetWindowHostFacts = {
            activeWindowState: {
                activatedAtMs: 1,
                hasMoreNewer: true,
                hasMoreOlder: true,
                isWindowMode: true,
                newerCursor: 60,
                olderCursor: 40,
                targetSeq: 50,
                windowId: 'window-50',
                windowMaxSeq: 60,
                windowMinSeq: 40,
            },
        };
        let finishOlder: ((value: Awaited<ReturnType<typeof sync.loadTargetWindowMessages>>) => void) | null = null;
        const loadTargetWindowMessages = vi
            .spyOn(sync, 'loadTargetWindowMessages')
            .mockImplementationOnce(() => new Promise((resolve) => {
                finishOlder = resolve;
            }))
            .mockResolvedValue({
                appliedSeqs: [],
                hasMoreNewer: false,
                hasMoreOlder: false,
                newerCursor: null,
                olderCursor: null,
                rawSeqs: [],
                status: 'loaded',
                targetPresent: true,
                targetSeq: 50,
                windowId: 'window-50',
            });
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(members), isLoaded: true } },
        );

        hook.getCurrent().observeCommittedProjectionLayout();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);
        expect(loadTargetWindowMessages).toHaveBeenLastCalledWith(
            's1',
            { kind: 'seq', seq: 50 },
            { direction: 'older' },
        );
        (finishOlder as ((value: Awaited<ReturnType<typeof sync.loadTargetWindowMessages>>) => void) | null)?.({
            appliedSeqs: [],
            hasMoreNewer: true,
            hasMoreOlder: false,
            newerCursor: 60,
            olderCursor: null,
            rawSeqs: [],
            status: 'loaded',
            targetPresent: true,
            targetSeq: 50,
            windowId: 'window-50',
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(2);
        expect(loadTargetWindowMessages).toHaveBeenLastCalledWith(
            's1',
            { kind: 'seq', seq: 50 },
            { direction: 'newer' },
        );
        await Promise.resolve();
        hook.getCurrent().observeCommittedProjectionLayout();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(2);
        await hook.unmount();
    });

    it('does not consume a target cursor while jump ownership or warm keep-alive suppresses pagination', async () => {
        const members = createStableMembers();
        const element = createScrollElement();
        members.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element,
            scrollHeight: 1200,
            scrollTop: 100,
        });
        members.wantsPinnedRef.current = false;
        members.targetWindowActiveRef.current = true;
        members.activeTargetWindowTargetRef.current = { kind: 'seq', seq: 50 };
        members.targetWindowHostFacts = {
            activeWindowState: {
                activatedAtMs: 1,
                hasMoreNewer: false,
                hasMoreOlder: true,
                isWindowMode: true,
                newerCursor: null,
                olderCursor: 40,
                targetSeq: 50,
                windowId: 'window-50',
                windowMaxSeq: 60,
                windowMinSeq: 40,
            },
        };
        members.olderPagination.isReadyForLoad.mockReturnValue(false);
        const loadTargetWindowMessages = vi
            .spyOn(sync, 'loadTargetWindowMessages')
            .mockImplementation(() => new Promise(() => {}));
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            {
                initialProps: {
                    ...buildDeps(members),
                    isLoaded: true,
                    isWarmKeepAliveInstance: true,
                },
            },
        );

        hook.getCurrent().observeCommittedProjectionLayout();
        expect(loadTargetWindowMessages).not.toHaveBeenCalled();

        members.olderPagination.isReadyForLoad.mockReturnValue(true);
        await hook.rerender({
            ...buildDeps(members),
            isLoaded: true,
            isWarmKeepAliveInstance: false,
        });
        hook.getCurrent().observeCommittedProjectionLayout();
        expect(loadTargetWindowMessages).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('calls wheel stopPropagation with the synthetic event as receiver', async () => {
        const members = createStableMembers();
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: buildDeps(members) },
        );
        const host = hook.getCurrent();
        const event = {
            deltaY: 24,
            stopped: false,
            stopPropagation(this: { stopped: boolean }) {
                if (this !== event) throw new Error('detached stopPropagation call');
                this.stopped = true;
            },
        };

        const onWheel = host.platformInteractionProps.onWheel as ((nextEvent: unknown) => void) | undefined;
        expect(typeof onWheel).toBe('function');
        onWheel?.(event);

        expect(event.stopped).toBe(true);

        await hook.unmount();
    });

    it('routes web user takeover through the lifecycle owner to preempt the active explicit jump', async () => {
        const members = createStableMembers();
        members.dispatchViewportLifecycleEvent.mockImplementation((event) => ({
            effects: event.type === 'web-user-scroll-takeover'
                ? [
                    { sessionId: 's1', type: 'web-user-scroll-preempt-entry-restore' },
                    { sessionId: 's1', type: 'web-user-scroll-preempt-explicit-jump' },
                ]
                : [],
            state: members.lifecycleHost.getState(),
        }));
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: buildDeps(members) },
        );

        const onWheel = hook.getCurrent().platformInteractionProps.onWheel as ((event: unknown) => void);
        onWheel({ deltaY: -24, stopPropagation: vi.fn() });

        expect(members.preemptEntryRestoreTransaction).toHaveBeenCalledTimes(1);
        expect(members.preemptExplicitJumpForUserTakeover).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('keeps one explicitly interacted transcript as the keyboard owner after its focused row unmounts', async () => {
        const membersA = createStableMembers();
        const membersB = createStableMembers();
        const scrollerA = document.createElement('div');
        const scrollerB = document.createElement('div');
        const focusedRowA = document.createElement('button');
        const rowB = document.createElement('div');
        const outside = document.createElement('button');
        scrollerA.append(focusedRowA);
        scrollerB.append(rowB);
        document.body.append(scrollerA, scrollerB, outside);
        membersA.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element: scrollerA,
            scrollHeight: 1200,
            scrollTop: 600,
        });
        membersB.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element: scrollerB,
            scrollHeight: 1200,
            scrollTop: 600,
        });
        const notifyA = vi.fn();
        const notifyB = vi.fn();
        membersA.listRef.current = {
            notifyViewportInput: notifyA,
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        membersB.listRef.current = {
            notifyViewportInput: notifyB,
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        const addEventListenerSpy = vi.spyOn(document, 'addEventListener');
        const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
        const hookA = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(membersA), sessionId: 'session-a' } },
        );
        const hookB = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: { ...buildDeps(membersB), sessionId: 'session-b' } },
        );

        expect(hookA.getCurrent().platformInteractionProps.onKeyDown).toBeUndefined();
        expect(hookB.getCurrent().platformInteractionProps.onKeyDown).toBeUndefined();
        expect(
            addEventListenerSpy.mock.calls.filter(
                ([type, , options]) => type === 'keydown' && options === true,
            ),
        ).toHaveLength(1);

        focusedRowA.focus();
        expect(document.activeElement).toBe(focusedRowA);
        focusedRowA.remove();
        expect(document.activeElement).toBe(document.body);

        let activeElementObservedBeforeDefault: Element | null = null;
        document.body.addEventListener('keydown', () => {
            activeElementObservedBeforeDefault = document.activeElement;
        }, { once: true });
        document.body.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'PageDown',
        }));

        expect(notifyA).toHaveBeenCalledTimes(1);
        expect(notifyA).toHaveBeenLastCalledWith({
            kind: 'keyboard',
            verticalDirection: 'toward-end',
        });
        expect(notifyB).not.toHaveBeenCalled();
        expect(activeElementObservedBeforeDefault).toBe(scrollerA);
        expect(scrollerA.getAttribute('tabindex')).toBe('-1');

        outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        document.body.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'PageDown',
        }));
        expect(notifyA).toHaveBeenCalledTimes(1);
        expect(notifyB).not.toHaveBeenCalled();

        rowB.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'PageDown',
        }));
        expect(notifyA).toHaveBeenCalledTimes(1);
        expect(notifyB).toHaveBeenCalledTimes(1);
        expect(notifyB).toHaveBeenLastCalledWith({
            kind: 'keyboard',
            verticalDirection: 'toward-end',
        });

        rowB.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        document.body.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'PageDown',
        }));
        expect(notifyA).toHaveBeenCalledTimes(1);
        expect(notifyB).toHaveBeenCalledTimes(2);
        document.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'PageDown',
        }));
        expect(notifyB).toHaveBeenCalledTimes(3);

        await hookA.unmount();
        await hookB.unmount();
        expect(scrollerA.hasAttribute('tabindex')).toBe(false);
        expect(scrollerB.hasAttribute('tabindex')).toBe(false);
        expect(
            removeEventListenerSpy.mock.calls.filter(
                ([type, , options]) => type === 'keydown' && options === true,
            ),
        ).toHaveLength(1);
    });

    it.each([
        ['textarea', () => document.createElement('textarea')],
        ['contenteditable', () => {
            const element = document.createElement('div');
            element.setAttribute('contenteditable', 'true');
            return element;
        }],
        ['dialog', () => document.createElement('dialog')],
        ['menu', () => {
            const element = document.createElement('div');
            element.setAttribute('role', 'menu');
            return element;
        }],
        ['listbox', () => {
            const element = document.createElement('div');
            element.setAttribute('role', 'listbox');
            return element;
        }],
        ['combobox', () => {
            const element = document.createElement('div');
            element.setAttribute('role', 'combobox');
            return element;
        }],
    ])('does not claim transcript keyboard scrolling from a %s', async (_name, createExcludedElement) => {
        const members = createStableMembers();
        const scroller = document.createElement('div');
        const excludedElement = createExcludedElement();
        scroller.append(excludedElement);
        document.body.append(scroller);
        members.resolveWebScrollMetrics.mockReturnValue({
            clientHeight: 600,
            element: scroller,
            scrollHeight: 1200,
            scrollTop: 600,
        });
        const notifyViewportInput = vi.fn();
        members.listRef.current = {
            notifyViewportInput,
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        const hook = await renderHook(
            (deps: ScrollObservationHostDeps) => useTranscriptScrollObservationHost(deps),
            { initialProps: buildDeps(members) },
        );

        excludedElement.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'PageDown',
        }));
        expect(notifyViewportInput).not.toHaveBeenCalled();

        excludedElement.setAttribute('tabindex', '0');
        excludedElement.focus();
        expect(document.activeElement).toBe(excludedElement);
        document.body.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'PageDown',
        }));
        expect(notifyViewportInput).not.toHaveBeenCalled();

        await hook.unmount();
    });
});
