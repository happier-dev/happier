/**
 * Identity-stability contract for the M6 scroll observation host.
 *
 * The host receives a fresh deps object from ChatList during normal renders. Returned shell
 * callbacks and interaction props must stay stable when the individual dependency fields are
 * unchanged.
 */
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { useTranscriptScrollObservationHost } from './useTranscriptScrollObservationHost';

type ScrollObservationHostDeps = Parameters<typeof useTranscriptScrollObservationHost>[0];

function createRef<T>(current: T): { current: T } {
    return { current };
}

function createStableMembers() {
    const lifecycleHost = {
        planLocalInteractionAutoPinDeferral: vi.fn(() => ({
            localInteractionAutoPinDeferralEffects: [],
            state: { bottomFollowState: { dragSession: null, mode: 'following' } },
        })),
    };
    return {
        activeTargetWindowTargetRef: createRef(null),
        applyBlankRecoveryEffects: vi.fn(),
        applyEntryRestoreOwnerEffects: vi.fn(),
        applyNativeBottomFollowCompletionHostEffects: vi.fn(),
        applyNativeDragActiveMirrorEffectsRef: createRef(() => {}),
        applyNativeMountSettlePassiveDriftRepinObservation: vi.fn(),
        applyNativeUserScrollTakeoverHostEffects: vi.fn(),
        applyWebPassiveLiveTailCorrectionEffectRef: createRef(() => false),
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
        dispatchViewportLifecycleEvent: vi.fn(() => ({
            effects: [],
            state: { bottomFollowState: { dragSession: null, mode: 'following' } },
        })),
        emitViewportChange: vi.fn(),
        entryRestoreOwner: {
            hasOpenTransaction: vi.fn(() => false),
            visibleDistanceForOpenNativeEntry: vi.fn(() => null),
        },
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
        listRef: createRef(null),
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
            onScrollObservation: vi.fn(),
        },
        pendingJumpSeqViewportPromotionRef: createRef(null),
        pendingNativeMountSettleBottomPinRef: createRef(false),
        pinEnabledRef: createRef(true),
        pinNativeInitialFollowBottomViewportIfReady: vi.fn(),
        pinThresholdPxRef: createRef(72),
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
        recordFirstListPaint: vi.fn(),
        recordListLayoutWidth: vi.fn(),
        recordNativeVisibleWindowTelemetry: vi.fn(),
        recordScrollObservedTelemetry: vi.fn(),
        recordStablePaintTelemetry: vi.fn(),
        recordViewportTelemetryEvent: vi.fn(),
        resolveEffectiveListPaintMetrics: vi.fn(() => null),
        resolveNativeObservedScrollOffset: vi.fn(() => null),
        resolveTranscriptMountSettleBottomDistanceNoiseFloorPx: vi.fn(() => null),
        resolveViewportReachedEdge: vi.fn((edge: 'start' | 'end') => edge === 'start' ? 'older' : 'newer'),
        resolveViewportTelemetryMode: vi.fn(() => 'follow-bottom'),
        resolveWebScrollMetrics: vi.fn(() => null),
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
        targetWindowEdgeLoadInFlightRef: createRef({ newer: false, older: false }),
        targetWindowHostFacts: { activeWindowState: null },
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

describe('useTranscriptScrollObservationHost identity stability', () => {
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
});
