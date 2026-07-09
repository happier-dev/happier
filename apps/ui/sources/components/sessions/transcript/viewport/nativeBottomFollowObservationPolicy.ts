import type { TranscriptBottomFollowMode } from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import { resolveTranscriptAutoFollowPinWaitMs } from '@/components/sessions/transcript/scroll/transcriptAutoFollowGate';
import type { TranscriptViewportTelemetryScrollReason } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { TranscriptViewportControllerInput } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';

function isFiniteNumber(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

export function nativeBottomFollowPinTargetObserved(params: Readonly<{
    lastNativePinOffset: number | null | undefined;
    pinThresholdPx: number;
    visualBottomScrollOffset: number | null | undefined;
}>): boolean {
    if (!isFiniteNumber(params.lastNativePinOffset) || !isFiniteNumber(params.visualBottomScrollOffset)) {
        return false;
    }
    return (
        Math.abs(params.visualBottomScrollOffset - params.lastNativePinOffset) <= params.pinThresholdPx ||
        params.lastNativePinOffset >= params.visualBottomScrollOffset - params.pinThresholdPx
    );
}

export function nativeBottomFollowCanCompletePendingPin(params: Readonly<{
    mountSettleDeadlineReached: boolean;
    mountSettleStable: boolean;
    pendingBottomPin: boolean;
    pinTargetObserved: boolean;
}>): boolean {
    return (
        params.mountSettleStable ||
        params.mountSettleDeadlineReached ||
        !params.pendingBottomPin ||
        params.pinTargetObserved
    );
}

export function nativeBottomFollowCanApplyCompletion(params: Readonly<{
    canCompletePendingPin: boolean;
    distanceFromBottom: number;
    isNative: boolean;
    pinThresholdPx: number;
    wantsPinned: boolean;
}>): boolean {
    return (
        params.isNative &&
        params.wantsPinned &&
        params.distanceFromBottom <= params.pinThresholdPx &&
        params.canCompletePendingPin
    );
}

export type NativeBottomFollowCompletionEffect = Readonly<{
    entrySettleBaselineContentHeight: number;
    sessionId: string;
    type: 'complete-native-bottom-follow';
}>;

export function resolveNativeBottomFollowCompletionEffects(params: Readonly<{
    contentHeight: number;
    distanceFromBottom: number;
    isNative: boolean;
    lastNativePinOffset: number | null | undefined;
    mountSettleDeadlineReached: boolean;
    mountSettleStable: boolean;
    pendingBottomPin: boolean;
    pinThresholdPx: number;
    sessionId: string;
    usesNativeFlashListBottomMaintenance: boolean;
    visualBottomScrollOffset: number | null | undefined;
    wantsPinned: boolean;
}>): readonly NativeBottomFollowCompletionEffect[] {
    const pinTargetObserved =
        params.isNative &&
        params.usesNativeFlashListBottomMaintenance &&
        params.pendingBottomPin &&
        nativeBottomFollowPinTargetObserved({
            lastNativePinOffset: params.lastNativePinOffset,
            pinThresholdPx: params.pinThresholdPx,
            visualBottomScrollOffset: params.visualBottomScrollOffset,
        });
    const canCompletePendingPin = nativeBottomFollowCanCompletePendingPin({
        mountSettleDeadlineReached: params.mountSettleDeadlineReached,
        mountSettleStable: params.mountSettleStable,
        pendingBottomPin: params.pendingBottomPin,
        pinTargetObserved,
    });
    if (!nativeBottomFollowCanApplyCompletion({
        canCompletePendingPin,
        distanceFromBottom: params.distanceFromBottom,
        isNative: params.isNative,
        pinThresholdPx: params.pinThresholdPx,
        wantsPinned: params.wantsPinned,
    })) {
        return [];
    }
    return [{
        entrySettleBaselineContentHeight: params.contentHeight,
        sessionId: params.sessionId,
        type: 'complete-native-bottom-follow',
    }];
}

export function resolveNativeBottomFollowPreviousFollow(params: Readonly<{
    autoPinDelayMs: number;
    bottomFollowMode: TranscriptBottomFollowMode;
    isNative: boolean;
    lastUserScrollIntentAtMs: number;
    nativeHotTailHeightPx: number;
    nowMs: number;
    usesNativeFlashListBottomMaintenance: boolean;
    wantsPinned: boolean;
}>): boolean {
    if (!params.isNative || !params.usesNativeFlashListBottomMaintenance) return false;
    if (params.nativeHotTailHeightPx <= 0) return false;
    if (!params.wantsPinned) return false;
    if (params.bottomFollowMode !== 'following') return false;
    if (params.nowMs - params.lastUserScrollIntentAtMs < params.autoPinDelayMs) return false;
    return true;
}

export function resolveNativeMountSettleBottomPinRetention(params: Readonly<{
    autoPinDelayMs: number;
    canAutoFollowMountSettle: boolean;
    hasRearmedNativeBottomFollow: boolean;
    isJumpToSeqActive: boolean;
    lastUserScrollIntentAtMs: number;
    nowMs: number;
    usesNativeFlashListBottomMaintenance: boolean;
}>): boolean {
    if (!params.usesNativeFlashListBottomMaintenance) return false;
    if (params.isJumpToSeqActive) return false;
    if (!params.canAutoFollowMountSettle) return false;
    return params.hasRearmedNativeBottomFollow ||
        params.nowMs - params.lastUserScrollIntentAtMs >= params.autoPinDelayMs;
}

export type NativeMountSettlePassiveDriftRepinPreflightDecision =
    | Readonly<{ type: 'check-current-distance' }>
    | Readonly<{
        reason:
            | 'not-native'
            | 'native-maintenance-disabled'
            | 'trusted-observation'
            | 'not-wants-live-tail'
            | 'not-following'
            | 'mount-settle-inactive'
            | 'recent-user-intent';
        type: 'ignore';
    }>;

export function resolveNativeMountSettlePassiveDriftRepinPreflightDecision(params: Readonly<{
    autoPinDelayMs: number;
    bottomFollowMode: TranscriptBottomFollowMode;
    isMountSettleActive: boolean;
    isNative: boolean;
    isTrusted: boolean;
    lastUserScrollIntentAtMs: number;
    nowMs: number;
    usesNativeFlashListBottomMaintenance: boolean;
    wantsPinned: boolean;
}>): NativeMountSettlePassiveDriftRepinPreflightDecision {
    if (!params.isNative) return { reason: 'not-native', type: 'ignore' };
    if (!params.usesNativeFlashListBottomMaintenance) {
        return { reason: 'native-maintenance-disabled', type: 'ignore' };
    }
    if (params.isTrusted) return { reason: 'trusted-observation', type: 'ignore' };
    if (!params.wantsPinned) return { reason: 'not-wants-live-tail', type: 'ignore' };
    if (params.bottomFollowMode !== 'following') return { reason: 'not-following', type: 'ignore' };
    if (!params.isMountSettleActive) return { reason: 'mount-settle-inactive', type: 'ignore' };
    if (params.nowMs - params.lastUserScrollIntentAtMs < params.autoPinDelayMs) {
        return { reason: 'recent-user-intent', type: 'ignore' };
    }
    return { type: 'check-current-distance' };
}

export type NativeMountSettlePassiveDriftRepinDistanceDecision =
    | Readonly<{ type: 'request-repin' }>
    | Readonly<{
        reason: 'unmeasured-distance' | 'within-live-tail-threshold';
        type: 'skip';
    }>;

export function resolveNativeMountSettlePassiveDriftRepinDistanceDecision(params: Readonly<{
    distanceFromLiveTailPx: number | null;
    pinThresholdPx: number;
}>): NativeMountSettlePassiveDriftRepinDistanceDecision {
    if (params.distanceFromLiveTailPx == null) {
        return { reason: 'unmeasured-distance', type: 'skip' };
    }
    if (params.distanceFromLiveTailPx <= params.pinThresholdPx) {
        return { reason: 'within-live-tail-threshold', type: 'skip' };
    }
    return { type: 'request-repin' };
}

export type NativeMountSettlePassiveDriftRepinEffect = Readonly<{
    reason: 'layout-change';
    sessionId: string;
    type: 'request-measured-native-automatic-live-tail-pin';
}>;

export function resolveNativeMountSettlePassiveDriftRepinEffects(params: Readonly<{
    decision: NativeMountSettlePassiveDriftRepinDistanceDecision;
    sessionId: string;
}>): readonly NativeMountSettlePassiveDriftRepinEffect[] {
    if (params.decision.type !== 'request-repin') return [];
    return [{
        reason: 'layout-change',
        sessionId: params.sessionId,
        type: 'request-measured-native-automatic-live-tail-pin',
    }];
}

export type NativePendingMountSettleBottomPinFlushDecision =
    | Readonly<{ type: 'noop' }>
    | Readonly<{ type: 'clear-pending' }>
    | Readonly<{ type: 'wait-for-mount-settle' }>
    | Readonly<{ type: 'issue-mount-settle-pin' }>;

export function resolveNativePendingMountSettleBottomPinFlushDecision(params: Readonly<{
    canRetainPendingMountSettleBottomPin: boolean;
    isMountSettleActive: boolean;
    mountSettleDeadlineReached: boolean;
    pendingMountSettleBottomPin: boolean;
}>): NativePendingMountSettleBottomPinFlushDecision {
    if (!params.pendingMountSettleBottomPin && !params.mountSettleDeadlineReached) {
        return { type: 'noop' };
    }
    if (!params.canRetainPendingMountSettleBottomPin) {
        return { type: 'clear-pending' };
    }
    if (params.isMountSettleActive && !params.mountSettleDeadlineReached) {
        return { type: 'wait-for-mount-settle' };
    }
    return { type: 'issue-mount-settle-pin' };
}

export type NativeMountSettlePendingFlushTriggerDecision =
    | Readonly<{ type: 'noop' }>
    | Readonly<{ type: 'flush-pending' }>
    | Readonly<{ type: 'request-pending-flush' }>;

export function resolveNativeMountSettlePendingFlushTriggerDecision(params: Readonly<{
    autoPinSuppressed: boolean;
    hasInitialViewportApplied: boolean;
    mountSettleDeadlineReached: boolean;
    mountSettleStable: boolean;
}>): NativeMountSettlePendingFlushTriggerDecision {
    if (params.mountSettleStable) {
        return { type: 'flush-pending' };
    }
    if (!params.mountSettleDeadlineReached) {
        return { type: 'noop' };
    }
    if (params.autoPinSuppressed || params.hasInitialViewportApplied) {
        return { type: 'noop' };
    }
    return { type: 'request-pending-flush' };
}

export type NativeMountSettleIntervalDecision =
    | Readonly<{ type: 'continue' }>
    | Readonly<{ type: 'stable' }>
    | Readonly<{
        requestPendingFlush: boolean;
        type: 'deadline';
    }>;

export function resolveNativeMountSettleIntervalDecision(params: Readonly<{
    autoPinSuppressed: boolean;
    deadlineMs: number;
    nowMs: number;
    stableSettle: boolean;
}>): NativeMountSettleIntervalDecision {
    if (params.stableSettle) {
        return { type: 'stable' };
    }
    if (params.nowMs < params.deadlineMs) {
        return { type: 'continue' };
    }
    return {
        requestPendingFlush: !params.autoPinSuppressed,
        type: 'deadline',
    };
}

export type NativeMeasuredBottomPinPreflightDecision =
    | Readonly<{ type: 'blocked' }>
    | Readonly<{ type: 'defer-for-mount-settle' }>
    | Readonly<{ type: 'continue' }>;

export function resolveNativeMeasuredBottomPinPreflightDecision(params: Readonly<{
    autoPinDelayMs: number;
    canAutoFollow: boolean;
    forceMountSettle: boolean;
    hasRearmedBottomFollow: boolean;
    isExplicitNativeCommand: boolean;
    isJumpToSeqActive: boolean;
    isMountSettleActive: boolean;
    lastUserScrollIntentAtMs: number;
    mountSettleDeadlineReached: boolean;
    nowMs: number;
    reason: TranscriptViewportTelemetryScrollReason;
    skipAutomaticNativeJsPin: boolean;
    usesNativeFlashListBottomMaintenance: boolean;
}>): NativeMeasuredBottomPinPreflightDecision {
    if (!params.usesNativeFlashListBottomMaintenance) return { type: 'blocked' };
    if (params.isJumpToSeqActive && params.reason !== 'jump-to-seq') return { type: 'blocked' };
    if (!params.canAutoFollow) return { type: 'blocked' };
    if (
        !params.isExplicitNativeCommand &&
        !params.hasRearmedBottomFollow &&
        params.nowMs - params.lastUserScrollIntentAtMs < params.autoPinDelayMs
    ) {
        return { type: 'blocked' };
    }
    if (
        !params.skipAutomaticNativeJsPin &&
        !params.isExplicitNativeCommand &&
        !params.forceMountSettle &&
        params.isMountSettleActive &&
        !params.mountSettleDeadlineReached
    ) {
        return { type: 'defer-for-mount-settle' };
    }
    return { type: 'continue' };
}

export type NativeMeasuredBottomPinMetricsDecision =
    | Readonly<{
        reason: 'missing-content-measurement' | 'invalid-layout-height' | 'invalid-content-height';
        type: 'not-ready';
    }>
    | Readonly<{
        bottomOffsetPx: number;
        contentHeight: number;
        layoutHeight: number;
        type: 'ready';
    }>;

export function resolveNativeMeasuredBottomPinMetricsDecision(params: Readonly<{
    contentHeight: number;
    hasContentMeasurement: boolean;
    layoutHeight: number;
}>): NativeMeasuredBottomPinMetricsDecision {
    if (!params.hasContentMeasurement) {
        return {
            reason: 'missing-content-measurement',
            type: 'not-ready',
        };
    }
    if (!isFiniteNumber(params.layoutHeight) || params.layoutHeight <= 0) {
        return {
            reason: 'invalid-layout-height',
            type: 'not-ready',
        };
    }
    if (!isFiniteNumber(params.contentHeight) || params.contentHeight <= 0) {
        return {
            reason: 'invalid-content-height',
            type: 'not-ready',
        };
    }
    return {
        bottomOffsetPx: Math.max(0, Math.trunc(params.contentHeight - params.layoutHeight)),
        contentHeight: params.contentHeight,
        layoutHeight: params.layoutHeight,
        type: 'ready',
    };
}

export type NativeInvertedFollowBottomPinDecision =
    | Readonly<{ type: 'continue' }>
    | Readonly<{
        clearPendingMountSettleBottomPin: boolean;
        issuePinBottomCommand: boolean;
        markInitialViewportApplied: boolean;
        type: 'handled';
    }>;

export function resolveNativeInvertedFollowBottomPinDecision(params: Readonly<{
    bottomFollowMode: TranscriptBottomFollowMode;
    distanceFromBottom: number | null;
    forceFollowPin: boolean;
    hasInitialViewportApplied: boolean;
    invertedFirstPaintEstablishesBottom: boolean;
    pinThresholdPx: number;
    wantsPinned: boolean;
}>): NativeInvertedFollowBottomPinDecision {
    if (!params.invertedFirstPaintEstablishesBottom) return { type: 'continue' };
    if (!params.wantsPinned) return { type: 'continue' };
    if (params.bottomFollowMode !== 'following') return { type: 'continue' };

    return {
        clearPendingMountSettleBottomPin: !params.hasInitialViewportApplied,
        issuePinBottomCommand:
            params.forceFollowPin ||
            (params.distanceFromBottom != null && params.distanceFromBottom > params.pinThresholdPx),
        markInitialViewportApplied: !params.hasInitialViewportApplied,
        type: 'handled',
    };
}

export type NativeContentMaterializationAutoPin = Readonly<{
    contentHeight: number;
    sessionId: string;
}>;

export function resolveNativeContentMaterializationAutoPin(params: Readonly<{
    contentHeight: number;
    hasInitialViewportApplied: boolean;
    isNative: boolean;
    lastBottomFollowPinCommandSessionId: string | null | undefined;
    layoutHeight: number;
    pinThresholdPx: number;
    previousContentHeight: number;
    reason: TranscriptViewportTelemetryScrollReason;
    sessionId: string;
    usesNativeFlashListBottomMaintenance: boolean;
    wantsPinned: boolean;
}>): NativeContentMaterializationAutoPin | null {
    if (!params.isNative || !params.usesNativeFlashListBottomMaintenance) return null;
    if (params.reason !== 'content-size-change') return null;
    if (!params.wantsPinned) return null;
    if (
        !params.hasInitialViewportApplied &&
        params.lastBottomFollowPinCommandSessionId !== params.sessionId
    ) {
        return null;
    }
    if (!isFiniteNumber(params.contentHeight)) return null;
    if (!isFiniteNumber(params.previousContentHeight) || params.previousContentHeight <= 0) return null;
    if (!isFiniteNumber(params.layoutHeight) || params.layoutHeight <= 0) return null;

    const deltaHeight = params.contentHeight - params.previousContentHeight;
    if (deltaHeight < params.layoutHeight) return null;

    const previousTargetOffsetY = Math.max(0, Math.trunc(params.previousContentHeight - params.layoutHeight));
    if (previousTargetOffsetY > Math.max(params.pinThresholdPx, params.layoutHeight * 0.5)) return null;

    return {
        contentHeight: params.contentHeight,
        sessionId: params.sessionId,
    };
}

export function shouldSkipNativeDefaultMaterializationPin(params: Readonly<{
    contentHeight: number;
    isExplicitNativeCommand: boolean;
    materializationAutoPin: NativeContentMaterializationAutoPin | null | undefined;
    reason: TranscriptViewportTelemetryScrollReason;
    sessionId: string;
    skipAutomaticNativeJsPin: boolean;
}>): boolean {
    if (params.skipAutomaticNativeJsPin) return false;
    if (params.isExplicitNativeCommand) return false;
    if (params.reason === 'content-size-change') {
        return !(
            params.materializationAutoPin?.sessionId === params.sessionId &&
            params.materializationAutoPin.contentHeight === params.contentHeight
        );
    }
    return params.reason === 'initial-open' || params.reason === 'layout-change';
}

export type NativeContentMaterializationAutoPinPostSuccessDecision = Readonly<{
    clearMaterializationAutoPin: boolean;
}>;

export function resolveNativeContentMaterializationAutoPinPostSuccessDecision(params: Readonly<{
    reason: TranscriptViewportTelemetryScrollReason;
}>): NativeContentMaterializationAutoPinPostSuccessDecision {
    return {
        clearMaterializationAutoPin: params.reason === 'content-size-change',
    };
}

export type NativeAutomaticPinOwnership = Readonly<{
    invertedFirstPaintEstablishesBottom: boolean;
    skipJsPin: boolean;
}>;

export function resolveNativeAutomaticPinOwnership(params: Readonly<{
    isExplicitNativeCommand: boolean;
    reason: TranscriptViewportTelemetryScrollReason;
}>): NativeAutomaticPinOwnership {
    if (params.isExplicitNativeCommand) {
        return {
            invertedFirstPaintEstablishesBottom: false,
            skipJsPin: false,
        };
    }
    return {
        invertedFirstPaintEstablishesBottom: true,
        skipJsPin: true,
    };
}

export type NativeAutomaticPinRetryGuards = Readonly<{
    shouldRetryUnobservedBottomPin: boolean;
    shouldSkipDuplicateAutomaticRetryUntilObserved: boolean;
    shouldSkipLateInitialOpenAfterAutomaticNativePin: boolean;
    shouldSkipUnstableAutomaticRetryUntilObserved: boolean;
}>;

export function resolveNativeAutomaticPinRetryGuards(params: Readonly<{
    forceMountSettle: boolean;
    hasInitialViewportApplied: boolean;
    isExplicitNativeCommand: boolean;
    lastNativePinOffset: number | null | undefined;
    nativeAutomaticBottomPinCommandSessionId: string | null | undefined;
    nativeMountSettleStable: boolean;
    offset: number;
    pendingMountSettleBottomPin: boolean;
    reason: TranscriptViewportTelemetryScrollReason;
    sessionId: string;
    skipAutomaticNativeJsPin: boolean;
}>): NativeAutomaticPinRetryGuards {
    const isAutomaticJsOwnedPin = !params.skipAutomaticNativeJsPin && !params.isExplicitNativeCommand;
    const hasPositiveOffset = params.offset > 0;
    return {
        shouldRetryUnobservedBottomPin:
            hasPositiveOffset &&
            params.pendingMountSettleBottomPin &&
            !params.hasInitialViewportApplied &&
            params.nativeMountSettleStable,
        shouldSkipDuplicateAutomaticRetryUntilObserved:
            isAutomaticJsOwnedPin &&
            !params.forceMountSettle &&
            hasPositiveOffset &&
            params.pendingMountSettleBottomPin &&
            params.lastNativePinOffset != null &&
            (
                params.lastNativePinOffset === params.offset ||
                params.reason === 'initial-open'
            ),
        shouldSkipLateInitialOpenAfterAutomaticNativePin:
            isAutomaticJsOwnedPin &&
            params.reason === 'initial-open' &&
            params.nativeAutomaticBottomPinCommandSessionId === params.sessionId,
        shouldSkipUnstableAutomaticRetryUntilObserved:
            isAutomaticJsOwnedPin &&
            hasPositiveOffset &&
            params.pendingMountSettleBottomPin &&
            params.reason === 'initial-open',
    };
}

export type NativeMeasuredBottomPinPreAutoFollowDecision =
    | Readonly<{
        setPendingMountSettleBottomPin: boolean;
        type: 'skip-pin';
    }>
    | Readonly<{
        shouldRetryUnobservedBottomPin: boolean;
        type: 'continue';
    }>;

export function resolveNativeMeasuredBottomPinPreAutoFollowDecision(params: Readonly<{
    contentHeight: number;
    forceMountSettle: boolean;
    hasInitialViewportApplied: boolean;
    isExplicitNativeCommand: boolean;
    lastNativePinOffset: number | null | undefined;
    materializationAutoPin: NativeContentMaterializationAutoPin | null | undefined;
    nativeAutomaticBottomPinCommandSessionId: string | null | undefined;
    nativeMountSettleStable: boolean;
    offset: number;
    pendingMountSettleBottomPin: boolean;
    reason: TranscriptViewportTelemetryScrollReason;
    sessionId: string;
    skipAutomaticNativeJsPin: boolean;
}>): NativeMeasuredBottomPinPreAutoFollowDecision {
    const automaticPinRetryGuards = resolveNativeAutomaticPinRetryGuards({
        forceMountSettle: params.forceMountSettle,
        hasInitialViewportApplied: params.hasInitialViewportApplied,
        isExplicitNativeCommand: params.isExplicitNativeCommand,
        lastNativePinOffset: params.lastNativePinOffset,
        nativeAutomaticBottomPinCommandSessionId: params.nativeAutomaticBottomPinCommandSessionId,
        nativeMountSettleStable: params.nativeMountSettleStable,
        offset: params.offset,
        pendingMountSettleBottomPin: params.pendingMountSettleBottomPin,
        reason: params.reason,
        sessionId: params.sessionId,
        skipAutomaticNativeJsPin: params.skipAutomaticNativeJsPin,
    });
    const shouldSkipDefaultNativeMaterializationPin = shouldSkipNativeDefaultMaterializationPin({
        contentHeight: params.contentHeight,
        isExplicitNativeCommand: params.isExplicitNativeCommand,
        materializationAutoPin: params.materializationAutoPin,
        reason: params.reason,
        sessionId: params.sessionId,
        skipAutomaticNativeJsPin: params.skipAutomaticNativeJsPin,
    });
    if (
        shouldSkipDefaultNativeMaterializationPin ||
        automaticPinRetryGuards.shouldSkipUnstableAutomaticRetryUntilObserved ||
        automaticPinRetryGuards.shouldSkipLateInitialOpenAfterAutomaticNativePin ||
        automaticPinRetryGuards.shouldSkipDuplicateAutomaticRetryUntilObserved
    ) {
        return {
            setPendingMountSettleBottomPin: !params.hasInitialViewportApplied,
            type: 'skip-pin',
        };
    }
    return {
        shouldRetryUnobservedBottomPin: automaticPinRetryGuards.shouldRetryUnobservedBottomPin,
        type: 'continue',
    };
}

export type NativeAutomaticPinSameOffsetDecision =
    | Readonly<{ type: 'allow-pin' }>
    | Readonly<{
        markInitialViewportApplied: boolean;
        setPendingMountSettleBottomPin: boolean;
        type: 'skip-pin';
        updateInitialViewportPendingObservation: boolean;
    }>;

export function resolveNativeAutomaticPinSameOffsetDecision(params: Readonly<{
    deferInitialViewportAppliedUntilObserved: boolean;
    force: boolean;
    hasInitialViewportApplied: boolean;
    lastNativePinOffset: number | null | undefined;
    offset: number;
    pendingMountSettleBottomPin: boolean;
    reason: TranscriptViewportTelemetryScrollReason;
    shouldRetryUnobservedBottomPin: boolean;
}>): NativeAutomaticPinSameOffsetDecision {
    const sameOffset = params.lastNativePinOffset === params.offset;
    if (!params.force && sameOffset && !params.shouldRetryUnobservedBottomPin) {
        return {
            markInitialViewportApplied: !params.deferInitialViewportAppliedUntilObserved,
            setPendingMountSettleBottomPin:
                params.deferInitialViewportAppliedUntilObserved && params.offset > 0,
            type: 'skip-pin',
            updateInitialViewportPendingObservation: false,
        };
    }
    if (
        params.force &&
        params.reason === 'mount-settle' &&
        params.pendingMountSettleBottomPin &&
        !params.hasInitialViewportApplied &&
        sameOffset
    ) {
        return {
            markInitialViewportApplied: false,
            setPendingMountSettleBottomPin: false,
            type: 'skip-pin',
            updateInitialViewportPendingObservation:
                params.deferInitialViewportAppliedUntilObserved && params.offset > 0,
        };
    }
    return { type: 'allow-pin' };
}

export type NativeStreamAppendPinContentVersion = Readonly<{
    contentHeight: number;
    sessionId: string;
}>;

export type NativeStreamAppendContentVersionDecision =
    | Readonly<{ type: 'allow-pin' }>
    | Readonly<{
        clearPendingMountSettleBottomPin: boolean;
        markInitialViewportApplied: boolean;
        reason: 'duplicate-stream-append-owner' | 'mount-settle-owned-by-stream-append';
        type: 'skip-pin';
    }>;

export function resolveNativeStreamAppendContentVersionDecision(params: Readonly<{
    contentHeight: number;
    isExplicitNativeCommand: boolean;
    lastStreamAppendPin: NativeStreamAppendPinContentVersion | null | undefined;
    reason: TranscriptViewportTelemetryScrollReason;
    sessionId: string;
    shouldMarkInitialViewportApplied: boolean;
    skipAutomaticNativeJsPin: boolean;
}>): NativeStreamAppendContentVersionDecision {
    const sameContentVersion =
        params.lastStreamAppendPin?.sessionId === params.sessionId &&
        params.lastStreamAppendPin.contentHeight === params.contentHeight;
    if (!sameContentVersion) return { type: 'allow-pin' };
    if (params.skipAutomaticNativeJsPin) {
        return {
            clearPendingMountSettleBottomPin: false,
            markInitialViewportApplied: false,
            reason: 'duplicate-stream-append-owner',
            type: 'skip-pin',
        };
    }
    if (!params.isExplicitNativeCommand && params.reason === 'mount-settle') {
        return {
            clearPendingMountSettleBottomPin: params.shouldMarkInitialViewportApplied,
            markInitialViewportApplied: params.shouldMarkInitialViewportApplied,
            reason: 'mount-settle-owned-by-stream-append',
            type: 'skip-pin',
        };
    }
    return { type: 'allow-pin' };
}

export function resolveNativeStreamAppendContentVersionRecord(params: Readonly<{
    contentHeight: number;
    reason: TranscriptViewportTelemetryScrollReason;
    sessionId: string;
    skipAutomaticNativeJsPin: boolean;
}>): NativeStreamAppendPinContentVersion | null {
    if (!params.skipAutomaticNativeJsPin) return null;
    if (params.reason !== 'stream-append') return null;
    return {
        contentHeight: params.contentHeight,
        sessionId: params.sessionId,
    };
}

export type NativeSuccessfulBottomPinRecords = Readonly<{
    automaticBottomPinCommandSessionId: string | null;
    bottomFollowPinCommand: Readonly<{
        offsetY: number;
        sessionId: string;
    }> | null;
    lastNativePinOffset: number | null;
}>;

export function resolveNativeSuccessfulBottomPinRecords(params: Readonly<{
    isExplicitNativeCommand: boolean;
    offset: number;
    sessionId: string;
    skipAutomaticNativeJsPin: boolean;
}>): NativeSuccessfulBottomPinRecords {
    if (params.skipAutomaticNativeJsPin) {
        return {
            automaticBottomPinCommandSessionId: null,
            bottomFollowPinCommand: null,
            lastNativePinOffset: null,
        };
    }
    if (params.isExplicitNativeCommand) {
        return {
            automaticBottomPinCommandSessionId: null,
            bottomFollowPinCommand: null,
            lastNativePinOffset: params.offset,
        };
    }
    return {
        automaticBottomPinCommandSessionId: params.sessionId,
        bottomFollowPinCommand: {
            offsetY: params.offset,
            sessionId: params.sessionId,
        },
        lastNativePinOffset: params.offset,
    };
}

export type NativeSuccessfulBottomPinInitialViewportEffects = Readonly<{
    markInitialViewportApplied: boolean;
    setPendingMountSettleBottomPin: boolean;
    updateInitialViewportPendingObservation: boolean;
}>;

const NO_NATIVE_SUCCESSFUL_BOTTOM_PIN_INITIAL_VIEWPORT_EFFECTS: NativeSuccessfulBottomPinInitialViewportEffects = {
    markInitialViewportApplied: false,
    setPendingMountSettleBottomPin: false,
    updateInitialViewportPendingObservation: false,
};

export function resolveNativeSuccessfulBottomPinInitialViewportEffects(params: Readonly<{
    deferInitialViewportAppliedUntilObserved: boolean;
    invertedFirstPaintEstablishesBottom: boolean;
    offset: number;
    shouldMarkInitialViewportApplied: boolean;
}>): NativeSuccessfulBottomPinInitialViewportEffects {
    if (
        params.shouldMarkInitialViewportApplied ||
        (
            params.deferInitialViewportAppliedUntilObserved &&
            (params.offset <= 0 || params.invertedFirstPaintEstablishesBottom)
        )
    ) {
        return {
            markInitialViewportApplied: true,
            setPendingMountSettleBottomPin: false,
            updateInitialViewportPendingObservation: false,
        };
    }
    if (
        params.deferInitialViewportAppliedUntilObserved &&
        params.offset > 0 &&
        !params.invertedFirstPaintEstablishesBottom
    ) {
        return {
            markInitialViewportApplied: false,
            setPendingMountSettleBottomPin: true,
            updateInitialViewportPendingObservation: true,
        };
    }
    return NO_NATIVE_SUCCESSFUL_BOTTOM_PIN_INITIAL_VIEWPORT_EFFECTS;
}

export type NativeMeasuredBottomPinCommandResultPostSuccessPlan = Readonly<{
    initialViewportEffects: NativeSuccessfulBottomPinInitialViewportEffects;
    materializationCleanupDecision: NativeContentMaterializationAutoPinPostSuccessDecision;
    streamAppendRecord: NativeStreamAppendPinContentVersion | null;
    successfulBottomPinRecords: NativeSuccessfulBottomPinRecords;
}>;

export type NativeMeasuredBottomPinCommandResultPlan = Readonly<{
    commandInput: Extract<TranscriptViewportControllerInput, { type: 'auto-follow' }>;
    postSuccess: NativeMeasuredBottomPinCommandResultPostSuccessPlan;
}>;

export function resolveNativeMeasuredBottomPinCommandResultPlan(params: Readonly<{
    contentHeight: number;
    deferInitialViewportAppliedUntilObserved: boolean;
    invertedFirstPaintEstablishesBottom: boolean;
    isExplicitNativeCommand: boolean;
    layoutHeight: number;
    offset: number;
    pinThresholdPx: number;
    reason: TranscriptViewportTelemetryScrollReason;
    sessionId: string;
    shouldMarkInitialViewportApplied: boolean;
    skipAutomaticNativeJsPin: boolean;
    wantsPinned: boolean;
}>): NativeMeasuredBottomPinCommandResultPlan {
    return {
        commandInput: {
            type: 'auto-follow',
            sessionId: params.sessionId,
            distanceFromBottom: Number.MAX_SAFE_INTEGER,
            pinThresholdPx: params.pinThresholdPx,
            recentUserIntent: false,
            wantsPinned: params.wantsPinned,
            reason: params.reason,
            observedContentHeightPx: params.contentHeight,
            observedLayoutHeightPx: params.layoutHeight,
            skipNativeJsPin: params.skipAutomaticNativeJsPin,
        },
        postSuccess: {
            streamAppendRecord: resolveNativeStreamAppendContentVersionRecord({
                contentHeight: params.contentHeight,
                reason: params.reason,
                sessionId: params.sessionId,
                skipAutomaticNativeJsPin: params.skipAutomaticNativeJsPin,
            }),
            successfulBottomPinRecords: resolveNativeSuccessfulBottomPinRecords({
                isExplicitNativeCommand: params.isExplicitNativeCommand,
                offset: params.offset,
                sessionId: params.sessionId,
                skipAutomaticNativeJsPin: params.skipAutomaticNativeJsPin,
            }),
            materializationCleanupDecision: resolveNativeContentMaterializationAutoPinPostSuccessDecision({
                reason: params.reason,
            }),
            initialViewportEffects: resolveNativeSuccessfulBottomPinInitialViewportEffects({
                deferInitialViewportAppliedUntilObserved: params.deferInitialViewportAppliedUntilObserved,
                invertedFirstPaintEstablishesBottom: params.invertedFirstPaintEstablishesBottom,
                offset: params.offset,
                shouldMarkInitialViewportApplied: params.shouldMarkInitialViewportApplied,
            }),
        },
    };
}

export type NativeInitialFollowBottomDecision =
    | Readonly<{ type: 'blocked' }>
    | Readonly<{ type: 'already-owned' }>
    | Readonly<{
        force: true;
        markInitialViewportApplied: 'when-scrollable';
        telemetryReason: TranscriptViewportTelemetryScrollReason;
        type: 'issue-measured-pin';
    }>;

export function resolveNativeInitialFollowBottomDecision(params: Readonly<{
    autoPinDelayMs: number;
    canAutoFollow: boolean;
    hasInitialViewportApplied: boolean;
    hasLastNativePinOffset: boolean;
    hasRearmedBottomFollow: boolean;
    isJumpToSeqActive: boolean;
    lastUserScrollIntentAtMs: number;
    nowMs: number;
    pendingMountSettleBottomPin: boolean;
    reason: TranscriptViewportTelemetryScrollReason;
    usesNativeFlashListBottomMaintenance: boolean;
}>): NativeInitialFollowBottomDecision {
    if (!params.usesNativeFlashListBottomMaintenance) return { type: 'blocked' };
    if (params.isJumpToSeqActive) return { type: 'blocked' };
    if (params.hasInitialViewportApplied) return { type: 'blocked' };
    const waitMs = resolveTranscriptAutoFollowPinWaitMs({
        autoPinDelayMs: params.autoPinDelayMs,
        canAutoFollow: params.canAutoFollow,
        hasRearmedBottomFollow: params.hasRearmedBottomFollow,
        lastUserScrollIntentAtMs: params.lastUserScrollIntentAtMs,
        nowMs: params.nowMs,
    });
    if (waitMs !== 0) return { type: 'blocked' };
    if (
        params.reason === 'initial-open' &&
        (params.pendingMountSettleBottomPin || params.hasLastNativePinOffset)
    ) {
        return { type: 'already-owned' };
    }
    return {
        force: true,
        markInitialViewportApplied: 'when-scrollable',
        telemetryReason: params.reason,
        type: 'issue-measured-pin',
    };
}
