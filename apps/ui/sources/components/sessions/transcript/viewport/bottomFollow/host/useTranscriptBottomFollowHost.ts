import * as React from 'react';
import { Platform } from 'react-native';

import { fireAndForget } from '@/utils/system/fireAndForget';
import { readNativeAbsoluteScrollOffset } from '@/components/sessions/transcript/viewport/driver/readNativeAbsoluteScrollOffset';
import type { ScrollableChatListRef } from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';
import type {
    TranscriptViewportCommand,
    TranscriptViewportControllerInput,
    TranscriptViewportMode,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type {
    NativeDragActiveMirrorApplyEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/nativeActiveMirror';
import type {
    NativeEntrySettleConfirmationEffect,
    NativeExplicitJumpConfirmationEffect,
    TranscriptLifecycleHost,
    TranscriptLifecycleHostContentGrowthLiveTailCommandPlan,
    TranscriptLifecycleHostMeasuredNativePinPlan,
    TranscriptLifecycleHostNativeMountSettlePendingPinFlushPlan,
} from '@/components/sessions/transcript/viewport/lifecycle/lifecycleHost';
import {
    isExplicitTranscriptBottomFollowCommand,
    resolveTranscriptAutoFollowPinWaitMs,
} from '@/components/sessions/transcript/scroll/transcriptAutoFollowGate';
import type {
    TranscriptBottomFollowModeState,
    TranscriptScrollPinState,
} from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import { resolveTranscriptScrollPinStateUpdate } from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import type {
    TranscriptViewportTelemetryEvent,
    TranscriptViewportTelemetryScrollReason,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import {
    getWebTranscriptDistanceFromBottom,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import {
    planBottomFollowWriteSchedulerEvent,
    type BottomFollowAutomaticWriter,
    type BottomFollowScheduledWrite,
    type BottomFollowWriteSchedulerEffect,
    type BottomFollowWriteSchedulerState,
} from '@/components/sessions/transcript/viewport/bottomFollow/writeScheduler';
import { useExplicitJumpWriteBarrier } from '@/components/sessions/transcript/viewport/bottomFollow/explicitJumpWriteBarrier';
import {
    resolveNativeBottomFollowPreviousFollow,
    resolveNativeContentMaterializationAutoPin,
    resolveNativeInitialFollowBottomDecision,
    resolveNativeMountSettleBottomPinRetention,
    resolveNativeMountSettlePassiveDriftRepinDistanceDecision,
    resolveNativeMountSettlePassiveDriftRepinEffects,
    resolveNativeMountSettlePassiveDriftRepinPreflightDecision,
    resolveNativeMountSettlePendingFlushTriggerDecision,
    type NativeContentMaterializationAutoPin,
    type NativeContentMaterializationAutoPinPostSuccessDecision,
    type NativeInitialFollowBottomDecision,
    type NativeMountSettlePassiveDriftRepinEffect,
    type NativeMountSettlePendingFlushTriggerDecision,
    type NativeStreamAppendPinContentVersion,
    type NativeSuccessfulBottomPinInitialViewportEffects,
    type NativeSuccessfulBottomPinRecords,
} from '@/components/sessions/transcript/viewport/nativeBottomFollowObservationPolicy';

type MutableRef<T> = { current: T };

type ContentGrowthLiveTailCommandApplyEffect =
    NonNullable<TranscriptLifecycleHostContentGrowthLiveTailCommandPlan['contentGrowthLiveTailCommandEffect']>;
type NativeMeasuredPinPlan = TranscriptLifecycleHostMeasuredNativePinPlan;
type NativeMeasuredPinIssuePlan = Extract<NativeMeasuredPinPlan, { type: 'issue-command' }>;
type NativeMeasuredBottomPinCommandResultPlan = NativeMeasuredPinIssuePlan['commandPlan'];
type NativeMeasuredBottomPinCommandResultPostSuccessPlan = NativeMeasuredBottomPinCommandResultPlan['postSuccess'];
type NativeInvertedFollowBottomPinDecision = NativeMeasuredPinIssuePlan['invertedFollowBottomDecision'];
type NativeMeasuredBottomPinPreAutoFollowDecision = NativeMeasuredPinIssuePlan['preAutoFollowDecision'];
type NativeAutomaticPinSameOffsetDecision = NativeMeasuredPinIssuePlan['sameOffsetDecision'];
type NativeStreamAppendContentVersionDecision = NativeMeasuredPinIssuePlan['streamAppendDecision'];
type NativeMountSettlePendingPinFlushPlan = TranscriptLifecycleHostNativeMountSettlePendingPinFlushPlan;
type ScheduledPinToBottom = BottomFollowScheduledWrite<WebTranscriptScrollMetrics> & { id: any };

const TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS = 250;
const WEB_PASSIVE_LIVE_TAIL_CORRECTION_MIN_INTERVAL_MS = 400;

type BottomFollowLifecycleHost = Pick<
    TranscriptLifecycleHost,
    | 'clearNativeExplicitJumpConfirmation'
    | 'getMountSettleSnapshot'
    | 'observeNativeScrollConfirmation'
    | 'planContentGrowthLiveTailCommand'
    | 'planFollowBottomIntentTakeover'
    | 'planMeasuredNativeLiveTailPin'
    | 'planNativeMountSettlePendingPinFlush'
>;

type LiveTailCarveTelemetry = {
    active: boolean;
    anchorId: string | null;
    anchorKind: string | null;
    coldCount: number;
    hotCount: number;
};

export type TranscriptBottomFollowHostDeps = Readonly<{
    applyFollowBottomIntentTakeoverApplyEffects(effects: readonly unknown[]): void;
    applyNativeExplicitJumpConfirmationEffects(effects: readonly NativeExplicitJumpConfirmationEffect[]): void;
    canAutoFollowForReason(
        reason: TranscriptViewportTelemetryScrollReason,
        options?: Readonly<{ explicit?: boolean }>,
    ): boolean;
    commitBottomFollowModeState(next: TranscriptBottomFollowModeState): void;
    commitExplicitReturnToLiveTailState(reason: TranscriptViewportTelemetryScrollReason | 'follow-bottom-intent'): void;
    commitScrollPinState(next: TranscriptScrollPinState): void;
    currentBottomFollowModeStateRef: MutableRef<TranscriptBottomFollowModeState>;
    executeViewportCommand(command: TranscriptViewportCommand): boolean;
    authorizeImmediateBottomFollowWriteRef: MutableRef<(
        writer: BottomFollowAutomaticWriter,
        reason: TranscriptViewportTelemetryScrollReason,
    ) => boolean>;
    followBottomIntentKey: string | number | null | undefined;
    hasNativeContentMeasurementForCurrentSession(): boolean;
    hasNativeInitialViewportAppliedForCurrentSession(): boolean;
    hasRearmedNativeBottomFollow(): boolean;
    invalidateViewportAnchorCapture(): void;
    isPinnedRef: MutableRef<boolean>;
    jumpToSeq: number | null | undefined;
    lastUserScrollIntentAtMsRef: MutableRef<number>;
    lastNativePinOffsetRef: MutableRef<number | null>;
    latestCommittedActivityKey: string | null | undefined;
    lifecycleHost: BottomFollowLifecycleHost;
    liveTailCarveTelemetry: LiveTailCarveTelemetry;
    listContentHeightRef: MutableRef<number>;
    listLayoutHeightRef: MutableRef<number>;
    listRef: MutableRef<ScrollableChatListRef | null>;
    markNativeInitialViewportAppliedForCurrentSession(): void;
    nativeMountSettleAutoPinSuppressedRef: MutableRef<boolean>;
    nativeMountSettleDeadlineReached: boolean;
    nativeMountSettleDeadlineReachedRef: MutableRef<boolean>;
    nativeHotTailHeightRef: MutableRef<number>;
    nativeHotTailResetRequired: boolean;
    nativeMountSettleStable: boolean;
    observeNativeStreamAppendOffsetEscape(params: Readonly<{ contentHeight: number; layoutHeight: number }>): boolean;
    pinEnabled: boolean;
    pinThresholdPx: number;
    pinThresholdPxRef: MutableRef<number>;
    readCurrentNativeDistanceFromBottom(): number | null;
    readViewportContentMetrics(): { contentHeight: number; layoutHeight: number } | null;
    recordViewportTelemetryEvent(
        event: Readonly<Record<string, unknown> & {
            mode: TranscriptViewportMode;
            type: TranscriptViewportTelemetryEvent['type'];
        }>,
        options?: Readonly<{ sessionId?: string }>,
    ): void;
    requestBottomFollowScheduledWriteRef: MutableRef<(
        previousWebMetrics?: WebTranscriptScrollMetrics | null,
        reason?: TranscriptViewportTelemetryScrollReason,
        nativePrevFollowAtBottom?: boolean,
        writer?: BottomFollowAutomaticWriter,
    ) => void>;
    resolveViewportCommand(input: TranscriptViewportControllerInput): TranscriptViewportCommand;
    resolveViewportTelemetryMode(): TranscriptViewportMode;
    resolveWebScrollMetrics(): WebTranscriptScrollMetrics | null;
    scrollPinRef: MutableRef<TranscriptScrollPinState>;
    sessionId: string;
    tryPinToBottomDom(reason?: TranscriptViewportTelemetryScrollReason): boolean;
    updateNativeInitialViewportPendingObservation(pending: boolean): void;
    usesNativeFlashListBottomMaintenance: boolean;
    wantsPinnedRef: MutableRef<boolean>;
}>;

export type TranscriptBottomFollowHost = Readonly<{
    applyNativeDragActiveMirrorEffects(effects: readonly NativeDragActiveMirrorApplyEffect[]): void;
    applyNativeMountSettlePassiveDriftRepinObservation(params: Readonly<{
        bottomFollowMode: TranscriptBottomFollowModeState['mode'];
        isTrusted: boolean;
        nowMs: number;
        pinThresholdPx: number;
        usesNativeFlashListBottomMaintenance: boolean;
        wantsPinned: boolean;
    }>): void;
    applyWebPassiveLiveTailCorrectionEffect(effect: Readonly<{
        reason: TranscriptViewportTelemetryScrollReason;
        sessionId: string;
    }>): boolean;
    beginExplicitJumpWriteBarrier(): void;
    cancelScheduledPinToBottom(): void;
    captureNativeBottomFollowPreviousFollow(): boolean;
    captureWebBottomFollowPreviousMetrics(): WebTranscriptScrollMetrics | null;
    clearPendingNativeMountSettleBottomPin(): void;
    deferPinToBottomAfterScroll(reason: TranscriptViewportTelemetryScrollReason): void;
    endExplicitJumpWriteBarrier(): void;
    getGestureActive(): boolean;
    getPendingNativeMountSettleBottomPin(): boolean;
    handleNativeHotTailHeightChange(height: number): void;
    flushPendingNativeMountSettleBottomPin(): void;
    lastNativePinOffsetRef: MutableRef<number | null>;
    nativeHotTailHeightRef: MutableRef<number>;
    observeNativeConfirmation(params: Readonly<{
        contentHeight: number;
        distanceFromBottom: number;
        isTrusted: boolean;
        mountSettleStable: boolean;
    }>): boolean;
    pendingNativeMountSettleBottomPinRef: MutableRef<boolean>;
    pinNativeFlashListToBottomIfMeasured(options?: {
        force?: boolean;
        markInitialViewportApplied?: 'always' | 'when-scrollable';
        telemetryReason?: TranscriptViewportTelemetryScrollReason;
        forceFollowPin?: boolean;
    }): boolean;
    pinNativeInitialFollowBottomViewportIfReady(reason?: TranscriptViewportTelemetryScrollReason): boolean;
    pinToBottom(reason?: TranscriptViewportTelemetryScrollReason): boolean;
    pinToBottomRespectingNativeMountSettle(reason?: TranscriptViewportTelemetryScrollReason, forceFollowPin?: boolean): void;
    prepareNativeContentMaterializationAutoPin(observation: Readonly<{
        measuredContentHeight: number;
        previousMeasuredContentHeight: number;
        reason: TranscriptViewportTelemetryScrollReason;
    }>): void;
    requestAutomaticLiveTailPin(
        previousWebMetrics?: WebTranscriptScrollMetrics | null,
        reason?: TranscriptViewportTelemetryScrollReason,
        nativePrevFollowAtBottom?: boolean,
    ): boolean;
    requestMeasuredNativeAutomaticLiveTailPin(reason?: TranscriptViewportTelemetryScrollReason): boolean;
    resetNativeHotTailHeight(): void;
    resetPinRecordsForSessionEntry(latestCommittedActivityKey: string | null | undefined): void;
    resetPinStateForSessionOpenArm(latestCommittedActivityKey: string | null | undefined): void;
    resolveInvertedBottomPinCarveTelemetryFields(): Record<string, unknown>;
    setPendingNativeMountSettleBottomPin(value: boolean): void;
    updateLiveTailCarveTelemetry(next: LiveTailCarveTelemetry): void;
}>;

export function useTranscriptBottomFollowHost(deps: TranscriptBottomFollowHostDeps): TranscriptBottomFollowHost {
    const {
        applyFollowBottomIntentTakeoverApplyEffects,
        applyNativeExplicitJumpConfirmationEffects,
        canAutoFollowForReason,
        commitBottomFollowModeState,
        commitExplicitReturnToLiveTailState,
        commitScrollPinState,
        currentBottomFollowModeStateRef,
        executeViewportCommand,
        authorizeImmediateBottomFollowWriteRef: externalAuthorizeImmediateBottomFollowWriteRef,
        followBottomIntentKey,
        hasNativeContentMeasurementForCurrentSession,
        hasNativeInitialViewportAppliedForCurrentSession,
        hasRearmedNativeBottomFollow,
        invalidateViewportAnchorCapture,
        isPinnedRef,
        jumpToSeq,
        lastUserScrollIntentAtMsRef,
        lastNativePinOffsetRef,
        latestCommittedActivityKey,
        lifecycleHost,
        liveTailCarveTelemetry,
        listContentHeightRef,
        listLayoutHeightRef,
        listRef,
        markNativeInitialViewportAppliedForCurrentSession,
        nativeMountSettleAutoPinSuppressedRef,
        nativeMountSettleDeadlineReached,
        nativeMountSettleDeadlineReachedRef,
        nativeHotTailHeightRef,
        nativeHotTailResetRequired,
        nativeMountSettleStable,
        observeNativeStreamAppendOffsetEscape,
        pinEnabled,
        pinThresholdPx,
        pinThresholdPxRef,
        readCurrentNativeDistanceFromBottom,
        readViewportContentMetrics,
        recordViewportTelemetryEvent,
        requestBottomFollowScheduledWriteRef,
        resolveViewportCommand,
        resolveViewportTelemetryMode,
        resolveWebScrollMetrics,
        scrollPinRef,
        sessionId,
        tryPinToBottomDom,
        updateNativeInitialViewportPendingObservation,
        usesNativeFlashListBottomMaintenance,
        wantsPinnedRef,
    } = deps;

    const lastNativeBottomFollowPinCommandRef = React.useRef<{
        sessionId: string;
        offsetY: number;
        writtenAtMs: number;
    } | null>(null);
    const nativeAutomaticBottomPinCommandSessionRef = React.useRef<string | null>(null);
    const nativeContentMaterializationAutoPinRef = React.useRef<NativeContentMaterializationAutoPin | null>(null);
    const lastNativeStreamAppendPinRef = React.useRef<NativeStreamAppendPinContentVersion | null>(null);
    const pendingNativeMountSettleBottomPinRef = React.useRef(false);
    const flushPendingNativeMountSettleBottomPinRef = React.useRef<(() => void) | null>(null);
    const liveTailCarveTelemetryRef = React.useRef<LiveTailCarveTelemetry>({
        active: false,
        anchorId: null,
        anchorKind: null,
        coldCount: 0,
        hotCount: 0,
    });
    const pinNativeLiveTailForHotTailHeightRef = React.useRef<((height: number) => void) | null>(null);
    const scheduledPinRef = React.useRef<ScheduledPinToBottom | null>(null);
    const bottomFollowWriteSchedulerStateRef = React.useRef<BottomFollowWriteSchedulerState<WebTranscriptScrollMetrics>>({
        explicitJumpActive: false,
        gestureActive: false,
        pending: null,
    });
    const scheduleBottomFollowWriteTimerRef =
        React.useRef<((write: BottomFollowScheduledWrite<WebTranscriptScrollMetrics>) => void) | null>(null);

    liveTailCarveTelemetryRef.current = liveTailCarveTelemetry;

    React.useLayoutEffect(() => {
        if (!nativeHotTailResetRequired) return;
        nativeHotTailHeightRef.current = 0;
    }, [nativeHotTailResetRequired]);

    const resolveInvertedBottomPinCarveTelemetryFields = React.useCallback((): Record<string, unknown> => {
        const carve = liveTailCarveTelemetryRef.current;
        if (!carve.active) return {};
        return {
            liveRegionActive: true,
            nativeHotTailHeightPx: nativeHotTailHeightRef.current,
            nativeCarvePinIssued: true,
            ...(carve.anchorId ? { liveTailAnchorId: carve.anchorId } : {}),
            ...(carve.anchorKind ? { liveTailAnchorKind: carve.anchorKind } : {}),
            coldCount: carve.coldCount,
            hotCount: carve.hotCount,
        };
    }, []);

    const cancelScheduledPinToBottom = React.useCallback(() => {
        pendingNativeMountSettleBottomPinRef.current = false;
        bottomFollowWriteSchedulerStateRef.current = {
            ...bottomFollowWriteSchedulerStateRef.current,
            pending: null,
        };
        const scheduled = scheduledPinRef.current;
        if (!scheduled) return;
        scheduledPinRef.current = null;
        if (scheduled.kind === 'raf') {
            const caf = (globalThis as any)?.cancelAnimationFrame as undefined | ((id: any) => void);
            if (typeof caf === 'function') {
                caf(scheduled.id);
            }
            return;
        }
        clearTimeout(scheduled.id);
    }, []);

    const captureWebBottomFollowPreviousMetrics = React.useCallback((): WebTranscriptScrollMetrics | null => {
        if (Platform.OS !== 'web') return null;
        const metrics = resolveWebScrollMetrics();
        if (!metrics) return null;
        return {
            ...metrics,
            clientHeight: listLayoutHeightRef.current > 0 ? listLayoutHeightRef.current : metrics.clientHeight,
            scrollHeight: listContentHeightRef.current > 0 ? listContentHeightRef.current : metrics.scrollHeight,
        };
    }, [
        listContentHeightRef,
        listLayoutHeightRef,
        resolveWebScrollMetrics,
    ]);

    const captureNativeBottomFollowPreviousFollow = React.useCallback((): boolean => {
        return resolveNativeBottomFollowPreviousFollow({
            autoPinDelayMs: TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS,
            bottomFollowMode: currentBottomFollowModeStateRef.current.mode,
            isNative: Platform.OS !== 'web',
            lastUserScrollIntentAtMs: lastUserScrollIntentAtMsRef.current,
            nativeHotTailHeightPx: nativeHotTailHeightRef.current,
            nowMs: Date.now(),
            usesNativeFlashListBottomMaintenance,
            wantsPinned: wantsPinnedRef.current,
        });
    }, [
        currentBottomFollowModeStateRef,
        lastUserScrollIntentAtMsRef,
        usesNativeFlashListBottomMaintenance,
        wantsPinnedRef,
    ]);

    const applyWebBottomFollowAdjustment = React.useCallback((
        previousMetrics: WebTranscriptScrollMetrics,
        reason: TranscriptViewportTelemetryScrollReason = 'content-size-change',
        authority?: Readonly<{ reason: TranscriptViewportTelemetryScrollReason; writer: BottomFollowAutomaticWriter }>,
    ): boolean => {
        if (Platform.OS !== 'web') return false;
        return executeViewportCommand(resolveViewportCommand({
            type: 'preserve-live-tail-distance',
            sessionId,
            previousDistanceFromLiveTailPx: getWebTranscriptDistanceFromBottom(previousMetrics),
            pinThresholdPx,
            recentUserIntent: Date.now() - lastUserScrollIntentAtMsRef.current < TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS,
            wantsPinned: wantsPinnedRef.current,
            reason,
            schedulerAuthorityReason: authority?.reason,
            schedulerAuthorityWriter: authority?.writer,
        }));
    }, [
        executeViewportCommand,
        lastUserScrollIntentAtMsRef,
        pinThresholdPx,
        resolveViewportCommand,
        sessionId,
        wantsPinnedRef,
    ]);

    const applyNativeInvertedFollowBottomPinDecision = React.useCallback((
        decision: NativeInvertedFollowBottomPinDecision,
        reason: TranscriptViewportTelemetryScrollReason,
    ): boolean => {
        if (decision.type !== 'handled') return false;
        if (decision.clearPendingMountSettleBottomPin) {
            pendingNativeMountSettleBottomPinRef.current = false;
        }
        if (decision.markInitialViewportApplied) {
            markNativeInitialViewportAppliedForCurrentSession();
        }
        if (decision.issuePinBottomCommand) {
            executeViewportCommand(resolveViewportCommand({
                type: 'pin-bottom',
                sessionId,
                reason,
                mode: 'follow-bottom',
                animated: false,
            }));
        }
        return true;
    }, [
        executeViewportCommand,
        markNativeInitialViewportAppliedForCurrentSession,
        resolveViewportCommand,
        sessionId,
    ]);

    const applyNativeMeasuredBottomPinPreAutoFollowDecision = React.useCallback((
        decision: NativeMeasuredBottomPinPreAutoFollowDecision,
    ): decision is Extract<NativeMeasuredBottomPinPreAutoFollowDecision, { type: 'skip-pin' }> => {
        if (decision.type !== 'skip-pin') return false;
        if (decision.setPendingMountSettleBottomPin) {
            pendingNativeMountSettleBottomPinRef.current = true;
        }
        return true;
    }, []);

    const applyNativeAutomaticPinSameOffsetDecision = React.useCallback((
        decision: NativeAutomaticPinSameOffsetDecision,
    ): boolean => {
        if (decision.type !== 'skip-pin') return false;
        if (decision.markInitialViewportApplied) {
            markNativeInitialViewportAppliedForCurrentSession();
        }
        if (decision.setPendingMountSettleBottomPin) {
            pendingNativeMountSettleBottomPinRef.current = true;
        }
        if (decision.updateInitialViewportPendingObservation) {
            updateNativeInitialViewportPendingObservation(true);
        }
        return true;
    }, [
        markNativeInitialViewportAppliedForCurrentSession,
        updateNativeInitialViewportPendingObservation,
    ]);

    const applyNativeStreamAppendContentVersionDecision = React.useCallback((
        decision: NativeStreamAppendContentVersionDecision,
    ): boolean => {
        if (decision.type !== 'skip-pin') return false;
        if (decision.clearPendingMountSettleBottomPin) {
            pendingNativeMountSettleBottomPinRef.current = false;
        }
        if (decision.markInitialViewportApplied) {
            markNativeInitialViewportAppliedForCurrentSession();
        }
        return true;
    }, [
        markNativeInitialViewportAppliedForCurrentSession,
    ]);

    const applyNativeStreamAppendContentVersionRecord = React.useCallback((
        record: NativeStreamAppendPinContentVersion | null,
    ): void => {
        if (!record) return;
        lastNativeStreamAppendPinRef.current = record;
    }, []);

    const applyNativeSuccessfulBottomPinRecords = React.useCallback((
        records: NativeSuccessfulBottomPinRecords,
    ): void => {
        if (records.lastNativePinOffset != null) {
            lastNativePinOffsetRef.current = records.lastNativePinOffset;
        }
        if (records.bottomFollowPinCommand) {
            lastNativeBottomFollowPinCommandRef.current = {
                offsetY: records.bottomFollowPinCommand.offsetY,
                sessionId: records.bottomFollowPinCommand.sessionId,
                writtenAtMs: Date.now(),
            };
        }
        if (records.automaticBottomPinCommandSessionId) {
            nativeAutomaticBottomPinCommandSessionRef.current = records.automaticBottomPinCommandSessionId;
        }
    }, []);

    const applyNativeContentMaterializationAutoPinPostSuccessDecision = React.useCallback((
        decision: NativeContentMaterializationAutoPinPostSuccessDecision,
    ): void => {
        if (decision.clearMaterializationAutoPin) {
            nativeContentMaterializationAutoPinRef.current = null;
        }
    }, []);

    const applyNativeSuccessfulBottomPinInitialViewportEffects = React.useCallback((
        effects: NativeSuccessfulBottomPinInitialViewportEffects,
    ): void => {
        if (effects.markInitialViewportApplied) {
            pendingNativeMountSettleBottomPinRef.current = false;
            markNativeInitialViewportAppliedForCurrentSession();
        }
        if (effects.setPendingMountSettleBottomPin) {
            pendingNativeMountSettleBottomPinRef.current = true;
        }
        if (effects.updateInitialViewportPendingObservation) {
            updateNativeInitialViewportPendingObservation(true);
        }
    }, [
        markNativeInitialViewportAppliedForCurrentSession,
        updateNativeInitialViewportPendingObservation,
    ]);

    const shouldDeferNativeAutomaticPinToSessionOpenLatch = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason,
    ): boolean => {
        if (Platform.OS === 'web' || !usesNativeFlashListBottomMaintenance) return false;
        if (isExplicitTranscriptBottomFollowCommand(reason)) return false;
        if (reason === 'initial-open' || reason === 'mount-settle') return false;
        const nativeSessionOpenPositioningActive =
            !nativeMountSettleStable &&
            !nativeMountSettleDeadlineReachedRef.current;
        if (
            hasNativeInitialViewportAppliedForCurrentSession() &&
            !nativeSessionOpenPositioningActive
        ) {
            return false;
        }
        return nativeSessionOpenPositioningActive;
    }, [
        hasNativeInitialViewportAppliedForCurrentSession,
        nativeMountSettleDeadlineReachedRef,
        nativeMountSettleStable,
        usesNativeFlashListBottomMaintenance,
    ]);

    const applyNativeMeasuredBottomPinPostSuccessEffects = React.useCallback((
        postSuccess: NativeMeasuredBottomPinCommandResultPostSuccessPlan,
    ): void => {
        applyNativeStreamAppendContentVersionRecord(postSuccess.streamAppendRecord);
        applyNativeSuccessfulBottomPinRecords(postSuccess.successfulBottomPinRecords);
        applyNativeContentMaterializationAutoPinPostSuccessDecision(postSuccess.materializationCleanupDecision);
        applyNativeSuccessfulBottomPinInitialViewportEffects(postSuccess.initialViewportEffects);
    }, [
        applyNativeContentMaterializationAutoPinPostSuccessDecision,
        applyNativeStreamAppendContentVersionRecord,
        applyNativeSuccessfulBottomPinInitialViewportEffects,
        applyNativeSuccessfulBottomPinRecords,
    ]);

    const applyNativeMeasuredBottomPinCommandResultPlan = React.useCallback((
        plan: NativeMeasuredBottomPinCommandResultPlan,
    ): boolean => {
        if (!executeViewportCommand(resolveViewportCommand(plan.commandInput))) {
            return false;
        }
        applyNativeMeasuredBottomPinPostSuccessEffects(plan.postSuccess);
        return true;
    }, [
        applyNativeMeasuredBottomPinPostSuccessEffects,
        executeViewportCommand,
        resolveViewportCommand,
    ]);

    const applyNativeMeasuredPinPlanResult = React.useCallback((
        plan: NativeMeasuredPinPlan,
    ): boolean => {
        if (plan.type === 'blocked') return false;
        if (plan.type === 'defer-for-mount-settle') {
            if (plan.effect.sessionId !== sessionId) return false;
            pendingNativeMountSettleBottomPinRef.current = true;
            return false;
        }
        if (plan.type === 'not-ready') return false;
        return applyNativeMeasuredBottomPinCommandResultPlan(plan.commandPlan);
    }, [
        applyNativeMeasuredBottomPinCommandResultPlan,
        sessionId,
    ]);

    const pinNativeFlashListToBottomIfMeasured = React.useCallback((options?: {
        force?: boolean;
        markInitialViewportApplied?: 'always' | 'when-scrollable';
        telemetryReason?: TranscriptViewportTelemetryScrollReason;
        forceFollowPin?: boolean;
    }): boolean => {
        const telemetryReason = options?.telemetryReason ?? 'content-size-change';
        const isExplicitNativeCommand =
            telemetryReason === 'jump-to-bottom' ||
            telemetryReason === 'jump-to-seq';
        if (options?.force !== true && shouldDeferNativeAutomaticPinToSessionOpenLatch(telemetryReason)) {
            pendingNativeMountSettleBottomPinRef.current = true;
            return false;
        }
        const viewportContentMetrics = readViewportContentMetrics();
        const shouldDeferInitialViewportAppliedUntilObserved =
            options?.markInitialViewportApplied === 'when-scrollable';
        const shouldMarkInitialViewportApplied =
            !shouldDeferInitialViewportAppliedUntilObserved;
        const measuredPinPlan = lifecycleHost.planMeasuredNativeLiveTailPin({
            autoPinDelayMs: TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS,
            bottomFollowMode: currentBottomFollowModeStateRef.current.mode,
            canAutoFollow: canAutoFollowForReason(telemetryReason, { explicit: isExplicitNativeCommand }),
            contentHeight: viewportContentMetrics?.contentHeight ?? 0,
            deferInitialViewportAppliedUntilObserved: shouldDeferInitialViewportAppliedUntilObserved,
            distanceFromBottom: readCurrentNativeDistanceFromBottom(),
            force: options?.force === true,
            forceFollowPin: options?.forceFollowPin === true,
            forceMountSettle: options?.force === true && telemetryReason === 'mount-settle',
            hasContentMeasurement: hasNativeContentMeasurementForCurrentSession(),
            hasInitialViewportApplied: hasNativeInitialViewportAppliedForCurrentSession(),
            hasRearmedBottomFollow: hasRearmedNativeBottomFollow(),
            isExplicitNativeCommand,
            isJumpToSeqActive: jumpToSeq != null,
            isMountSettleActive: lifecycleHost.getMountSettleSnapshot().isMountSettleActive === true,
            lastNativePinOffset: lastNativePinOffsetRef.current,
            lastStreamAppendPin: lastNativeStreamAppendPinRef.current,
            lastUserScrollIntentAtMs: lastUserScrollIntentAtMsRef.current,
            layoutHeight: viewportContentMetrics?.layoutHeight ?? 0,
            materializationAutoPin: nativeContentMaterializationAutoPinRef.current,
            mountSettleDeadlineReached: nativeMountSettleDeadlineReachedRef.current,
            nativeAutomaticBottomPinCommandSessionId: nativeAutomaticBottomPinCommandSessionRef.current,
            nativeMountSettleStable,
            nowMs: Date.now(),
            pendingMountSettleBottomPin: pendingNativeMountSettleBottomPinRef.current,
            pinThresholdPx,
            reason: telemetryReason,
            sessionId,
            shouldMarkInitialViewportApplied,
            usesNativeFlashListBottomMaintenance,
            wantsPinned: wantsPinnedRef.current,
        });
        if (measuredPinPlan.type === 'blocked' || measuredPinPlan.type === 'defer-for-mount-settle') {
            return applyNativeMeasuredPinPlanResult(measuredPinPlan);
        }
        if (measuredPinPlan.type === 'not-ready') return false;
        if (applyNativeInvertedFollowBottomPinDecision(
            measuredPinPlan.invertedFollowBottomDecision,
            telemetryReason,
        )) {
            return true;
        }
        if (applyNativeMeasuredBottomPinPreAutoFollowDecision(measuredPinPlan.preAutoFollowDecision)) {
            return true;
        }
        if (applyNativeAutomaticPinSameOffsetDecision(measuredPinPlan.sameOffsetDecision)) {
            return true;
        }
        if (applyNativeStreamAppendContentVersionDecision(measuredPinPlan.streamAppendDecision)) {
            return true;
        }
        return applyNativeMeasuredPinPlanResult(measuredPinPlan);
    }, [
        applyNativeAutomaticPinSameOffsetDecision,
        applyNativeInvertedFollowBottomPinDecision,
        applyNativeMeasuredBottomPinPreAutoFollowDecision,
        applyNativeMeasuredPinPlanResult,
        applyNativeStreamAppendContentVersionDecision,
        canAutoFollowForReason,
        currentBottomFollowModeStateRef,
        hasNativeContentMeasurementForCurrentSession,
        hasNativeInitialViewportAppliedForCurrentSession,
        hasRearmedNativeBottomFollow,
        jumpToSeq,
        lastUserScrollIntentAtMsRef,
        lifecycleHost,
        nativeMountSettleDeadlineReachedRef,
        nativeMountSettleStable,
        pinThresholdPx,
        readCurrentNativeDistanceFromBottom,
        readViewportContentMetrics,
        sessionId,
        shouldDeferNativeAutomaticPinToSessionOpenLatch,
        usesNativeFlashListBottomMaintenance,
        wantsPinnedRef,
    ]);

    const applyNativeEntrySettleConfirmationEffects = React.useCallback((
        effects: readonly NativeEntrySettleConfirmationEffect[],
    ) => {
        for (const effect of effects) {
            if (
                effect.type !== 'issue-entry-settle-reconfirm-pin' ||
                effect.sessionId !== sessionId
            ) {
                continue;
            }
            authorizeImmediateBottomFollowWriteRef.current('settle-reconfirm', 'mount-settle');
        }
    }, [sessionId]);

    const observeNativeConfirmation = React.useCallback((params: Readonly<{
        contentHeight: number;
        distanceFromBottom: number;
        isTrusted: boolean;
        mountSettleStable: boolean;
    }>): boolean => {
        if (Platform.OS === 'web') return false;
        const plan = lifecycleHost.observeNativeScrollConfirmation({
            bottomFollowMode: currentBottomFollowModeStateRef.current.mode,
            contentHeight: params.contentHeight,
            distanceFromBottom: params.distanceFromBottom,
            isTrusted: params.isTrusted,
            mountSettleDeadlineReached: nativeMountSettleDeadlineReachedRef.current,
            mountSettleStable: params.mountSettleStable,
            pinThresholdPx,
            sessionId,
            wantsPinned: wantsPinnedRef.current,
        });
        applyNativeExplicitJumpConfirmationEffects(plan.explicitJumpEffects);
        applyNativeEntrySettleConfirmationEffects(plan.entrySettleEffects);
        return plan.consumed;
    }, [
        applyNativeEntrySettleConfirmationEffects,
        applyNativeExplicitJumpConfirmationEffects,
        currentBottomFollowModeStateRef,
        lifecycleHost,
        nativeMountSettleDeadlineReachedRef,
        pinThresholdPx,
        sessionId,
        wantsPinnedRef,
    ]);

    const applyNativeInitialFollowBottomDecision = React.useCallback((
        decision: NativeInitialFollowBottomDecision,
    ): boolean => {
        if (decision.type === 'blocked') return false;
        if (decision.type === 'already-owned') return true;
        return pinNativeFlashListToBottomIfMeasured({
            force: decision.force,
            markInitialViewportApplied: decision.markInitialViewportApplied,
            telemetryReason: decision.telemetryReason,
        });
    }, [pinNativeFlashListToBottomIfMeasured]);

    const pinNativeInitialFollowBottomViewportIfReady = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason = 'initial-open',
    ): boolean => {
        const decision = resolveNativeInitialFollowBottomDecision({
            autoPinDelayMs: TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS,
            canAutoFollow: canAutoFollowForReason(reason),
            hasInitialViewportApplied: hasNativeInitialViewportAppliedForCurrentSession(),
            hasLastNativePinOffset: lastNativePinOffsetRef.current != null,
            hasRearmedBottomFollow: hasRearmedNativeBottomFollow(),
            isJumpToSeqActive: jumpToSeq != null,
            lastUserScrollIntentAtMs: lastUserScrollIntentAtMsRef.current,
            nowMs: Date.now(),
            pendingMountSettleBottomPin: pendingNativeMountSettleBottomPinRef.current,
            reason,
            usesNativeFlashListBottomMaintenance,
        });
        return applyNativeInitialFollowBottomDecision(decision);
    }, [
        applyNativeInitialFollowBottomDecision,
        canAutoFollowForReason,
        hasNativeInitialViewportAppliedForCurrentSession,
        hasRearmedNativeBottomFollow,
        jumpToSeq,
        lastUserScrollIntentAtMsRef,
        usesNativeFlashListBottomMaintenance,
    ]);

    const shouldKeepPendingNativeMountSettleBottomPin = React.useCallback((): boolean => {
        return resolveNativeMountSettleBottomPinRetention({
            autoPinDelayMs: TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS,
            canAutoFollowMountSettle: canAutoFollowForReason('mount-settle'),
            hasRearmedNativeBottomFollow: hasRearmedNativeBottomFollow(),
            isJumpToSeqActive: jumpToSeq != null,
            lastUserScrollIntentAtMs: lastUserScrollIntentAtMsRef.current,
            nowMs: Date.now(),
            usesNativeFlashListBottomMaintenance,
        });
    }, [
        canAutoFollowForReason,
        hasRearmedNativeBottomFollow,
        jumpToSeq,
        lastUserScrollIntentAtMsRef,
        usesNativeFlashListBottomMaintenance,
    ]);

    const applyNativeExplicitPinCommandEffects = React.useCallback((isExplicitNativeCommand: boolean): void => {
        if (!isExplicitNativeCommand) return;
        pendingNativeMountSettleBottomPinRef.current = false;
    }, []);

    const pinToBottom = React.useCallback((reason: TranscriptViewportTelemetryScrollReason = 'initial-open'): boolean => {
        if (Platform.OS === 'web') {
            if (tryPinToBottomDom(reason)) {
                return true;
            }
            return false;
        }
        if (usesNativeFlashListBottomMaintenance) {
            const isExplicitNativeCommand = isExplicitTranscriptBottomFollowCommand(reason);
            applyNativeExplicitPinCommandEffects(isExplicitNativeCommand);
            return pinNativeFlashListToBottomIfMeasured({
                force: isExplicitNativeCommand,
                telemetryReason: reason,
            });
        }
        return executeViewportCommand(resolveViewportCommand(reason === 'jump-to-bottom'
            ? {
                type: 'jump-to-bottom',
                sessionId,
            }
            : {
                type: 'pin-bottom',
                sessionId,
                reason,
                mode: reason === 'jump-to-seq' ? 'jump-to-seq' : 'follow-bottom',
                animated: false,
            }));
    }, [
        applyNativeExplicitPinCommandEffects,
        executeViewportCommand,
        pinNativeFlashListToBottomIfMeasured,
        resolveViewportCommand,
        sessionId,
        tryPinToBottomDom,
        usesNativeFlashListBottomMaintenance,
    ]);

    const lastWebPassiveCorrectionAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const applyWebPassiveLiveTailCorrectionEffect = React.useCallback((
        effect: Readonly<{ reason: TranscriptViewportTelemetryScrollReason; sessionId: string }>,
    ): boolean => {
        if (Platform.OS !== 'web') return false;
        if (effect.sessionId !== sessionId) return false;
        // Cooldown: passive corrections heal non-user drift (Legend-internal adjustments,
        // composer-resize compensation), which is one-shot per churn event — a 400ms cadence
        // heals it fully. A genuine untrusted user drag emits frames every ~16-50ms; without
        // the cooldown each correction write would reset the sustained-movement streak and an
        // untrusted scroller could never escape the pin. Between corrections the drag gets
        // >=2 uninterrupted same-direction frames, which is sustained release authority.
        const nowMs = Date.now();
        if (nowMs - lastWebPassiveCorrectionAtMsRef.current < WEB_PASSIVE_LIVE_TAIL_CORRECTION_MIN_INTERVAL_MS) {
            return false;
        }
        const applied = authorizeImmediateBottomFollowWriteRef.current('web-passive-correction', effect.reason);
        if (applied) {
            lastWebPassiveCorrectionAtMsRef.current = nowMs;
        }
        return applied;
    }, [sessionId]);

    const applyNativeMountSettleMeasuredPinResult = React.useCallback((pinApplied: boolean): boolean => {
        if (!pinApplied) return false;
        if (hasNativeInitialViewportAppliedForCurrentSession()) {
            pendingNativeMountSettleBottomPinRef.current = false;
        }
        return true;
    }, [hasNativeInitialViewportAppliedForCurrentSession]);

    const applyNativeMountSettlePendingRetentionResult = React.useCallback((shouldRetain: boolean): void => {
        if (!shouldRetain) return;
        pendingNativeMountSettleBottomPinRef.current = true;
    }, []);

    const pinToBottomRespectingNativeMountSettle = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason = 'mount-settle',
        forceFollowPin: boolean = false,
    ) => {
        if (usesNativeFlashListBottomMaintenance) {
            if (pinNativeInitialFollowBottomViewportIfReady(reason)) {
                return;
            }
            if (reason === 'initial-open') {
                return;
            }
            const measuredPinApplied = pinNativeFlashListToBottomIfMeasured({ telemetryReason: reason, forceFollowPin });
            if (applyNativeMountSettleMeasuredPinResult(measuredPinApplied)) {
                return;
            }
            applyNativeMountSettlePendingRetentionResult(shouldKeepPendingNativeMountSettleBottomPin());
            return;
        }
        pinToBottom(reason);
    }, [
        applyNativeMountSettleMeasuredPinResult,
        applyNativeMountSettlePendingRetentionResult,
        pinNativeFlashListToBottomIfMeasured,
        pinNativeInitialFollowBottomViewportIfReady,
        pinToBottom,
        shouldKeepPendingNativeMountSettleBottomPin,
        usesNativeFlashListBottomMaintenance,
    ]);

    const applyAuthorizedBottomFollowWrite = React.useCallback((
        effect: Extract<BottomFollowWriteSchedulerEffect<WebTranscriptScrollMetrics>, { type: 'authorize-write' }>,
    ): boolean => {
        switch (effect.command) {
            case 'web-bottom-follow-adjustment':
                return applyWebBottomFollowAdjustment(
                    effect.previousWebMetrics,
                    effect.reason,
                    { reason: effect.schedulerAuthorityReason, writer: effect.schedulerAuthorityWriter },
                );
            case 'native-respecting-mount-settle':
                pinToBottomRespectingNativeMountSettle(effect.reason, effect.nativePrevFollowAtBottom === true);
                return true;
            case 'pin-to-bottom':
                return pinToBottom(effect.reason);
            default:
                if (effect.writer === 'settle-reconfirm') {
                    return pinNativeFlashListToBottomIfMeasured({
                        force: true,
                        telemetryReason: effect.reason,
                    });
                }
                if (effect.writer === 'hot-tail-carve') {
                    return pinNativeFlashListToBottomIfMeasured({
                        telemetryReason: effect.reason,
                        forceFollowPin: true,
                    });
                }
                if (effect.writer === 'deferred-post-scroll' && usesNativeFlashListBottomMaintenance) {
                    return pinNativeFlashListToBottomIfMeasured({
                        force: true,
                        markInitialViewportApplied: pendingNativeMountSettleBottomPinRef.current ||
                            !hasNativeInitialViewportAppliedForCurrentSession()
                            ? 'when-scrollable'
                            : undefined,
                        telemetryReason: effect.reason,
                    });
                }
                if (effect.writer === 'passive-drift') {
                    return pinNativeFlashListToBottomIfMeasured({ telemetryReason: effect.reason });
                }
                if (effect.writer === 'blank-recovery') {
                    return executeViewportCommand(resolveViewportCommand({
                        type: 'pin-bottom',
                        sessionId,
                        reason: effect.reason,
                        mode: 'follow-bottom',
                        force: true,
                        animated: false,
                    }));
                }
                return pinToBottom(effect.reason);
        }
    }, [
        applyWebBottomFollowAdjustment,
        executeViewportCommand,
        hasNativeInitialViewportAppliedForCurrentSession,
        pinNativeFlashListToBottomIfMeasured,
        pinToBottom,
        pinToBottomRespectingNativeMountSettle,
        resolveViewportCommand,
        sessionId,
        usesNativeFlashListBottomMaintenance,
    ]);

    const applyBottomFollowWriteSchedulerEffects = React.useCallback((
        effects: readonly BottomFollowWriteSchedulerEffect<WebTranscriptScrollMetrics>[],
    ): void => {
        for (const effect of effects) {
            if (effect.type === 'cancel-scheduled-write') {
                cancelScheduledPinToBottom();
                continue;
            }
            if (effect.type === 'schedule-write') {
                scheduleBottomFollowWriteTimerRef.current?.(effect.write);
                continue;
            }
            if (effect.type === 'authorize-write') {
                if (effect.command === 'web-bottom-follow-adjustment') {
                    if (applyAuthorizedBottomFollowWrite(effect)) return;
                    continue;
                }
                applyAuthorizedBottomFollowWrite(effect);
            }
        }
    }, [
        applyAuthorizedBottomFollowWrite,
        cancelScheduledPinToBottom,
    ]);

    const authorizeImmediateBottomFollowWrite = React.useCallback((
        writer: BottomFollowAutomaticWriter,
        reason: TranscriptViewportTelemetryScrollReason,
    ): boolean => {
        const plan = planBottomFollowWriteSchedulerEvent(bottomFollowWriteSchedulerStateRef.current, {
            reason,
            type: 'authorize-immediate-write',
            writer,
        });
        bottomFollowWriteSchedulerStateRef.current = plan.state;
        applyBottomFollowWriteSchedulerEffects(plan.effects);
        return plan.effects.some((effect) => effect.type === 'authorize-write');
    }, [applyBottomFollowWriteSchedulerEffects]);

    const authorizeImmediateBottomFollowWriteRef = React.useRef(authorizeImmediateBottomFollowWrite);
    authorizeImmediateBottomFollowWriteRef.current = authorizeImmediateBottomFollowWrite;
    externalAuthorizeImmediateBottomFollowWriteRef.current = authorizeImmediateBottomFollowWrite;

    const [beginExplicitJumpWriteBarrier, endExplicitJumpWriteBarrier] = useExplicitJumpWriteBarrier({
        applyEffects: applyBottomFollowWriteSchedulerEffects,
        schedulerStateRef: bottomFollowWriteSchedulerStateRef,
    });

    const applyNativePendingMountSettleFlushCommandResult = React.useCallback((pinApplied: boolean): void => {
        if (!pinApplied) return;
        if (!hasNativeInitialViewportAppliedForCurrentSession()) return;
        pendingNativeMountSettleBottomPinRef.current = false;
    }, [hasNativeInitialViewportAppliedForCurrentSession]);

    const applyNativeMountSettlePendingPinFlushPlan = React.useCallback((
        plan: NativeMountSettlePendingPinFlushPlan,
    ): void => {
        for (const effect of plan.effects) {
            if (effect.sessionId !== sessionId) continue;
            if (effect.type === 'clear-pending-native-mount-settle-bottom-pin') {
                pendingNativeMountSettleBottomPinRef.current = false;
                continue;
            }
            if (effect.type === 'request-measured-native-live-tail-pin') {
                applyNativePendingMountSettleFlushCommandResult(pinNativeFlashListToBottomIfMeasured({
                    markInitialViewportApplied: 'when-scrollable',
                    telemetryReason: effect.reason,
                }));
            }
        }
    }, [
        applyNativePendingMountSettleFlushCommandResult,
        pinNativeFlashListToBottomIfMeasured,
        sessionId,
    ]);

    const flushPendingNativeMountSettleBottomPin = React.useCallback(() => {
        const mountSettleFlushPlan = lifecycleHost.planNativeMountSettlePendingPinFlush({
            canRetainPendingMountSettleBottomPin: shouldKeepPendingNativeMountSettleBottomPin(),
            isMountSettleActive: lifecycleHost.getMountSettleSnapshot().isMountSettleActive === true,
            mountSettleDeadlineReached: nativeMountSettleDeadlineReachedRef.current,
            pendingMountSettleBottomPin: pendingNativeMountSettleBottomPinRef.current,
            sessionId,
        });
        applyNativeMountSettlePendingPinFlushPlan(mountSettleFlushPlan);
    }, [
        applyNativeMountSettlePendingPinFlushPlan,
        lifecycleHost,
        nativeMountSettleDeadlineReachedRef,
        sessionId,
        shouldKeepPendingNativeMountSettleBottomPin,
    ]);
    flushPendingNativeMountSettleBottomPinRef.current = flushPendingNativeMountSettleBottomPin;

    const pinNativeLiveTailForHotTailHeight = React.useCallback((height: number) => {
        if (Platform.OS === 'web' || !usesNativeFlashListBottomMaintenance) return;
        const carve = liveTailCarveTelemetryRef.current;
        if (!carve.active) return;
        const wasFollowing = captureNativeBottomFollowPreviousFollow();
        if (!wasFollowing) {
            recordViewportTelemetryEvent({
                type: 'scroll-observed',
                mode: resolveViewportTelemetryMode(),
                reason: 'skipped',
                nativeHotTailHeightPx: height,
                liveRegionActive: true,
                nativeCarvePinIssued: false,
                liveTailAnchorId: carve.anchorId ?? undefined,
                liveTailAnchorKind: carve.anchorKind ?? undefined,
                coldCount: carve.coldCount,
                hotCount: carve.hotCount,
            });
            return;
        }
        authorizeImmediateBottomFollowWriteRef.current('hot-tail-carve', 'stream-append');
    }, [
        captureNativeBottomFollowPreviousFollow,
        recordViewportTelemetryEvent,
        resolveViewportTelemetryMode,
        usesNativeFlashListBottomMaintenance,
    ]);
    pinNativeLiveTailForHotTailHeightRef.current = pinNativeLiveTailForHotTailHeight;

    const applyNativeMountSettlePendingFlushRequest = React.useCallback((
        decision: NativeMountSettlePendingFlushTriggerDecision,
    ): void => {
        if (decision.type !== 'request-pending-flush') return;
        pendingNativeMountSettleBottomPinRef.current = true;
    }, []);

    const applyNativeMountSettlePendingFlushTriggerDecision = React.useCallback((
        decision: NativeMountSettlePendingFlushTriggerDecision,
    ) => {
        if (decision.type === 'noop') return;
        applyNativeMountSettlePendingFlushRequest(decision);
        flushPendingNativeMountSettleBottomPin();
    }, [
        applyNativeMountSettlePendingFlushRequest,
        flushPendingNativeMountSettleBottomPin,
    ]);

    React.useEffect(() => {
        applyNativeMountSettlePendingFlushTriggerDecision(resolveNativeMountSettlePendingFlushTriggerDecision({
            autoPinSuppressed: false,
            hasInitialViewportApplied: false,
            mountSettleDeadlineReached: false,
            mountSettleStable: nativeMountSettleStable,
        }));
    }, [
        applyNativeMountSettlePendingFlushTriggerDecision,
        nativeMountSettleStable,
    ]);

    React.useEffect(() => {
        applyNativeMountSettlePendingFlushTriggerDecision(resolveNativeMountSettlePendingFlushTriggerDecision({
            autoPinSuppressed: nativeMountSettleAutoPinSuppressedRef.current,
            hasInitialViewportApplied: hasNativeInitialViewportAppliedForCurrentSession(),
            mountSettleDeadlineReached: nativeMountSettleDeadlineReached,
            mountSettleStable: false,
        }));
    }, [
        applyNativeMountSettlePendingFlushTriggerDecision,
        hasNativeInitialViewportAppliedForCurrentSession,
        nativeMountSettleAutoPinSuppressedRef,
        nativeMountSettleDeadlineReached,
    ]);

    const deferPinToBottomAfterScroll = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason,
    ) => {
        fireAndForget(Promise.resolve().then(() => {
            authorizeImmediateBottomFollowWriteRef.current('deferred-post-scroll', reason);
        }), { tag: 'ChatList.deferPinToBottomAfterScroll' });
    }, []);

    React.useLayoutEffect(() => {
        const nextFollowBottomIntentKey = followBottomIntentKey ?? null;
        if (nextFollowBottomIntentKey == null) return;
        if (lastFollowBottomIntentKeyRef.current === nextFollowBottomIntentKey) return;
        lastFollowBottomIntentKeyRef.current = nextFollowBottomIntentKey;
        commitExplicitReturnToLiveTailState('follow-bottom-intent');
        invalidateViewportAnchorCapture();
        const plan = lifecycleHost.planFollowBottomIntentTakeover({ sessionId });
        commitBottomFollowModeState(plan.state.bottomFollowState);
        applyFollowBottomIntentTakeoverApplyEffects(plan.followBottomIntentTakeoverEffects);
        pinToBottom('jump-to-bottom');
    }, [
        applyFollowBottomIntentTakeoverApplyEffects,
        commitBottomFollowModeState,
        commitExplicitReturnToLiveTailState,
        followBottomIntentKey,
        invalidateViewportAnchorCapture,
        lifecycleHost,
        pinToBottom,
        sessionId,
    ]);

    const resolveAutoPinWaitMs = React.useCallback((reason: TranscriptViewportTelemetryScrollReason): number | null => {
        return resolveTranscriptAutoFollowPinWaitMs({
            autoPinDelayMs: TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS,
            canAutoFollow: canAutoFollowForReason(reason),
            hasRearmedBottomFollow: hasRearmedNativeBottomFollow(),
            lastUserScrollIntentAtMs: lastUserScrollIntentAtMsRef.current,
            nowMs: Date.now(),
        });
    }, [
        canAutoFollowForReason,
        hasRearmedNativeBottomFollow,
        lastUserScrollIntentAtMsRef,
    ]);

    const applyScheduledPinToBottomFire = React.useCallback((handle: ScheduledPinToBottom): void => {
        if (scheduledPinRef.current !== handle) return;
        const firePlan = planBottomFollowWriteSchedulerEvent(bottomFollowWriteSchedulerStateRef.current, {
            observedRawOffsetY: Platform.OS === 'web' ? null : readNativeAbsoluteScrollOffset(listRef.current),
            type: 'fire-pending',
            usesNativeFlashListBottomMaintenance,
            waitMs: resolveAutoPinWaitMs(handle.reason),
        });
        bottomFollowWriteSchedulerStateRef.current = firePlan.state;
        scheduledPinRef.current = null;
        applyBottomFollowWriteSchedulerEffects(firePlan.effects);
    }, [
        applyBottomFollowWriteSchedulerEffects,
        listRef,
        resolveAutoPinWaitMs,
        usesNativeFlashListBottomMaintenance,
    ]);

    const scheduleBottomFollowWriteTimer = React.useCallback((
        write: BottomFollowScheduledWrite<WebTranscriptScrollMetrics>,
    ): void => {
        const raf = (globalThis as any)?.requestAnimationFrame as undefined | ((cb: () => void) => any);
        if (write.kind === 'raf' && typeof raf === 'function') {
            const handle: ScheduledPinToBottom = { ...write, id: 0 };
            scheduledPinRef.current = handle;
            handle.id = raf(() => {
                applyScheduledPinToBottomFire(handle);
            });
            return;
        }
        const handle: ScheduledPinToBottom = { ...write, id: null };
        scheduledPinRef.current = handle;
        handle.id = setTimeout(() => {
            applyScheduledPinToBottomFire(handle);
        }, write.delayMs);
    }, [applyScheduledPinToBottomFire]);
    scheduleBottomFollowWriteTimerRef.current = scheduleBottomFollowWriteTimer;

    const requestBottomFollowScheduledWrite = React.useCallback((
        previousWebMetrics: WebTranscriptScrollMetrics | null = null,
        reason: TranscriptViewportTelemetryScrollReason = 'content-size-change',
        nativePrevFollowAtBottom: boolean = false,
        writer: BottomFollowAutomaticWriter = 'automatic-live-tail',
    ) => {
        const raf = (globalThis as any)?.requestAnimationFrame as undefined | ((cb: () => void) => any);
        const schedulePlan = planBottomFollowWriteSchedulerEvent(bottomFollowWriteSchedulerStateRef.current, {
            canUseAnimationFrame: typeof raf === 'function',
            nativePrevFollowAtBottom,
            platform: Platform.OS === 'web' ? 'web' : 'native',
            previousWebMetrics,
            reason,
            type: 'request-write',
            usesNativeFlashListBottomMaintenance,
            waitMs: resolveAutoPinWaitMs(reason),
            writer,
        });
        bottomFollowWriteSchedulerStateRef.current = schedulePlan.state;
        applyBottomFollowWriteSchedulerEffects(schedulePlan.effects);
    }, [
        applyBottomFollowWriteSchedulerEffects,
        resolveAutoPinWaitMs,
        usesNativeFlashListBottomMaintenance,
    ]);
    requestBottomFollowScheduledWriteRef.current = requestBottomFollowScheduledWrite;

    const applyScheduledContentGrowthLiveTailCommand = React.useCallback((
        params: Readonly<{
            effect: ContentGrowthLiveTailCommandApplyEffect | null;
            nativePrevFollowAtBottom: boolean;
            previousWebMetrics: WebTranscriptScrollMetrics | null;
        }>,
    ): boolean => {
        if (!params.effect) return false;
        if (params.effect.sessionId !== sessionId) return false;
        requestBottomFollowScheduledWrite(
            params.previousWebMetrics,
            params.effect.reason,
            params.nativePrevFollowAtBottom,
            'content-growth',
        );
        return true;
    }, [
        requestBottomFollowScheduledWrite,
        sessionId,
    ]);

    const requestAutomaticLiveTailPin = React.useCallback((
        previousWebMetrics: WebTranscriptScrollMetrics | null = null,
        reason: TranscriptViewportTelemetryScrollReason = 'content-size-change',
        nativePrevFollowAtBottom: boolean = false,
    ): boolean => {
        const plan = lifecycleHost.planContentGrowthLiveTailCommand({
            reason,
            sessionId,
            wantsLiveTail: wantsPinnedRef.current,
        });
        commitBottomFollowModeState(plan.state.bottomFollowState);
        return applyScheduledContentGrowthLiveTailCommand({
            effect: plan.contentGrowthLiveTailCommandEffect,
            nativePrevFollowAtBottom,
            previousWebMetrics,
        });
    }, [
        applyScheduledContentGrowthLiveTailCommand,
        commitBottomFollowModeState,
        lifecycleHost,
        sessionId,
        wantsPinnedRef,
    ]);

    const requestMeasuredNativeAutomaticLiveTailPin = React.useCallback((
        reason: TranscriptViewportTelemetryScrollReason = 'content-size-change',
    ): boolean => {
        if (Platform.OS === 'web') return false;
        const plan = lifecycleHost.planContentGrowthLiveTailCommand({
            reason,
            sessionId,
            wantsLiveTail: wantsPinnedRef.current,
        });
        commitBottomFollowModeState(plan.state.bottomFollowState);
        if (!plan.contentGrowthLiveTailCommandEffect) return false;
        return authorizeImmediateBottomFollowWriteRef.current(
            'passive-drift',
            plan.contentGrowthLiveTailCommandEffect.reason,
        );
    }, [
        commitBottomFollowModeState,
        lifecycleHost,
        sessionId,
        wantsPinnedRef,
    ]);

    const applySessionScopedMeasuredNativeAutomaticLiveTailPinEffects = React.useCallback((
        effects: readonly NativeMountSettlePassiveDriftRepinEffect[],
    ): void => {
        for (const effect of effects) {
            if (
                effect.type !== 'request-measured-native-automatic-live-tail-pin' ||
                effect.sessionId !== sessionId
            ) {
                continue;
            }
            requestMeasuredNativeAutomaticLiveTailPin(effect.reason);
        }
    }, [
        requestMeasuredNativeAutomaticLiveTailPin,
        sessionId,
    ]);

    const applyNativeMountSettlePassiveDriftRepinObservation = React.useCallback((params: Readonly<{
        bottomFollowMode: TranscriptBottomFollowModeState['mode'];
        isTrusted: boolean;
        nowMs: number;
        pinThresholdPx: number;
        usesNativeFlashListBottomMaintenance: boolean;
        wantsPinned: boolean;
    }>): void => {
        const preflightDecision = resolveNativeMountSettlePassiveDriftRepinPreflightDecision({
            autoPinDelayMs: TRANSCRIPT_SCROLL_USER_INTENT_AUTO_PIN_DELAY_MS,
            bottomFollowMode: params.bottomFollowMode,
            isMountSettleActive: lifecycleHost.getMountSettleSnapshot().isMountSettleActive === true,
            isNative: Platform.OS !== 'web',
            isTrusted: params.isTrusted,
            lastUserScrollIntentAtMs: lastUserScrollIntentAtMsRef.current,
            nowMs: params.nowMs,
            usesNativeFlashListBottomMaintenance: params.usesNativeFlashListBottomMaintenance,
            wantsPinned: params.wantsPinned,
        });
        if (preflightDecision.type !== 'check-current-distance') return;
        const distanceFromLiveTailPx = readCurrentNativeDistanceFromBottom();
        const distanceDecision = resolveNativeMountSettlePassiveDriftRepinDistanceDecision({
            distanceFromLiveTailPx,
            pinThresholdPx: params.pinThresholdPx,
        });
        applySessionScopedMeasuredNativeAutomaticLiveTailPinEffects(
            resolveNativeMountSettlePassiveDriftRepinEffects({
                decision: distanceDecision,
                sessionId,
            }),
        );
    }, [
        applySessionScopedMeasuredNativeAutomaticLiveTailPinEffects,
        lastUserScrollIntentAtMsRef,
        lifecycleHost,
        readCurrentNativeDistanceFromBottom,
        sessionId,
    ]);

    const applyNativeDragActiveMirrorEffects = React.useCallback((
        effects: readonly NativeDragActiveMirrorApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== sessionId) continue;
            const schedulerPlan = planBottomFollowWriteSchedulerEvent(
                bottomFollowWriteSchedulerStateRef.current,
                {
                    active: effect.active,
                    type: 'set-gesture-active',
                },
            );
            bottomFollowWriteSchedulerStateRef.current = schedulerPlan.state;
            for (const schedulerEffect of schedulerPlan.effects) {
                if (schedulerEffect.type === 'schedule-write') {
                    scheduleBottomFollowWriteTimerRef.current?.(schedulerEffect.write);
                }
            }
        }
    }, [sessionId]);

    const prepareNativeContentMaterializationAutoPin = React.useCallback((observation: Readonly<{
        measuredContentHeight: number;
        previousMeasuredContentHeight: number;
        reason: TranscriptViewportTelemetryScrollReason;
    }>): void => {
        nativeContentMaterializationAutoPinRef.current =
            resolveNativeContentMaterializationAutoPin({
                contentHeight: observation.measuredContentHeight,
                hasInitialViewportApplied: hasNativeInitialViewportAppliedForCurrentSession(),
                isNative: Platform.OS !== 'web',
                lastBottomFollowPinCommandSessionId: lastNativeBottomFollowPinCommandRef.current?.sessionId,
                layoutHeight: listLayoutHeightRef.current,
                pinThresholdPx,
                previousContentHeight: observation.previousMeasuredContentHeight,
                reason: observation.reason,
                sessionId,
                usesNativeFlashListBottomMaintenance,
                wantsPinned: wantsPinnedRef.current,
            });
    }, [
        hasNativeInitialViewportAppliedForCurrentSession,
        listLayoutHeightRef,
        pinThresholdPx,
        sessionId,
        usesNativeFlashListBottomMaintenance,
        wantsPinnedRef,
    ]);

    const handleNativeHotTailHeightChange = React.useCallback((height: number) => {
        const normalizedHeight =
            typeof height === 'number' && Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
        if (nativeHotTailHeightRef.current === normalizedHeight) return;
        nativeHotTailHeightRef.current = normalizedHeight;
        pinNativeLiveTailForHotTailHeightRef.current?.(normalizedHeight);
    }, []);

    React.useEffect(() => {
        return () => {
            const scheduled = scheduledPinRef.current;
            if (!scheduled) return;
            scheduledPinRef.current = null;
            if (scheduled.kind === 'raf') {
                const caf = (globalThis as any)?.cancelAnimationFrame as undefined | ((id: any) => void);
                if (typeof caf === 'function') {
                    caf(scheduled.id);
                }
            } else {
                clearTimeout(scheduled.id);
            }
        };
    }, []);

    React.useLayoutEffect(() => {
        const latestActivityKey = latestCommittedActivityKey;
        const hasNewCommittedActivity =
            latestActivityKey != null &&
            lastProactiveAutoFollowActivityKeyRef.current !== latestActivityKey;
        if (latestActivityKey == null) {
            lastProactiveAutoFollowActivityKeyRef.current = null;
        }
        if (hasNewCommittedActivity) {
            lastProactiveAutoFollowActivityKeyRef.current = latestActivityKey;
            const nativeOffsetEscapedBottomFollow = observeNativeStreamAppendOffsetEscape({
                contentHeight: listContentHeightRef.current,
                layoutHeight: listLayoutHeightRef.current,
            });
            if (
                !nativeOffsetEscapedBottomFollow &&
                isPinnedRef.current &&
                canAutoFollowForReason('stream-append') &&
                !usesNativeFlashListBottomMaintenance
            ) {
                authorizeImmediateBottomFollowWriteRef.current('proactive-auto-follow', 'stream-append');
            }
        }
        const nextScrollPin = resolveTranscriptScrollPinStateUpdate(
            { ...scrollPinRef.current, isPinned: isPinnedRef.current },
            {
                type: 'newActivity',
                enabled: pinEnabled,
                activityKey: latestCommittedActivityKey ?? null,
            },
        );
        if (nextScrollPin) {
            commitScrollPinState(nextScrollPin);
        }
    }, [
        canAutoFollowForReason,
        commitScrollPinState,
        isPinnedRef,
        latestCommittedActivityKey,
        listContentHeightRef,
        listLayoutHeightRef,
        observeNativeStreamAppendOffsetEscape,
        pinEnabled,
        scrollPinRef,
        usesNativeFlashListBottomMaintenance,
    ]);

    const lastFollowBottomIntentKeyRef = React.useRef<string | number | null>(followBottomIntentKey ?? null);
    const lastProactiveAutoFollowActivityKeyRef = React.useRef<string | null | undefined>(latestCommittedActivityKey);

    return React.useMemo(() => ({
        applyNativeDragActiveMirrorEffects,
        applyNativeMountSettlePassiveDriftRepinObservation,
        applyWebPassiveLiveTailCorrectionEffect,
        beginExplicitJumpWriteBarrier,
        cancelScheduledPinToBottom,
        captureNativeBottomFollowPreviousFollow,
        captureWebBottomFollowPreviousMetrics,
        clearPendingNativeMountSettleBottomPin: () => {
            pendingNativeMountSettleBottomPinRef.current = false;
        },
        deferPinToBottomAfterScroll,
        endExplicitJumpWriteBarrier,
        getGestureActive: () => bottomFollowWriteSchedulerStateRef.current.gestureActive,
        getPendingNativeMountSettleBottomPin: () => pendingNativeMountSettleBottomPinRef.current,
        handleNativeHotTailHeightChange,
        flushPendingNativeMountSettleBottomPin,
        lastNativePinOffsetRef,
        nativeHotTailHeightRef,
        observeNativeConfirmation,
        pendingNativeMountSettleBottomPinRef,
        pinNativeFlashListToBottomIfMeasured,
        pinNativeInitialFollowBottomViewportIfReady,
        pinToBottom,
        pinToBottomRespectingNativeMountSettle,
        prepareNativeContentMaterializationAutoPin,
        requestAutomaticLiveTailPin,
        requestMeasuredNativeAutomaticLiveTailPin,
        resetNativeHotTailHeight: () => {
            nativeHotTailHeightRef.current = 0;
        },
        resetPinRecordsForSessionEntry: (activityKey) => {
            lastNativePinOffsetRef.current = null;
            lastNativeBottomFollowPinCommandRef.current = null;
            nativeAutomaticBottomPinCommandSessionRef.current = null;
            lastNativeStreamAppendPinRef.current = null;
            lastProactiveAutoFollowActivityKeyRef.current = activityKey;
        },
        resetPinStateForSessionOpenArm: (activityKey) => {
            lastNativePinOffsetRef.current = null;
            lastNativeBottomFollowPinCommandRef.current = null;
            lastProactiveAutoFollowActivityKeyRef.current = activityKey;
            pendingNativeMountSettleBottomPinRef.current = false;
        },
        resolveInvertedBottomPinCarveTelemetryFields,
        setPendingNativeMountSettleBottomPin: (value) => {
            pendingNativeMountSettleBottomPinRef.current = value;
        },
        updateLiveTailCarveTelemetry: (next) => {
            liveTailCarveTelemetryRef.current = next;
        },
    }), [
        applyNativeDragActiveMirrorEffects,
        applyNativeMountSettlePassiveDriftRepinObservation,
        applyWebPassiveLiveTailCorrectionEffect,
        beginExplicitJumpWriteBarrier,
        cancelScheduledPinToBottom,
        captureNativeBottomFollowPreviousFollow,
        captureWebBottomFollowPreviousMetrics,
        deferPinToBottomAfterScroll,
        endExplicitJumpWriteBarrier,
        handleNativeHotTailHeightChange,
        flushPendingNativeMountSettleBottomPin,
        observeNativeConfirmation,
        pinNativeFlashListToBottomIfMeasured,
        pinNativeInitialFollowBottomViewportIfReady,
        pinToBottom,
        pinToBottomRespectingNativeMountSettle,
        prepareNativeContentMaterializationAutoPin,
        requestAutomaticLiveTailPin,
        requestMeasuredNativeAutomaticLiveTailPin,
        resolveInvertedBottomPinCarveTelemetryFields,
    ]);
}
