import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { resolveWebDomOlderLoadObservationTrigger } from '../driver/webDomOlderLoadObservation';
import {
    normalizeTranscriptScrollIngress,
    type TranscriptScrollIngressNativeEvent,
    type TranscriptScrollIngressObservation,
    type TranscriptScrollIngressPlatform,
} from '../driver/scrollIngress';
export type { TranscriptScrollIngressPlatform } from '../driver/scrollIngress';
import type {
    TranscriptLifecycleHost,
    TranscriptLifecycleHostScrollObservationPlan,
} from './lifecycleHost';
import type { TranscriptLifecycleScrollObservationPlanContinuationInput } from './lifecycleHostScrollObservationApplier';
import type { TranscriptViewportTelemetryObservationReason } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { TranscriptBottomFollowModeState } from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import type { TranscriptViewportOwner } from '../transcriptViewportTypes';
import type { EntryRestoreOwnerEffect } from '../entryRestore/entryRestoreOwner';
import type { NativePrependOwnerEffect } from '../prepend/nativePrependOwner';
import type { WebScrollMovementFact } from '@/components/sessions/transcript/scroll/resolveWebGenuineScrollMovement';

export type TranscriptScrollIngressSessionEntryFacts = Readonly<{
    sessionId: string | null | undefined;
    shouldFollowBottom: boolean | null | undefined;
}>;

export type TranscriptScrollIngressObservationResult = Readonly<{
    consumed: boolean;
    observation: TranscriptScrollIngressObservation | null;
}>;

export type TranscriptScrollIngressInput = Readonly<{
    bottomFollowModeState: TranscriptBottomFollowModeState;
    configuredBottomDistanceNoiseFloorPx: number | null | undefined;
    eventNativeEvent: TranscriptScrollIngressNativeEvent | null | undefined;
    hasNativeContentMeasurement: boolean;
    hasNativeInitialViewportApplied: boolean;
    hasRenderedItems: boolean;
    isLoaded: boolean;
    isWarmKeepAliveInstance: boolean;
    lastScrollOffsetForIntent: number | null;
    lastUserScrollIntentAtMs: number;
    loadOlderInFlight: boolean;
    measuredContentHeight: number;
    measuredLayoutHeight: number;
    nativeListDragActive: boolean;
    nativeMomentumScrollActive: boolean;
    nativeMountSettleDeadlineReached: boolean;
    nativeMountSettleStable: boolean;
    nowMs: number;
    pinEnabled: boolean;
    pinThresholdPx: number;
    platform: TranscriptScrollIngressPlatform;
    sessionEntry: TranscriptScrollIngressSessionEntryFacts;
    sessionId: string;
    userIntentRecentMs: number;
    wantsPinned: boolean;
    /** Required for web ingress; omission fails closed before lifecycle effects. */
    webMovementFact?: WebScrollMovementFact;
}>;

export type TranscriptScrollIngressCallbacks = Readonly<{
    applyNativePrependOwnerEffects(effects: readonly NativePrependOwnerEffect[]): void;
    applyEntryRestoreOwnerEffects(effects: readonly EntryRestoreOwnerEffect[]): void;
    applyScrollObservationPlan(
        plan: TranscriptLifecycleHostScrollObservationPlan,
        callbacks: Readonly<{
            continueAfterEarlyEffects(input: TranscriptLifecycleScrollObservationPlanContinuationInput): void;
            recordNativeScrollObservation(reason: TranscriptViewportTelemetryObservationReason): void;
        }>,
    ): boolean;
    commitOpenNativeEntryRestoreVisibleState(distanceFromLiveTailPx: number): void;
    drainDeferredNewerMessages(input: Readonly<{
        distanceFromBottom: number;
        pinned: boolean;
    }>): void;
    hasOpenNativeEntryRestoreTransaction(): boolean;
    hasOpenNativePrependTransaction(): boolean;
    invalidateViewportAnchorCapture(): void;
    observeMountSettleMetrics(input: Readonly<{
        distanceFromBottom: number;
        nowMs: number;
    }>): void;
    observeNativeConfirmation(input: Readonly<{
        contentHeight: number;
        distanceFromBottom: number;
        isTrusted: boolean;
        mountSettleStable: boolean;
    }>): boolean;
    observeNativeEntryRestoreHostFacts(input: Readonly<{
        contentHeight: number;
        distanceFromBottom: number;
        layoutHeight: number;
        mountSettleStable?: boolean;
        nowMs: number;
        offsetY: number;
        rawOffsetY: number;
    }>): readonly EntryRestoreOwnerEffect[];
    observeNativePrependOwner(): void;
    observeOlderPaginationScroll(input: Readonly<{
        contentHeight: number;
        distanceFromBottom: number;
        layoutHeight: number;
        offsetY: number;
        trigger: 'edge-reached' | 'scroll';
        webMetrics: WebTranscriptScrollMetrics | null;
    }>): boolean | void;
    /**
     * `genuineUserMovement` is this frame's user-authority classification: it
     * releases a jump landing's claim on the current navigation anchor so normal
     * containment resumes on the very same frame.
     */
    observeTranscriptNavigationVisibility(input: Readonly<{ genuineUserMovement: boolean }>): void;
    preemptEntryRestoreTransaction(): void;
    promotePendingJumpSeqViewportSnapshot(input: Readonly<{
        distanceFromBottom: number;
        metrics: WebTranscriptScrollMetrics;
        scrollOffsetPx: number;
    }>): boolean;
    recordNativeScrollObservation(input: Readonly<{
        canonicalOffsetY: number;
        contentHeight: number;
        distanceFromBottom: number;
        layoutHeight: number;
        rawOffsetY: number;
        reason: TranscriptViewportTelemetryObservationReason;
    }>): void;
    recordWebRouteJumpProtectionClearingMovement(timestampMs: number): void;
    recordNativeVisibleWindowTelemetry(
        reason: TranscriptViewportTelemetryObservationReason,
        input: Readonly<{
            canonicalOffsetY: number;
            contentHeight: number;
            distanceFromBottom: number;
            layoutHeight: number;
            rawOffsetY: number;
        }>,
    ): void;
    observeNativeBlankRecovery(
        reason: TranscriptViewportTelemetryObservationReason,
        input: Readonly<{
            canonicalOffsetY: number;
            contentHeight: number;
            distanceFromBottom: number;
            emptyVisibleWindowObserved?: boolean;
            layoutHeight: number;
            rawOffsetY: number;
            viewportOutsideContentObserved?: boolean;
        }>,
    ): void;
    resolveWebScrollMetrics(): WebTranscriptScrollMetrics | null;
    shouldIgnoreNativeInvalidScrollObservation(rawOffsetY: number, distanceFromLiveTailPx: number): boolean;
    trustedNativePrependScroll(input: Readonly<{
        activeOwner: TranscriptViewportOwner;
        sessionId: string;
    }>): readonly NativePrependOwnerEffect[];
    updateNativeViewportPaintObserved(value: boolean): void;
    activeViewportCommandOwner(): TranscriptViewportOwner;
    lifecycleHost: TranscriptLifecycleHost;
    verifyWebEntryRestoreTransaction(): void;
}>;

export function observeTranscriptScrollIngress(
    input: TranscriptScrollIngressInput,
    callbacks: TranscriptScrollIngressCallbacks,
): TranscriptScrollIngressObservationResult {
    const observation = normalizeTranscriptScrollIngress({
        eventNativeEvent: input.eventNativeEvent,
        measuredContentHeight: input.measuredContentHeight,
        measuredLayoutHeight: input.measuredLayoutHeight,
        platform: input.platform,
        webMetrics: input.platform === 'web' ? callbacks.resolveWebScrollMetrics() : null,
    });
    if (!observation) return { consumed: true, observation: null };
    const webMovementFact = input.webMovementFact;
    if (observation.platform === 'web' && webMovementFact === undefined) {
        return { consumed: true, observation };
    }

    // Native user authority is the OPEN DRAG: `onScrollBeginDrag` fires only for a
    // real finger drag (never for the app's own programmatic write), and RN puts
    // `isTrusted` on the synthetic event wrapper — the native scroll payload this
    // ingress receives carries none, so it could only ever answer `false` here and
    // a native landing would pin the rail forever. Web frames arrive with the
    // renderer's own canonical classification (the fail-closed guard above already
    // dropped frames without one).
    callbacks.observeTranscriptNavigationVisibility({
        genuineUserMovement: observation.platform === 'native'
            ? input.nativeListDragActive === true
            : webMovementFact?.isGenuineUserMovement === true,
    });

    const recordNativeScrollObservation = (
        reason: TranscriptViewportTelemetryObservationReason = 'observed',
    ): void => {
        if (observation.platform === 'web') return;
        const telemetryInput = {
            canonicalOffsetY: observation.scrollOffsetPx,
            contentHeight: observation.contentHeightPx,
            distanceFromBottom: observation.distanceFromLiveTailForReleasePx,
            layoutHeight: observation.layoutHeightPx,
            rawOffsetY: observation.rawOffsetY,
            reason,
            viewportOutsideContentObserved: observation.viewportOutsideContent,
        } as const;
        callbacks.recordNativeScrollObservation(telemetryInput);
        callbacks.observeNativeBlankRecovery(reason, telemetryInput);
        callbacks.recordNativeVisibleWindowTelemetry(reason, telemetryInput);
    };
    const observeCanonicalOlderPaginationScroll = (): boolean => {
        const trigger =
            observation.platform === 'web'
                ? resolveWebDomOlderLoadObservationTrigger({
                    scrollTop: observation.scrollOffsetPx,
                })
                : 'scroll';
        return callbacks.observeOlderPaginationScroll({
            offsetY: observation.scrollOffsetPx,
            layoutHeight: observation.layoutHeightPx,
            contentHeight: observation.contentHeightPx,
            distanceFromBottom: observation.distanceFromLiveTailPx,
            webMetrics: observation.webMetrics,
            trigger,
        }) === true;
    };

    if (
        observation.platform === 'native' &&
        callbacks.shouldIgnoreNativeInvalidScrollObservation(
            observation.rawOffsetY,
            observation.distanceFromLiveTailForReleasePx,
        )
    ) {
        recordNativeScrollObservation('invalid-native-offset');
        return { consumed: true, observation };
    }

    let entryRestoreConfirmedByThisObservation = false;
    if (observation.platform === 'native' && callbacks.hasOpenNativeEntryRestoreTransaction()) {
        if (observation.isTrusted) {
            callbacks.preemptEntryRestoreTransaction();
        } else {
            const entryEffects = callbacks.observeNativeEntryRestoreHostFacts({
                contentHeight: observation.contentHeightPx,
                distanceFromBottom: observation.distanceFromLiveTailForReleasePx,
                layoutHeight: observation.layoutHeightPx,
                mountSettleStable: input.nativeMountSettleStable,
                nowMs: input.nowMs,
                offsetY: observation.scrollOffsetPx,
                rawOffsetY: observation.rawOffsetY,
            });
            entryRestoreConfirmedByThisObservation =
                entryEffects.some((effect) => effect.type === 'native-initial-viewport-applied');
            callbacks.applyEntryRestoreOwnerEffects(entryEffects);
            if (!entryEffects.some((effect) => effect.type === 'close-entry-ownership')) {
                callbacks.commitOpenNativeEntryRestoreVisibleState(observation.distanceFromLiveTailForReleasePx);
                callbacks.invalidateViewportAnchorCapture();
                recordNativeScrollObservation('pending');
                return { consumed: true, observation };
            }
            if (entryRestoreConfirmedByThisObservation) {
                callbacks.updateNativeViewportPaintObserved(true);
            }
        }
    }

    if (observation.platform === 'native' && callbacks.hasOpenNativePrependTransaction()) {
        if (observation.isTrusted) {
            callbacks.applyNativePrependOwnerEffects(callbacks.trustedNativePrependScroll({
                activeOwner: callbacks.activeViewportCommandOwner(),
                sessionId: input.sessionId,
            }));
        } else {
            callbacks.observeNativePrependOwner();
            if (callbacks.hasOpenNativePrependTransaction()) {
                recordNativeScrollObservation('pending');
                return { consumed: true, observation };
            }
        }
    }

    if (
        observation.platform === 'native' &&
        callbacks.observeNativeConfirmation({
            contentHeight: observation.contentHeightPx,
            distanceFromBottom: observation.distanceFromLiveTailForReleasePx,
            isTrusted: observation.isTrusted,
            mountSettleStable: input.nativeMountSettleStable,
        })
    ) {
        recordNativeScrollObservation('observed');
        return { consumed: true, observation };
    }

    if (
        observation.platform === 'web' &&
        observation.webMetrics &&
        callbacks.promotePendingJumpSeqViewportSnapshot({
            distanceFromBottom: observation.distanceFromLiveTailPx,
            metrics: observation.webMetrics,
            scrollOffsetPx: observation.webMetrics.scrollTop,
        })
    ) {
        // Promotion consumes generic viewport publication, not the canonical
        // pagination observation. At exact top the DOM cannot emit another
        // upward scroll after clamping, so this frame must reach the edge owner.
        observeCanonicalOlderPaginationScroll();
        return { consumed: true, observation };
    }

    const webMovement = observation.platform === 'web'
        ? {
            webMovedSinceLastObservation: webMovementFact?.movedSinceLastObservation ?? null,
            webObservedUpwardIntent: webMovementFact?.upwardIntent ?? false,
            webObservedUserScrollMovement: webMovementFact?.isGenuineUserMovement ?? false,
        }
        : {
            webMovedSinceLastObservation: null,
            webObservedUpwardIntent: false,
            webObservedUserScrollMovement: false,
        };
    const recentUserIntentBeforeObservation =
        observation.platform === 'web'
            ? webMovement.webObservedUserScrollMovement
            : observation.isTrusted || input.nowMs - input.lastUserScrollIntentAtMs < input.userIntentRecentMs;

    if (observation.platform === 'web') {
        const hasWebUserAuthority = webMovement.webObservedUserScrollMovement;
        if (hasWebUserAuthority) {
            callbacks.recordWebRouteJumpProtectionClearingMovement(input.nowMs);
        }
        if (hasWebUserAuthority) {
            callbacks.preemptEntryRestoreTransaction();
        } else {
            callbacks.verifyWebEntryRestoreTransaction();
        }
    }

    const previousScrollOffset =
        input.lastScrollOffsetForIntent ?? (input.wantsPinned ? observation.visualBottomScrollOffsetPx : null);
    const movedAwayFromLiveTail =
        observation.platform === 'web'
            ? webMovement.webObservedUpwardIntent
            : previousScrollOffset !== null && observation.scrollOffsetPx < previousScrollOffset;
    const movedTowardLiveTail =
        observation.platform === 'web'
            ? webMovementFact?.downwardIntent ?? false
            : previousScrollOffset !== null && observation.scrollOffsetPx > previousScrollOffset;
    const hasOpenTrustedAwayGesture =
        observation.platform === 'native' &&
        input.bottomFollowModeState.dragSession?.trusted === true &&
        input.bottomFollowModeState.dragSession.sawAwayMovement === true;

    const scrollObservationPlan = observation.platform === 'web'
        ? callbacks.lifecycleHost.observeScroll({
            distanceFromLiveTailPx: observation.distanceFromLiveTailPx,
            hasLiveWebMetrics: observation.hasLiveWebMetrics,
            isTrusted: observation.isTrusted,
            movedAwayFromLiveTail,
            movedTowardLiveTail,
            nowMs: input.nowMs,
            pinEnabled: input.pinEnabled,
            pinThresholdPx: input.pinThresholdPx,
            platform: 'web',
            previousScrollOffsetPx: previousScrollOffset,
            recentUserIntent: recentUserIntentBeforeObservation,
            scrollOffsetPx: observation.scrollOffsetPx,
            sessionId: input.sessionId,
            wantsPinned: input.wantsPinned,
            webMovedSinceLastObservation: webMovement.webMovedSinceLastObservation ?? undefined,
            webObservedUserScrollMovement: webMovement.webObservedUserScrollMovement,
        })
        : callbacks.lifecycleHost.observeScroll({
            bottomFollowMode: input.bottomFollowModeState.mode,
            configuredBottomDistanceNoiseFloorPx: input.configuredBottomDistanceNoiseFloorPx,
            contentHeightPx: observation.contentHeightPx,
            distanceFromLiveTailForReleasePx: observation.distanceFromLiveTailForReleasePx,
            distanceFromLiveTailPx: observation.distanceFromLiveTailPx,
            entryRestoreConfirmedByObservation: entryRestoreConfirmedByThisObservation,
            hasNativeContentMeasurement: input.hasNativeContentMeasurement,
            hasNativeInitialViewportApplied: input.hasNativeInitialViewportApplied,
            hasOpenTrustedAwayGesture,
            hasRenderedItems: input.hasRenderedItems,
            hasTrustedDragSession: input.bottomFollowModeState.dragSession?.trusted === true,
            isLoaded: input.isLoaded,
            isTrusted: observation.isTrusted,
            isWarmKeepAliveInstance: input.isWarmKeepAliveInstance,
            lastUserScrollIntentAtMs: input.lastUserScrollIntentAtMs,
            layoutHeightPx: observation.layoutHeightPx,
            movedAwayFromLiveTail,
            movedTowardLiveTail,
            nativeListDragActive: input.nativeListDragActive,
            nativeMomentumScrollActive: input.nativeMomentumScrollActive,
            nativeMountSettleDeadlineReached: input.nativeMountSettleDeadlineReached,
            nativeMountSettleStable: input.nativeMountSettleStable,
            nowMs: input.nowMs,
            pinEnabled: input.pinEnabled,
            pinThresholdPx: input.pinThresholdPx,
            platform: 'native',
            previousScrollOffsetPx: previousScrollOffset,
            recentUserIntent: recentUserIntentBeforeObservation,
            scrollOffsetPx: observation.scrollOffsetPx,
            sessionEntrySessionId: input.sessionEntry.sessionId ?? null,
            sessionEntryShouldFollowBottom: input.sessionEntry.shouldFollowBottom,
            sessionId: input.sessionId,
            userIntentRecentMs: input.userIntentRecentMs,
            wantsPinned: input.wantsPinned,
        });

    const consumed = callbacks.applyScrollObservationPlan(scrollObservationPlan, {
        continueAfterEarlyEffects({
            hasNativeMountSettlePassiveDriftRepinObservation,
            recentUserIntent,
        }) {
            callbacks.lifecycleHost.sampleMountSettle({
                sessionId: input.sessionId,
                nowMs: input.nowMs,
            });
            callbacks.observeMountSettleMetrics({
                nowMs: input.nowMs,
                distanceFromBottom: observation.distanceFromLiveTailPx,
            });
            observeCanonicalOlderPaginationScroll();
        },
        recordNativeScrollObservation,
    });

    if (observation.platform === 'web') {
        const plannedWantsPinned = scrollObservationPlan.state.bottomFollowState.mode === 'following';
        callbacks.drainDeferredNewerMessages({
            distanceFromBottom: observation.distanceFromLiveTailPx,
            pinned: plannedWantsPinned && observation.distanceFromLiveTailPx <= input.pinThresholdPx,
        });
        return { consumed: true, observation };
    }

    return { consumed, observation };
}
