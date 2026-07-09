import * as React from 'react';
import { Platform, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { sync } from '@/sync/sync';
import {
    type TranscriptViewportTelemetryObservationReason,
    type TranscriptViewportTelemetryEvent,
    type TranscriptViewportTelemetryScrollReason,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type {
    ChatTranscriptListItem,
    TranscriptViewportChangeState,
} from '@/components/sessions/transcript/chatListTypes';
import {
    getWebTranscriptDistanceFromBottom,
    isWebTranscriptScrollable,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type { TranscriptListShellPlatformInteractionProps } from '@/components/sessions/transcript/viewport/shell/TranscriptListShell';
import {
    applyTranscriptLifecycleScrollObservationPlan,
    type TranscriptLifecycleScrollObservationPlanContinuationInput,
} from '@/components/sessions/transcript/viewport/lifecycle/lifecycleHostScrollObservationApplier';
import {
    observeTranscriptScrollIngress,
    type TranscriptScrollIngressCallbacks,
    type TranscriptScrollIngressPlatform,
} from '@/components/sessions/transcript/viewport/lifecycle/scrollIngressObservation';
import {
    applyTranscriptContentSizeObservation,
    applyTranscriptLayoutObservation,
    type TranscriptContentSizeObservationApplierEffects,
    type TranscriptLayoutObservationApplierEffects,
} from '@/components/sessions/transcript/viewport/lifecycle/layoutContentSizeObservationApplier';
import {
    resolveWebViewportResizeObservation,
} from '@/components/sessions/transcript/viewport/lifecycle/webViewportResizeObservation';
import type {
    TranscriptViewportLifecycle,
    TranscriptViewportLifecycleEffect,
    TranscriptViewportLifecycleEvent,
} from '@/components/sessions/transcript/viewport/lifecycle/lifecycle';
import type {
    TranscriptLifecycleHost,
    TranscriptLifecycleHostLocalInteractionPlan,
    TranscriptLifecycleHostNativeGestureTakeoverPlan,
    TranscriptLifecycleHostNativeOffsetEscapeReleasePlan,
    TranscriptLifecycleHostNativeTouchIntentPlan,
    TranscriptLifecycleHostNativeTouchReleasePlan,
    TranscriptLifecycleHostScrollObservationPlan,
} from '@/components/sessions/transcript/viewport/lifecycle/lifecycleHost';
import {
    resolveNativeTrustedBottomArrivalEffects,
    type NativeTrustedBottomArrivalEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/nativeTrustedBottomArrival';
import {
    resolveNativeReturnToLiveTailApplyEffects,
    type NativeReturnToLiveTailApplyEffect,
    type NativeSettledReturnToLiveTailDrainEffect,
    type NativeSettledReturnToLiveTailReturnEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/nativeReturnToLiveTail';
import {
    resolveNativeMomentumSettleAwayReleaseStateEffects,
    type NativeMomentumSettleAwayReleaseStateEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/nativeMomentumSettleAwayRelease';
import {
    resolveNativeBottomFollowRearmAdoptionDecision,
    type NativeBottomFollowRearmAdoptionEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/nativeBottomFollowRearmAdoption';
import {
    resolveNativeBottomFollowRearmResetEffects,
    type NativeBottomFollowRearmResetEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/nativeBottomFollowRearmReset';
import {
    resolveWebImmediateReleaseLiveTailApplyEffects,
    type WebImmediateReleaseLiveTailApplyEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/webImmediateReleaseLiveTail';
import {
    resolveWebUserScrollIntentTimestampApplyEffects,
    resolveWebUserScrollTakeoverApplyEffects,
    type WebUserScrollIntentTimestampApplyEffect,
    type WebUserScrollTakeoverApplyEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/webUserScrollIntent';
import {
    resolveNativeDragActiveMirrorApplyEffects,
    resolveNativeMomentumActiveMirrorApplyEffects,
    type NativeDragActiveMirrorApplyEffect,
    type NativeMomentumActiveMirrorApplyEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/nativeActiveMirror';
import {
    readNativeTouchPageY,
    TRANSCRIPT_NATIVE_TOUCH_ESCAPE_MOVE_THRESHOLD_PX,
} from '@/components/sessions/transcript/scroll/nativeTouchEvent';
import { readNativeAbsoluteScrollOffset } from '@/components/sessions/transcript/viewport/driver/readNativeAbsoluteScrollOffset';
import type { ScrollableChatListRef } from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';
import type { TranscriptBottomFollowModeState, TranscriptScrollPinEvent, TranscriptScrollPinState } from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import type { TranscriptViewportMode, TranscriptViewportOwner } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type { EntryRestoreOwner, EntryRestoreOwnerEffect } from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';
import type { TranscriptPrependHost } from '@/components/sessions/transcript/viewport/prepend/host/useTranscriptPrependHost';
import type { TranscriptOlderPaginationSnapshot } from '@/components/sessions/transcript/pagination/useTranscriptOlderPagination';
import type { TranscriptMeasurementHost } from '@/components/sessions/transcript/measurement/transcriptMeasurementHost';
import type { TranscriptJumpTarget } from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';
import type { TranscriptBlankRecoveryEffect } from '@/components/sessions/transcript/viewport/visibility/blankRecoveryOwner';
import type { ScrollObservedTelemetryParams } from '@/components/sessions/transcript/viewport/telemetryHost/viewportEvents';

type MutableRef<T> = { current: T };
type ScrollObservationPlan = TranscriptLifecycleHostScrollObservationPlan;
type WebPassiveLiveTailCorrectionEffect = NonNullable<ScrollObservationPlan['webPassiveLiveTailCorrectionEffect']>;
type NativeScrollAcceptedViewportPaintEffect = ScrollObservationPlan['acceptedViewportPaintEffects'][number];
type GenericScrollObservationViewportStateEffect = Extract<TranscriptViewportLifecycleEffect, { type: 'apply-generic-observed-viewport-state' }>;
type GenericScrollObservationReadOnlyVisibleBottomEffect = Extract<TranscriptViewportLifecycleEffect, { type: 'apply-generic-read-only-visible-bottom-state' }>;
type GenericScrollObservationSuppressionEffect = Extract<TranscriptViewportLifecycleEffect, { type: 'suppress-generic-scroll-observation' }>;
type GenericScrollObservationAnchorCaptureCancellationEffect = Extract<TranscriptViewportLifecycleEffect, { type: 'cancel-scheduled-viewport-anchor-capture' }>;
type NativeOffsetReleaseLiveTailStateEffect = TranscriptLifecycleHostNativeOffsetEscapeReleasePlan['nativeOffsetReleaseLiveTailStateEffects'][number];
type NativeGestureTakeoverPlan = TranscriptLifecycleHostNativeGestureTakeoverPlan;
type NativeTouchIntentApplyEffect = TranscriptLifecycleHostNativeTouchIntentPlan['nativeTouchIntentEffects'][number];
type NativeTouchReleaseLiveTailStateEffect = TranscriptLifecycleHostNativeTouchReleasePlan['nativeTouchReleaseStateEffects'][number];
type LocalTranscriptInteractionAutoPinDeferralApplyEffect = TranscriptLifecycleHostLocalInteractionPlan['localInteractionAutoPinDeferralEffects'][number];
type ViewportLifecycleTransition = ReturnType<TranscriptViewportLifecycle['dispatch']>;
type WebViewportTelemetryDiagnosticsInput = Readonly<{
    flashListContentHeight?: number;
    flashListLayoutHeight?: number;
    metrics?: WebTranscriptScrollMetrics | null;
    paginationPhase?: TranscriptOlderPaginationSnapshot['phase'];
    paginationSuspendedReasons?: TranscriptOlderPaginationSnapshot['suspendedReasons'];
    programmaticWebWrite: boolean;
    scrollable?: boolean;
    trigger: 'scroll' | 'edge-reached' | 'restore' | 'prepend-restore' | 'jump';
}>;

export type TranscriptScrollObservationHostDeps = Readonly<{
    activeTargetWindowTargetRef: MutableRef<TranscriptJumpTarget | null>;
    applyBlankRecoveryEffects: (effects: readonly TranscriptBlankRecoveryEffect[]) => void;
    applyNativeBottomFollowCompletionHostEffects: (effects: ScrollObservationPlan['nativeBottomFollowCompletionEffects']) => void;
    applyNativeDragActiveMirrorEffectsRef: MutableRef<(effects: readonly NativeDragActiveMirrorApplyEffect[]) => void>;
    applyNativeMountSettlePassiveDriftRepinObservation: TranscriptScrollIngressCallbacks['applyNativeMountSettlePassiveDriftRepinObservation'];
    applyNativeUserScrollTakeoverHostEffects: (effects: ScrollObservationPlan['nativeUserScrollTakeoverEffects']) => void;
    applyWebPassiveLiveTailCorrectionEffectRef: MutableRef<(effect: WebPassiveLiveTailCorrectionEffect) => boolean>;
    applyEntryRestoreOwnerEffects: (effects: readonly EntryRestoreOwnerEffect[]) => void;
    bottomFollowModeStateRef: MutableRef<TranscriptBottomFollowModeState>;
    cancelScheduledPinToBottom: () => void;
    captureNativeBottomFollowPreviousFollow: () => boolean;
    captureWebBottomFollowPreviousMetrics: () => WebTranscriptScrollMetrics | null;
    commitBottomFollowModeState: (state: TranscriptBottomFollowModeState) => void;
    commitJumpToBottomDistanceForVisibility: (distanceFromBottom: number) => void;
    commitScrollPinEvent: (event: TranscriptScrollPinEvent) => void;
    commitScrollPinState: (state: TranscriptScrollPinState) => void;
    continuousFollowOwner: 'app' | 'renderer';
    currentSessionIdRef: MutableRef<string>;
    dispatchViewportLifecycleEvent: (event: TranscriptViewportLifecycleEvent) => ViewportLifecycleTransition;
    emitViewportChange: ((nextState: TranscriptViewportChangeState) => void) | undefined;
    entryRestoreOwner: EntryRestoreOwner;
    firstPaintTelemetryRef: MutableRef<{ recorded: boolean } | null>;
    getBottomFollowGestureActiveRef: MutableRef<() => boolean>;
    hasNativeContentMeasurementForCurrentSession: () => boolean;
    hasNativeInitialViewportAppliedForCurrentSession: () => boolean;
    isLoaded: boolean;
    isWarmKeepAliveInstance: boolean;
    invalidateViewportAnchorCapture: () => void;
    lastExplicitWebScrollIntentAtMsRef: MutableRef<number>;
    lastNativePinOffsetRef: MutableRef<number | null>;
    lastPinOffsetForIntentRef: MutableRef<number | null>;
    lastRouteJumpProtectionClearingWebMovementAtMsRef: MutableRef<number>;
    lastScrollOffsetForIntentRef: MutableRef<number | null>;
    lastUserScrollIntentAtMsRef: MutableRef<number>;
    latestCommittedActivityKey: string | null | undefined;
    lifecycleHost: TranscriptLifecycleHost;
    markNativeInitialViewportAppliedForCurrentSession: () => void;
    listContentHeightRef: MutableRef<number>;
    listDataRef: MutableRef<readonly ChatTranscriptListItem[]>;
    listLayoutHeightRef: MutableRef<number>;
    listRef: MutableRef<ScrollableChatListRef | null>;
    loadOlderInFlightRef: MutableRef<boolean>;
    measurementHost: Pick<TranscriptMeasurementHost, 'observeContentSizeChange'>;
    nativeBottomFollowRearmedAfterDragRef: MutableRef<boolean>;
    nativeListDragActiveRef: MutableRef<boolean>;
    nativeMomentumScrollActiveRef: MutableRef<boolean>;
    nativeMountSettleAutoPinSuppressedRef: MutableRef<boolean>;
    nativeMountSettleDeadlineReachedRef: MutableRef<boolean>;
    nativeMountSettleStable: boolean;
    nativePrependTelemetryStateRef: MutableRef<(sessionId?: string) => ReturnType<TranscriptPrependHost['nativeTelemetryState']>>;
    nativeTranscriptTouchStartYRef: MutableRef<number | null>;
    observeNativeBlankRecovery: TranscriptScrollIngressCallbacks['observeNativeBlankRecovery'];
    observeNativeConfirmation: TranscriptScrollIngressCallbacks['observeNativeConfirmation'];
    observeNativeEntryRestoreHostFacts: TranscriptScrollIngressCallbacks['observeNativeEntryRestoreHostFacts'];
    observeNativePrependOwner: () => void;
    observeMountSettleMetrics: TranscriptScrollIngressCallbacks['observeMountSettleMetrics'];
    observeWebGenuineScrollMovement: TranscriptScrollIngressCallbacks['observeWebGenuineScrollMovement'];
    observeWebTranscriptNavigationVisibilityForSession: TranscriptScrollIngressCallbacks['observeWebTranscriptNavigationVisibility'];
    olderPagination: Readonly<{
        getSnapshot(): TranscriptOlderPaginationSnapshot;
        onScrollObservation(input: Readonly<{
            offsetY: number;
            scrollable: boolean;
            trigger?: 'scroll' | 'edge-reached';
        }>): void;
    }>;
    pendingJumpSeqViewportPromotionRef: MutableRef<unknown | null>;
    pendingNativeMountSettleBottomPinRef: MutableRef<boolean>;
    pinEnabled: boolean;
    pinEnabledRef: MutableRef<boolean>;
    pinNativeInitialFollowBottomViewportIfReady(
        reason: Extract<TranscriptViewportTelemetryScrollReason, 'layout-change' | 'content-size-change' | 'stream-append'>,
    ): void;
    pinThresholdPx: number;
    pinThresholdPxRef: MutableRef<number>;
    platformOS: typeof Platform.OS;
    preemptEntryRestoreTransaction: () => void;
    prepareNativeContentMaterializationAutoPin: TranscriptContentSizeObservationApplierEffects<WebTranscriptScrollMetrics>['prepareNativeContentMaterializationAutoPin'];
    prependHost: TranscriptPrependHost;
    promotedJumpSeqViewportProtectionRef: MutableRef<{ promotedAtMs: number; seq: number; sessionId: string } | null>;
    promotePendingJumpSeqViewportSnapshot: TranscriptScrollIngressCallbacks['promotePendingJumpSeqViewportSnapshot'];
    readCurrentNativeDistanceFromBottom: (override?: Readonly<{ contentHeight?: number; layoutHeight?: number }>) => number | null;
    recordFirstListPaint: () => void;
    recordListLayoutWidth: (width: number | undefined) => void;
    recordScrollObservedTelemetry: (params: ScrollObservedTelemetryParams) => void;
    recordStablePaintTelemetry: (metrics: Readonly<{ contentHeight: number; distanceFromBottom: number; layoutHeight: number }>, options: Readonly<{ nativeViewportObserved: boolean }>) => void;
    recordNativeVisibleWindowTelemetry: TranscriptScrollIngressCallbacks['recordNativeVisibleWindowTelemetry'];
    recordViewportTelemetryEvent: (
        event: Readonly<Record<string, unknown> & {
            mode: TranscriptViewportMode;
            type: TranscriptViewportTelemetryEvent['type'];
        }>,
        options?: Readonly<{ sessionId?: string }>,
    ) => void;
    resolveEffectiveListPaintMetrics: () => { contentHeight: number; distanceFromBottom: number; layoutHeight: number } | null;
    resolveNativeObservedScrollOffset: (rawOffsetY: number, metrics: Readonly<{ contentHeight: number; layoutHeight: number }>) => { canonicalOffsetY: number; distanceFromLiveTailPx: number } | null;
    resolveTranscriptMountSettleBottomDistanceNoiseFloorPx: () => number | null;
    resolveViewportReachedEdge: (edge: 'start' | 'end') => 'older' | 'newer';
    resolveViewportTelemetryMode: (mode?: TranscriptViewportMode) => TranscriptViewportMode;
    resolveWebScrollMetrics: () => WebTranscriptScrollMetrics | null;
    resolveWebViewportTelemetryDiagnostics: (params: WebViewportTelemetryDiagnosticsInput) => Record<string, unknown>;
    sessionActive: boolean;
    sessionEntryViewportRef: MutableRef<{ sessionId: string; shouldFollowBottom: boolean } | null>;
    sessionId: string;
    shouldCommitContentHeightState: (height: number) => boolean;
    shouldIgnoreNativeInvalidScrollObservation: (rawOffsetY: number, distanceFromLiveTailPx: number) => boolean;
    shouldSuppressGenericViewportStateForProtectedJumpSeq: () => boolean;
    showFirstPaintPlaceholder: boolean;
    targetWindowActiveRef: MutableRef<boolean>;
    targetWindowEdgeLoadInFlightRef: MutableRef<{ newer: boolean; older: boolean }>;
    targetWindowHostFacts: Readonly<{
        activeWindowState: null | Readonly<{
            hasMoreNewer: boolean | null;
            hasMoreOlder: boolean | null;
            targetSeq: number | null;
        }>;
    }>;
    updateNativeInitialViewportPendingObservation: (value: boolean) => void;
    updateNativeViewportPaintObserved: (value: boolean) => void;
    usesNativeFlashListBottomMaintenance: boolean;
    viewportCommandController: Readonly<{ activeOwner(): TranscriptViewportOwner }>;
    wantsPinnedRef: MutableRef<boolean>;
    composerInsetHeightRef: MutableRef<number>;
    routeJumpSeq: number | null;
    requestAutomaticLiveTailPin(
        previousWebMetrics: WebTranscriptScrollMetrics | null,
        reason: Extract<TranscriptViewportTelemetryScrollReason, 'layout-change' | 'content-size-change' | 'stream-append' | 'viewport-resized'>,
        nativePrevFollowAtBottom: boolean,
    ): void;
    runEntryRestoreAttempt: () => void;
    scheduleViewportAnchorCaptureRef: MutableRef<(state: TranscriptViewportChangeState, options?: Readonly<{ suppressAnchorCapture?: boolean }>) => void>;
    scrollPinRef: MutableRef<TranscriptScrollPinState>;
    userIntentRecentMs: number;
    verifyWebEntryRestoreTransaction: () => void;
    setListContentHeight: (height: number) => void;
    setListLayoutHeight: (height: number) => void;
    verifyNativeSliceEntryRestoreTransaction: () => void;
}>;

export type TranscriptScrollObservationHost = Readonly<{
    adoptNativeFollowingForTrustedBottomArrival: (distanceFromBottom: number | null) => void;
    deferAutoPinAfterLocalTranscriptInteraction: () => void;
    nativeFlashListScrollOverrideProps: Record<string, unknown> | undefined;
    observeNativeStreamAppendOffsetEscape: (params: { contentHeight: number; layoutHeight: number }) => boolean;
    onContentSizeChange: (_: number, h: number) => void;
    onEndReached: () => void;
    onLayout: (e: LayoutChangeEvent) => void;
    onMomentumScrollBegin: () => void;
    onMomentumScrollEnd: () => void;
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
    onScrollBeginDrag: () => void;
    onScrollEndDrag: () => void;
    onStartReached: () => void;
    platformInteractionProps: TranscriptListShellPlatformInteractionProps;
}>;

export function useTranscriptScrollObservationHost(
    deps: TranscriptScrollObservationHostDeps,
): TranscriptScrollObservationHost {
    const continuousFollowOwner = deps.continuousFollowOwner ?? 'app';
    const applyImmediateWebReleaseApplyEffects = React.useCallback((
        effects: readonly WebImmediateReleaseLiveTailApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== deps.sessionId) continue;
            if (effect.type !== 'web-immediate-release-live-tail') continue;
            deps.wantsPinnedRef.current = false;
        }
    }, [
        deps.sessionId,
        deps.wantsPinnedRef,
    ]);
    const applyImmediateWebReleaseLifecycleEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ) => {
        applyImmediateWebReleaseApplyEffects(resolveWebImmediateReleaseLiveTailApplyEffects({
            effects,
            sessionId: deps.sessionId,
        }));
    }, [
        applyImmediateWebReleaseApplyEffects,
        deps.sessionId,
    ]);
    const applyNativeMomentumActiveMirrorApplyEffects = React.useCallback((
        effects: readonly NativeMomentumActiveMirrorApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== deps.sessionId) continue;
            deps.nativeMomentumScrollActiveRef.current = effect.active;
        }
    }, [deps.nativeMomentumScrollActiveRef, deps.sessionId]);
    const applyNativeMomentumActiveMirrorLifecycleEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ) => {
        if (deps.platformOS === 'web') return;
        applyNativeMomentumActiveMirrorApplyEffects(resolveNativeMomentumActiveMirrorApplyEffects({
            effects,
            sessionId: deps.sessionId,
        }));
    }, [
        applyNativeMomentumActiveMirrorApplyEffects,
        deps.platformOS,
        deps.sessionId,
    ]);
    const applyNativeDragActiveMirrorApplyEffects = React.useCallback((
        effects: readonly NativeDragActiveMirrorApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== deps.sessionId) continue;
            deps.nativeListDragActiveRef.current = effect.active;
        }
        deps.applyNativeDragActiveMirrorEffectsRef.current(effects);
    }, [
        deps.applyNativeDragActiveMirrorEffectsRef,
        deps.nativeListDragActiveRef,
        deps.sessionId,
    ]);
    const applyNativeDragActiveMirrorLifecycleEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ) => {
        if (deps.platformOS === 'web') return;
        applyNativeDragActiveMirrorApplyEffects(resolveNativeDragActiveMirrorApplyEffects({
            effects,
            sessionId: deps.sessionId,
        }));
    }, [
        applyNativeDragActiveMirrorApplyEffects,
        deps.platformOS,
        deps.sessionId,
    ]);
    const applyNativeBottomFollowRearmResetEffects = React.useCallback((
        effects: readonly NativeBottomFollowRearmResetEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== deps.sessionId) continue;
            if (effect.type !== 'reset-native-bottom-follow-rearm') continue;
            deps.nativeBottomFollowRearmedAfterDragRef.current = false;
        }
    }, [deps.nativeBottomFollowRearmedAfterDragRef, deps.sessionId]);
    const applyNativeBottomFollowRearmResetLifecycleEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ) => {
        if (deps.platformOS === 'web') return;
        applyNativeBottomFollowRearmResetEffects(resolveNativeBottomFollowRearmResetEffects({
            effects,
            sessionId: deps.sessionId,
        }));
    }, [
        applyNativeBottomFollowRearmResetEffects,
        deps.platformOS,
        deps.sessionId,
    ]);
    const applyNativeTouchReleaseLiveTailStateEffects = React.useCallback((
        effects: readonly NativeTouchReleaseLiveTailStateEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== deps.sessionId) continue;
            if (effect.type !== 'apply-native-touch-release-live-tail-state') continue;
            deps.wantsPinnedRef.current = false;
            deps.commitScrollPinState({ ...deps.scrollPinRef.current, isPinned: false });
        }
    }, [
        deps.commitScrollPinState,
        deps.sessionId,
        deps.wantsPinnedRef,
    ]);
    const applyNativeOffsetReleaseLiveTailStateEffects = React.useCallback((
        effects: readonly NativeOffsetReleaseLiveTailStateEffect[],
    ): boolean => {
        let appliedRelease = false;
        for (const effect of effects) {
            if (effect.sessionId !== deps.sessionId) continue;
            if (effect.type !== 'apply-native-offset-release-live-tail-state') continue;
            deps.commitBottomFollowModeState(effect.bottomFollowState);
            deps.wantsPinnedRef.current = false;
            appliedRelease = true;
        }
        return appliedRelease;
    }, [
        deps.commitBottomFollowModeState,
        deps.sessionId,
        deps.wantsPinnedRef,
    ]);
    const releaseLiveTailForImmediateWebUserIntent = React.useCallback(() => {
        const transition = deps.dispatchViewportLifecycleEvent({
            sessionId: deps.sessionId,
            source: 'web-immediate-user-intent',
            type: 'release-live-tail-intent',
        });
        applyImmediateWebReleaseLifecycleEffects(transition.effects);
    }, [
        applyImmediateWebReleaseLifecycleEffects,
        deps.dispatchViewportLifecycleEvent,
        deps.sessionId,
    ]);
    const applyWebUserScrollTakeoverApplyEffects = React.useCallback((
        effects: readonly WebUserScrollTakeoverApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== deps.sessionId) continue;
            deps.preemptEntryRestoreTransaction();
        }
    }, [
        deps.preemptEntryRestoreTransaction,
        deps.sessionId,
    ]);
    const applyWebUserScrollTakeoverLifecycleEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ) => {
        applyWebUserScrollTakeoverApplyEffects(resolveWebUserScrollTakeoverApplyEffects({
            effects,
            sessionId: deps.sessionId,
        }));
    }, [
        applyWebUserScrollTakeoverApplyEffects,
        deps.sessionId,
    ]);
    const applyWebUserScrollIntentTimestampApplyEffects = React.useCallback((
        effects: readonly WebUserScrollIntentTimestampApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== deps.sessionId) continue;
            deps.lastUserScrollIntentAtMsRef.current = effect.timestampMs;
        }
    }, [deps.lastUserScrollIntentAtMsRef, deps.sessionId]);
    const applyWebUserScrollIntentTimestampLifecycleEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ) => {
        applyWebUserScrollIntentTimestampApplyEffects(resolveWebUserScrollIntentTimestampApplyEffects({
            effects,
            sessionId: deps.sessionId,
        }));
    }, [
        applyWebUserScrollIntentTimestampApplyEffects,
        deps.sessionId,
    ]);

    const stopScrollEventPropagationOnWeb = React.useCallback((event: unknown) => {
        if (deps.platformOS !== 'web') return;
        const nowMs = Date.now();
        deps.lastExplicitWebScrollIntentAtMsRef.current = nowMs;
        const transition = deps.dispatchViewportLifecycleEvent({
            sessionId: deps.sessionId,
            type: 'web-user-scroll-takeover',
        });
        applyWebUserScrollTakeoverLifecycleEffects(transition.effects);
        const timestampTransition = deps.dispatchViewportLifecycleEvent({
            sessionId: deps.sessionId,
            timestampMs: nowMs,
            type: 'web-user-scroll-intent-timestamp',
        });
        applyWebUserScrollIntentTimestampLifecycleEffects(timestampTransition.effects);
        const deltaY = (event as { deltaY?: unknown })?.deltaY;
        if (typeof deltaY === 'number' && Number.isFinite(deltaY) && deltaY < 0) {
            releaseLiveTailForImmediateWebUserIntent();
        }
        // Must stay a bound call: React synthetic events read `this.nativeEvent` inside
        // stopPropagation, so a detached invocation crashes on web.
        const eventWithStop = event as { stopPropagation?: () => void } | null | undefined;
        if (typeof eventWithStop?.stopPropagation === 'function') eventWithStop.stopPropagation();
    }, [
        applyWebUserScrollIntentTimestampLifecycleEffects,
        applyWebUserScrollTakeoverLifecycleEffects,
        deps.dispatchViewportLifecycleEvent,
        deps.lastExplicitWebScrollIntentAtMsRef,
        deps.platformOS,
        deps.sessionId,
        releaseLiveTailForImmediateWebUserIntent,
    ]);
    const markUserScrollIntentOnWeb = React.useCallback(() => {
        if (deps.platformOS !== 'web') return;
        const nowMs = Date.now();
        deps.lastExplicitWebScrollIntentAtMsRef.current = nowMs;
        const transition = deps.dispatchViewportLifecycleEvent({
            sessionId: deps.sessionId,
            type: 'web-user-scroll-takeover',
        });
        applyWebUserScrollTakeoverLifecycleEffects(transition.effects);
        const timestampTransition = deps.dispatchViewportLifecycleEvent({
            sessionId: deps.sessionId,
            timestampMs: nowMs,
            type: 'web-user-scroll-intent-timestamp',
        });
        applyWebUserScrollIntentTimestampLifecycleEffects(timestampTransition.effects);
    }, [
        applyWebUserScrollIntentTimestampLifecycleEffects,
        applyWebUserScrollTakeoverLifecycleEffects,
        deps.dispatchViewportLifecycleEvent,
        deps.lastExplicitWebScrollIntentAtMsRef,
        deps.platformOS,
        deps.sessionId,
    ]);
    const applyNativeGestureTakeoverPlan = React.useCallback((plan: NativeGestureTakeoverPlan) => {
        if (deps.platformOS === 'web') return;
        deps.commitBottomFollowModeState(plan.state.bottomFollowState);
        deps.applyNativeUserScrollTakeoverHostEffects(plan.nativeUserScrollTakeoverEffects);
        deps.markNativeInitialViewportAppliedForCurrentSession();
        deps.cancelScheduledPinToBottom();
        applyNativeBottomFollowRearmResetEffects(plan.nativeBottomFollowRearmResetEffects);
        applyNativeDragActiveMirrorApplyEffects(plan.nativeDragActiveMirrorEffects);
        applyNativeMomentumActiveMirrorApplyEffects(plan.nativeMomentumActiveMirrorEffects);
    }, [
        applyNativeBottomFollowRearmResetEffects,
        applyNativeDragActiveMirrorApplyEffects,
        applyNativeMomentumActiveMirrorApplyEffects,
        deps.applyNativeUserScrollTakeoverHostEffects,
        deps.cancelScheduledPinToBottom,
        deps.commitBottomFollowModeState,
        deps.markNativeInitialViewportAppliedForCurrentSession,
        deps.platformOS,
    ]);
    const recordNativeGestureTakeover = React.useCallback((nowMs?: number) => {
        if (deps.platformOS === 'web') return;
        const plan = deps.lifecycleHost.planNativeGestureTakeover({
            sessionId: deps.sessionId,
            timestampMs: nowMs ?? Date.now(),
        });
        applyNativeGestureTakeoverPlan(plan);
    }, [
        applyNativeGestureTakeoverPlan,
        deps.lifecycleHost,
        deps.platformOS,
        deps.sessionId,
    ]);
    const hasActiveNativeViewportRestore = React.useCallback(() => (
        deps.entryRestoreOwner.hasOpenTransaction(deps.sessionId) ||
        deps.prependHost.hasOpenNativeTransaction()
    ), [
        deps.entryRestoreOwner,
        deps.prependHost,
        deps.sessionId,
    ]);
    const applyNativeTouchIntentHostEffects = React.useCallback((
        effects: readonly NativeTouchIntentApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== deps.sessionId) continue;
            switch (effect.type) {
                case 'native-touch-record-intent-timestamp':
                    deps.lastUserScrollIntentAtMsRef.current = effect.timestampMs;
                    break;
                case 'native-touch-suppress-native-mount-settle-auto-pin':
                    deps.nativeMountSettleAutoPinSuppressedRef.current = true;
                    break;
                case 'native-touch-cancel-native-mount-settle-bottom-pin':
                    deps.pendingNativeMountSettleBottomPinRef.current = false;
                    break;
                case 'native-touch-cancel-scheduled-pin':
                    deps.cancelScheduledPinToBottom();
                    break;
            }
        }
    }, [
        deps.cancelScheduledPinToBottom,
        deps.lastUserScrollIntentAtMsRef,
        deps.nativeMountSettleAutoPinSuppressedRef,
        deps.pendingNativeMountSettleBottomPinRef,
        deps.sessionId,
    ]);
    const recordNativeTranscriptTouchStartIntent = React.useCallback((event?: unknown) => {
        if (deps.platformOS === 'web') return;
        deps.nativeTranscriptTouchStartYRef.current = readNativeTouchPageY(event);
    }, [deps.nativeTranscriptTouchStartYRef, deps.platformOS]);
    const recordNativeTranscriptTouchEndIntent = React.useCallback(() => {
        if (deps.platformOS === 'web') return;
        deps.nativeTranscriptTouchStartYRef.current = null;
    }, [deps.nativeTranscriptTouchStartYRef, deps.platformOS]);
    const recordNativeTranscriptTouchIntent = React.useCallback((event?: unknown) => {
        if (deps.platformOS === 'web') return;
        const hasActiveNativeRestore = hasActiveNativeViewportRestore();
        const currentY = readNativeTouchPageY(event);
        const startY = deps.nativeTranscriptTouchStartYRef.current;
        if (startY == null && currentY != null) {
            deps.nativeTranscriptTouchStartYRef.current = currentY;
        }
        const movedVertically =
            startY != null &&
            currentY != null &&
            Math.abs(currentY - startY) >= TRANSCRIPT_NATIVE_TOUCH_ESCAPE_MOVE_THRESHOLD_PX;
        if (movedVertically && !hasActiveNativeRestore && deps.wantsPinnedRef.current) {
            deps.nativeTranscriptTouchStartYRef.current = currentY;
            recordNativeGestureTakeover();
            const releaseThresholdPx = deps.pinThresholdPxRef.current;
            const plan = deps.lifecycleHost.planNativeTouchRelease({
                distanceFromLiveTailPx: releaseThresholdPx + 1,
                pinThresholdPx: releaseThresholdPx,
                sessionId: deps.sessionId,
            });
            deps.commitBottomFollowModeState(plan.state.bottomFollowState);
            applyNativeTouchReleaseLiveTailStateEffects(plan.nativeTouchReleaseStateEffects);
            applyNativeBottomFollowRearmResetEffects(plan.nativeBottomFollowRearmResetEffects);
            return;
        }
        const nowMs = Date.now();
        const plan = deps.lifecycleHost.planNativeTouchIntent({
            hasActiveNativeViewportRestore: hasActiveNativeRestore,
            sessionId: deps.sessionId,
            timestampMs: nowMs,
        });
        applyNativeTouchIntentHostEffects(plan.nativeTouchIntentEffects);
    }, [
        applyNativeBottomFollowRearmResetEffects,
        applyNativeTouchIntentHostEffects,
        applyNativeTouchReleaseLiveTailStateEffects,
        deps.commitBottomFollowModeState,
        deps.lifecycleHost,
        deps.nativeTranscriptTouchStartYRef,
        deps.pinThresholdPxRef,
        deps.platformOS,
        deps.sessionId,
        deps.wantsPinnedRef,
        hasActiveNativeViewportRestore,
        recordNativeGestureTakeover,
    ]);
    const recordNativeListDragEscapeIntent = React.useCallback(() => {
        recordNativeGestureTakeover();
    }, [recordNativeGestureTakeover]);
    const recordNativeTranscriptResponderStartIntent = React.useCallback((event?: unknown) => {
        recordNativeTranscriptTouchStartIntent(event);
        return false;
    }, [recordNativeTranscriptTouchStartIntent]);
    const recordNativeTranscriptResponderMoveIntent = React.useCallback((event?: unknown) => {
        recordNativeTranscriptTouchIntent(event);
        return false;
    }, [recordNativeTranscriptTouchIntent]);
    const nativeFlashListScrollOverrideProps = React.useMemo(() => {
        if (deps.platformOS === 'web') return undefined;
        return {
            onMoveShouldSetResponderCapture: recordNativeTranscriptResponderMoveIntent,
            onStartShouldSetResponderCapture: recordNativeTranscriptResponderStartIntent,
            onTouchCancel: recordNativeTranscriptTouchEndIntent,
            onTouchEnd: recordNativeTranscriptTouchEndIntent,
            onTouchMove: recordNativeTranscriptTouchIntent,
            onTouchStart: recordNativeTranscriptTouchStartIntent,
        };
    }, [
        deps.platformOS,
        recordNativeTranscriptResponderMoveIntent,
        recordNativeTranscriptResponderStartIntent,
        recordNativeTranscriptTouchEndIntent,
        recordNativeTranscriptTouchIntent,
        recordNativeTranscriptTouchStartIntent,
    ]);
    const platformInteractionProps = React.useMemo<TranscriptListShellPlatformInteractionProps>(() => {
        if (deps.platformOS === 'web') {
            return {
                onWheel: stopScrollEventPropagationOnWeb,
                onTouchMove: stopScrollEventPropagationOnWeb,
                onPointerDown: markUserScrollIntentOnWeb,
                onMouseDown: markUserScrollIntentOnWeb,
            };
        }
        return {
            onTouchCancel: recordNativeTranscriptTouchEndIntent,
            onTouchEnd: recordNativeTranscriptTouchEndIntent,
            onTouchMove: recordNativeTranscriptTouchIntent,
            onTouchStart: recordNativeTranscriptTouchStartIntent,
        };
    }, [
        deps.platformOS,
        markUserScrollIntentOnWeb,
        recordNativeTranscriptTouchEndIntent,
        recordNativeTranscriptTouchIntent,
        recordNativeTranscriptTouchStartIntent,
        stopScrollEventPropagationOnWeb,
    ]);
    const applyLocalTranscriptInteractionAutoPinDeferralApplyEffects = React.useCallback((
        effects: readonly LocalTranscriptInteractionAutoPinDeferralApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== deps.sessionId) continue;
            switch (effect.type) {
                case 'local-interaction-record-intent-timestamp':
                    deps.lastUserScrollIntentAtMsRef.current = effect.timestampMs;
                    break;
                case 'local-interaction-suppress-native-mount-settle-auto-pin':
                    deps.nativeMountSettleAutoPinSuppressedRef.current = true;
                    break;
                case 'local-interaction-cancel-scheduled-pin':
                    deps.cancelScheduledPinToBottom();
                    break;
            }
        }
    }, [
        deps.cancelScheduledPinToBottom,
        deps.lastUserScrollIntentAtMsRef,
        deps.nativeMountSettleAutoPinSuppressedRef,
        deps.sessionId,
    ]);
    const deferAutoPinAfterLocalTranscriptInteraction = React.useCallback(() => {
        const nowMs = Date.now();
        const plan = deps.lifecycleHost.planLocalInteractionAutoPinDeferral({
            sessionId: deps.sessionId,
            timestampMs: nowMs,
        });
        deps.commitBottomFollowModeState(plan.state.bottomFollowState);
        applyLocalTranscriptInteractionAutoPinDeferralApplyEffects(
            plan.localInteractionAutoPinDeferralEffects,
        );
    }, [
        applyLocalTranscriptInteractionAutoPinDeferralApplyEffects,
        deps.commitBottomFollowModeState,
        deps.lifecycleHost,
        deps.sessionId,
    ]);

    const observeNativeStreamAppendOffsetEscape = React.useCallback((params: {
        contentHeight: number;
        layoutHeight: number;
    }): boolean => {
        const distanceFromBottom = deps.platformOS === 'web'
            ? null
            : deps.readCurrentNativeDistanceFromBottom(params);
        const plan = deps.lifecycleHost.planNativeOffsetEscapeRelease({
            bottomFollowState: deps.bottomFollowModeStateRef.current,
            distanceFromLiveTailPx: distanceFromBottom,
            hasActiveNativeViewportRestore: hasActiveNativeViewportRestore(),
            hasNativeTouchStart: deps.nativeTranscriptTouchStartYRef.current != null,
            hasRearmedNativeBottomFollow: deps.nativeBottomFollowRearmedAfterDragRef.current,
            isNative: deps.platformOS !== 'web',
            nativeMomentumScrollActive: deps.nativeMomentumScrollActiveRef.current,
            pinThresholdPx: deps.pinThresholdPx,
            sessionId: deps.sessionId,
            timestampMs: Date.now(),
            wantsPinned: deps.wantsPinnedRef.current,
        });
        if (plan.decision.type !== 'release') return false;
        if (plan.nativeGestureTakeoverPlan) {
            applyNativeGestureTakeoverPlan(plan.nativeGestureTakeoverPlan);
        }
        return applyNativeOffsetReleaseLiveTailStateEffects(plan.nativeOffsetReleaseLiveTailStateEffects);
    }, [
        applyNativeGestureTakeoverPlan,
        applyNativeOffsetReleaseLiveTailStateEffects,
        deps.bottomFollowModeStateRef,
        deps.lifecycleHost,
        deps.nativeBottomFollowRearmedAfterDragRef,
        deps.nativeMomentumScrollActiveRef,
        deps.nativeTranscriptTouchStartYRef,
        deps.pinThresholdPx,
        deps.platformOS,
        deps.readCurrentNativeDistanceFromBottom,
        deps.sessionId,
        deps.wantsPinnedRef,
        hasActiveNativeViewportRestore,
    ]);
    const applyNativeTrustedBottomArrivalEffects = React.useCallback((
        effects: readonly NativeTrustedBottomArrivalEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== deps.sessionId) continue;
            if (effect.type === 'adopt-native-trusted-bottom-arrival') {
                deps.lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
                deps.nativeMountSettleAutoPinSuppressedRef.current = false;
                deps.nativeBottomFollowRearmedAfterDragRef.current = true;
                deps.wantsPinnedRef.current = true;
                deps.lastPinOffsetForIntentRef.current = effect.distanceFromLiveTailPx;
                deps.commitJumpToBottomDistanceForVisibility(effect.distanceFromLiveTailPx);
                deps.commitScrollPinState({ ...deps.scrollPinRef.current, isPinned: true, newActivityCount: 0 });
                deps.emitViewportChange?.(effect.viewportState);
            }
        }
    }, [
        deps.commitJumpToBottomDistanceForVisibility,
        deps.commitScrollPinState,
        deps.emitViewportChange,
        deps.lastPinOffsetForIntentRef,
        deps.lastUserScrollIntentAtMsRef,
        deps.nativeBottomFollowRearmedAfterDragRef,
        deps.nativeMountSettleAutoPinSuppressedRef,
        deps.sessionId,
        deps.wantsPinnedRef,
    ]);
    const adoptNativeFollowingForTrustedBottomArrival = React.useCallback((distanceFromBottom: number | null) => {
        if (deps.platformOS === 'web') return;
        applyNativeTrustedBottomArrivalEffects(resolveNativeTrustedBottomArrivalEffects({
            distanceFromLiveTailPx: distanceFromBottom,
            sessionId: deps.sessionId,
        }));
    }, [
        applyNativeTrustedBottomArrivalEffects,
        deps.platformOS,
        deps.sessionId,
    ]);
    const drainDeferredNewerMessages = React.useCallback((params: Readonly<{
        distanceFromBottom: number;
        pinned: boolean;
    }>) => {
        sync.maybeDrainDeferredNewerMessages(deps.sessionId, {
            isPinned: params.pinned,
            distanceFromBottomPx: params.distanceFromBottom,
        });
    }, [deps.sessionId]);
    const applyNativeReturnToLiveTailApplyEffects = React.useCallback((
        effects: readonly NativeReturnToLiveTailApplyEffect[],
    ): boolean => {
        let appliedReturn = false;
        for (const effect of effects) {
            if (effect.sessionId !== deps.sessionId) continue;
            if (effect.type === 'adopt-native-return-to-live-tail') {
                adoptNativeFollowingForTrustedBottomArrival(effect.distanceFromLiveTailPx);
                appliedReturn = true;
                continue;
            }
            if (effect.type === 'drain-native-return-to-live-tail') {
                drainDeferredNewerMessages({
                    distanceFromBottom: effect.distanceFromLiveTailPx,
                    pinned: effect.isPinned,
                });
            }
        }
        return appliedReturn;
    }, [
        adoptNativeFollowingForTrustedBottomArrival,
        deps.sessionId,
        drainDeferredNewerMessages,
    ]);
    const applyNativeReturnToLiveTailLifecycleEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ): boolean => {
        if (deps.platformOS === 'web') return false;
        return applyNativeReturnToLiveTailApplyEffects(resolveNativeReturnToLiveTailApplyEffects({
            effects,
            sessionId: deps.sessionId,
        }));
    }, [
        applyNativeReturnToLiveTailApplyEffects,
        deps.platformOS,
        deps.sessionId,
    ]);
    const applyNativeSettledReturnToLiveTailReturnEffects = React.useCallback((
        effects: readonly NativeSettledReturnToLiveTailReturnEffect[],
    ): boolean => {
        let appliedReturn = false;
        for (const effect of effects) {
            if (effect.sessionId !== deps.sessionId) continue;
            if (effect.type === 'adopt-native-settled-return-to-live-tail') {
                adoptNativeFollowingForTrustedBottomArrival(effect.distanceFromLiveTailPx);
                appliedReturn = true;
                continue;
            }
            if (effect.type === 'capture-native-settled-return-anchor') {
                deps.scheduleViewportAnchorCaptureRef.current(effect.viewportState);
            }
        }
        return appliedReturn;
    }, [
        adoptNativeFollowingForTrustedBottomArrival,
        deps.scheduleViewportAnchorCaptureRef,
        deps.sessionId,
    ]);
    const applyNativeSettledReturnToLiveTailDrainEffects = React.useCallback((
        effects: readonly NativeSettledReturnToLiveTailDrainEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== deps.sessionId) continue;
            if (effect.type !== 'drain-native-settled-return-to-live-tail') continue;
            drainDeferredNewerMessages({
                distanceFromBottom: effect.distanceFromLiveTailPx,
                pinned: effect.isPinned,
            });
        }
    }, [deps.sessionId, drainDeferredNewerMessages]);
    const applyGenericScrollObservationViewportStateApplyEffects = React.useCallback((
        effects: readonly GenericScrollObservationViewportStateEffect[],
        params: Readonly<{ recordAcceptedViewportPaintObservation: () => void }>,
    ): boolean => {
        let applied = false;
        for (const effect of effects) {
            if (effect.sessionId !== deps.sessionId) continue;
            applied = true;
            if (deps.shouldSuppressGenericViewportStateForProtectedJumpSeq()) continue;
            const { state } = effect;
            deps.lastPinOffsetForIntentRef.current = state.lastDistanceFromLiveTailPx;
            deps.lastScrollOffsetForIntentRef.current = state.nextScrollOffsetPx;
            deps.wantsPinnedRef.current = state.wantsPinned;
            deps.emitViewportChange?.(state.viewportState);
            deps.scheduleViewportAnchorCaptureRef.current(state.anchorCapture.viewportState, {
                suppressAnchorCapture: state.anchorCapture.suppressAnchorCapture,
            });
            deps.commitJumpToBottomDistanceForVisibility(state.jumpButtonDistanceFromLiveTailPx);
            deps.commitScrollPinEvent(state.scrollPinEvent);
            params.recordAcceptedViewportPaintObservation();
            if (deps.platformOS !== 'web') {
                drainDeferredNewerMessages({
                    distanceFromBottom: state.drain.distanceFromLiveTailPx,
                    pinned: state.drain.isPinned,
                });
            }
        }
        return applied;
    }, [
        deps.commitJumpToBottomDistanceForVisibility,
        deps.commitScrollPinEvent,
        deps.emitViewportChange,
        deps.lastPinOffsetForIntentRef,
        deps.lastScrollOffsetForIntentRef,
        deps.platformOS,
        deps.scheduleViewportAnchorCaptureRef,
        deps.sessionId,
        deps.shouldSuppressGenericViewportStateForProtectedJumpSeq,
        deps.wantsPinnedRef,
        drainDeferredNewerMessages,
    ]);
    const applyGenericScrollObservationViewportStateEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
        params: Readonly<{ recordAcceptedViewportPaintObservation: () => void }>,
    ): boolean => {
        const applyEffects = effects.filter((effect): effect is GenericScrollObservationViewportStateEffect => (
            effect.sessionId === deps.sessionId &&
            effect.type === 'apply-generic-observed-viewport-state'
        ));
        return applyGenericScrollObservationViewportStateApplyEffects(applyEffects, params);
    }, [
        applyGenericScrollObservationViewportStateApplyEffects,
        deps.sessionId,
    ]);
    const applyGenericScrollObservationReadOnlyVisibleBottomEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ): boolean => {
        let applied = false;
        for (const effect of effects) {
            if (
                effect.sessionId !== deps.sessionId ||
                effect.type !== 'apply-generic-read-only-visible-bottom-state'
            ) continue;
            const typed = effect as GenericScrollObservationReadOnlyVisibleBottomEffect;
            applied = true;
            const { state } = typed;
            deps.lastPinOffsetForIntentRef.current = state.lastDistanceFromLiveTailPx;
            deps.commitJumpToBottomDistanceForVisibility(state.jumpButtonDistanceFromLiveTailPx);
            deps.commitScrollPinEvent(state.scrollPinEvent);
        }
        return applied;
    }, [
        deps.commitJumpToBottomDistanceForVisibility,
        deps.commitScrollPinEvent,
        deps.lastPinOffsetForIntentRef,
        deps.sessionId,
    ]);
    const applyGenericScrollObservationSuppressionEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ): boolean => effects.some((effect): effect is GenericScrollObservationSuppressionEffect => (
        effect.sessionId === deps.sessionId &&
        effect.type === 'suppress-generic-scroll-observation'
    )), [deps.sessionId]);
    const applyGenericScrollObservationAnchorCaptureCancellationEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ): boolean => {
        const applied = effects.some((effect): effect is GenericScrollObservationAnchorCaptureCancellationEffect => (
            effect.sessionId === deps.sessionId &&
            effect.type === 'cancel-scheduled-viewport-anchor-capture'
        ));
        if (applied) deps.invalidateViewportAnchorCapture();
        return applied;
    }, [deps.invalidateViewportAnchorCapture, deps.sessionId]);
    const applyNativeMomentumSettleAwayReleaseStateEffects = React.useCallback((
        effects: readonly NativeMomentumSettleAwayReleaseStateEffect[],
    ): boolean => {
        let appliedRelease = false;
        for (const effect of effects) {
            if (effect.sessionId !== deps.sessionId) continue;
            if (effect.type !== 'apply-native-momentum-settle-away-release-state') continue;
            deps.wantsPinnedRef.current = false;
            deps.cancelScheduledPinToBottom();
            deps.lastPinOffsetForIntentRef.current = effect.distanceFromLiveTailPx;
            deps.commitJumpToBottomDistanceForVisibility(effect.distanceFromLiveTailPx);
            deps.commitScrollPinEvent(effect.scrollPinEvent);
            deps.emitViewportChange?.(effect.viewportState);
            deps.scheduleViewportAnchorCaptureRef.current(effect.viewportState);
            appliedRelease = true;
        }
        return appliedRelease;
    }, [
        deps.cancelScheduledPinToBottom,
        deps.commitJumpToBottomDistanceForVisibility,
        deps.commitScrollPinEvent,
        deps.emitViewportChange,
        deps.lastPinOffsetForIntentRef,
        deps.scheduleViewportAnchorCaptureRef,
        deps.sessionId,
        deps.wantsPinnedRef,
    ]);
    const applyNativeMomentumSettleAwayReleaseLifecycleEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ): boolean => {
        if (deps.platformOS === 'web') return false;
        return applyNativeMomentumSettleAwayReleaseStateEffects(resolveNativeMomentumSettleAwayReleaseStateEffects({
            effects,
            pinEnabled: deps.pinEnabledRef.current,
            sessionId: deps.sessionId,
            wantsPinned: deps.wantsPinnedRef.current,
        }));
    }, [
        applyNativeMomentumSettleAwayReleaseStateEffects,
        deps.pinEnabledRef,
        deps.platformOS,
        deps.sessionId,
        deps.wantsPinnedRef,
    ]);
    const applyNativeBottomFollowRearmAdoptionEffects = React.useCallback((
        effects: readonly NativeBottomFollowRearmAdoptionEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== deps.sessionId) continue;
            if (effect.type !== 'adopt-native-bottom-follow-rearm') continue;
            adoptNativeFollowingForTrustedBottomArrival(effect.distanceFromLiveTailPx);
        }
    }, [
        adoptNativeFollowingForTrustedBottomArrival,
        deps.sessionId,
    ]);
    const applyNativeBottomFollowRearmLifecycleEffects = React.useCallback((
        effects: readonly TranscriptViewportLifecycleEffect[],
    ): boolean => {
        if (deps.platformOS === 'web') return false;
        const decision = resolveNativeBottomFollowRearmAdoptionDecision({
            effects,
            hasRearmedNativeBottomFollow: deps.nativeBottomFollowRearmedAfterDragRef.current,
            sessionId: deps.sessionId,
        });
        applyNativeBottomFollowRearmAdoptionEffects(decision.effects);
        return decision.consumed;
    }, [
        applyNativeBottomFollowRearmAdoptionEffects,
        deps.nativeBottomFollowRearmedAfterDragRef,
        deps.platformOS,
        deps.sessionId,
    ]);
    const recordNativeListDragEndIntent = React.useCallback(() => {
        if (deps.platformOS === 'web') return;
        const dragSession = deps.bottomFollowModeStateRef.current.dragSession;
        const distanceFromBottom =
            dragSession?.latestDistanceFromBottom ??
            deps.readCurrentNativeDistanceFromBottom() ??
            null;
        const transition = deps.dispatchViewportLifecycleEvent({
            distanceFromLiveTailPx: distanceFromBottom,
            pinThresholdPx: deps.pinThresholdPx,
            sessionId: deps.sessionId,
            type: 'gesture-end',
        });
        applyNativeDragActiveMirrorLifecycleEffects(transition.effects);
        const appliedLifecycleReturn = applyNativeReturnToLiveTailLifecycleEffects(transition.effects);
        const appliedLifecycleRearm = applyNativeBottomFollowRearmLifecycleEffects(transition.effects);
        if (appliedLifecycleReturn || appliedLifecycleRearm) return;
        applyNativeBottomFollowRearmResetLifecycleEffects(transition.effects);
    }, [
        applyNativeBottomFollowRearmLifecycleEffects,
        applyNativeBottomFollowRearmResetLifecycleEffects,
        applyNativeDragActiveMirrorLifecycleEffects,
        applyNativeReturnToLiveTailLifecycleEffects,
        deps.bottomFollowModeStateRef,
        deps.dispatchViewportLifecycleEvent,
        deps.pinThresholdPx,
        deps.platformOS,
        deps.readCurrentNativeDistanceFromBottom,
        deps.sessionId,
    ]);
    const recordNativeMomentumScrollBeginIntent = React.useCallback(() => {
        if (deps.platformOS === 'web') return;
        const transition = deps.dispatchViewportLifecycleEvent({
            sessionId: deps.sessionId,
            type: 'native-momentum-scroll-begin',
        });
        applyNativeMomentumActiveMirrorLifecycleEffects(transition.effects);
    }, [
        applyNativeMomentumActiveMirrorLifecycleEffects,
        deps.dispatchViewportLifecycleEvent,
        deps.platformOS,
        deps.sessionId,
    ]);
    const recordNativeMomentumScrollEndSettle = React.useCallback(() => {
        if (deps.platformOS === 'web') return;
        const momentumEndTransition = deps.dispatchViewportLifecycleEvent({
            sessionId: deps.sessionId,
            type: 'native-momentum-scroll-end',
        });
        applyNativeMomentumActiveMirrorLifecycleEffects(momentumEndTransition.effects);
        const distanceFromBottom = deps.readCurrentNativeDistanceFromBottom();
        const transition = deps.dispatchViewportLifecycleEvent({
            distanceFromLiveTailPx: distanceFromBottom,
            pinThresholdPx: deps.pinThresholdPx,
            sessionId: deps.sessionId,
            type: 'momentum-settle',
        });
        if (applyNativeReturnToLiveTailLifecycleEffects(transition.effects)) return;
        if (applyNativeBottomFollowRearmLifecycleEffects(transition.effects)) return;
        if (applyNativeMomentumSettleAwayReleaseLifecycleEffects(transition.effects)) {
            applyNativeBottomFollowRearmResetLifecycleEffects(transition.effects);
        }
    }, [
        applyNativeBottomFollowRearmLifecycleEffects,
        applyNativeBottomFollowRearmResetLifecycleEffects,
        applyNativeMomentumActiveMirrorLifecycleEffects,
        applyNativeMomentumSettleAwayReleaseLifecycleEffects,
        applyNativeReturnToLiveTailLifecycleEffects,
        deps.dispatchViewportLifecycleEvent,
        deps.pinThresholdPx,
        deps.platformOS,
        deps.readCurrentNativeDistanceFromBottom,
        deps.sessionId,
    ]);

    const applyNativeAcceptedViewportPaintEffects = React.useCallback((
        effects: readonly NativeScrollAcceptedViewportPaintEffect[],
    ): boolean => {
        if (deps.platformOS === 'web') return false;
        let applied = false;
        for (const effect of effects) {
            if (
                effect.type !== 'record-accepted-viewport-paint' ||
                effect.sessionId !== deps.sessionId
            ) {
                continue;
            }
            applied = true;
            deps.updateNativeViewportPaintObserved(true);
            if (deps.firstPaintTelemetryRef.current?.recorded === false) {
                deps.recordFirstListPaint();
            }
            if (!deps.showFirstPaintPlaceholder) {
                const paintMetrics = deps.resolveEffectiveListPaintMetrics() ?? {
                    contentHeight: effect.fallbackMetrics.contentHeight,
                    distanceFromBottom: effect.fallbackMetrics.distanceFromLiveTailPx,
                    layoutHeight: effect.fallbackMetrics.layoutHeight,
                };
                deps.recordStablePaintTelemetry(paintMetrics, {
                    nativeViewportObserved: true,
                });
            }
        }
        return applied;
    }, [
        deps.firstPaintTelemetryRef,
        deps.platformOS,
        deps.recordFirstListPaint,
        deps.recordStablePaintTelemetry,
        deps.resolveEffectiveListPaintMetrics,
        deps.sessionId,
        deps.showFirstPaintPlaceholder,
        deps.updateNativeViewportPaintObserved,
    ]);
    const applyLifecycleHostScrollObservationPlan = React.useCallback((
        plan: ScrollObservationPlan,
        callbacks: Readonly<{
            continueAfterEarlyEffects: (input: TranscriptLifecycleScrollObservationPlanContinuationInput) => void;
            recordNativeScrollObservation: (reason: TranscriptViewportTelemetryObservationReason) => void;
        }>,
    ): boolean => {
        return applyTranscriptLifecycleScrollObservationPlan(plan, {
            applyGenericScrollObservationAnchorCaptureCancellationEffects,
            applyGenericScrollObservationReadOnlyVisibleBottomEffects,
            applyGenericScrollObservationSuppressionEffects,
            applyGenericScrollObservationViewportStateEffects,
            applyNativeAcceptedViewportPaintEffects,
            applyNativeBottomFollowCompletionEffects: deps.applyNativeBottomFollowCompletionHostEffects,
            applyNativeSettledReturnToLiveTailDrainEffects,
            applyNativeSettledReturnToLiveTailReturnEffects,
            applyNativeUserScrollTakeoverEffects: deps.applyNativeUserScrollTakeoverHostEffects,
            applyWebPassiveLiveTailCorrectionEffect: (effect) =>
                continuousFollowOwner === 'app' &&
                deps.applyWebPassiveLiveTailCorrectionEffectRef.current(effect),
            applyWebUserScrollIntentTimestampLifecycleEffects,
            applyWebUserScrollTakeoverLifecycleEffects,
            commitBottomFollowModeState: deps.commitBottomFollowModeState,
            continueAfterEarlyEffects: callbacks.continueAfterEarlyEffects,
            markNativeInitialViewportApplied: deps.markNativeInitialViewportAppliedForCurrentSession,
            recordNativeScrollObservation: callbacks.recordNativeScrollObservation,
        });
    }, [
        applyGenericScrollObservationAnchorCaptureCancellationEffects,
        applyGenericScrollObservationReadOnlyVisibleBottomEffects,
        applyGenericScrollObservationSuppressionEffects,
        applyGenericScrollObservationViewportStateEffects,
        applyNativeAcceptedViewportPaintEffects,
        applyNativeSettledReturnToLiveTailDrainEffects,
        applyNativeSettledReturnToLiveTailReturnEffects,
        applyWebUserScrollIntentTimestampLifecycleEffects,
        applyWebUserScrollTakeoverLifecycleEffects,
        deps.applyNativeBottomFollowCompletionHostEffects,
        deps.applyNativeUserScrollTakeoverHostEffects,
        deps.applyWebPassiveLiveTailCorrectionEffectRef,
        deps.commitBottomFollowModeState,
        continuousFollowOwner,
        deps.markNativeInitialViewportAppliedForCurrentSession,
    ]);

    const observeOlderPaginationScroll = React.useCallback((params: Readonly<{
        offsetY: number;
        layoutHeight: number;
        contentHeight: number;
        distanceFromBottom: number;
        webMetrics?: WebTranscriptScrollMetrics | null;
        trigger?: 'scroll' | 'edge-reached';
    }>) => {
        const usesWebDomMetrics = deps.platformOS === 'web' && params.webMetrics != null;
        const layoutHeight = usesWebDomMetrics ? params.webMetrics!.clientHeight : params.layoutHeight;
        const contentHeight = usesWebDomMetrics ? params.webMetrics!.scrollHeight : params.contentHeight;
        const offsetY = usesWebDomMetrics ? params.webMetrics!.scrollTop : params.offsetY;
        const distanceFromBottom = usesWebDomMetrics
            ? getWebTranscriptDistanceFromBottom(params.webMetrics!)
            : params.distanceFromBottom;
        const scrollable = usesWebDomMetrics
            ? isWebTranscriptScrollable(params.webMetrics!, 16)
            : layoutHeight > 0 && contentHeight > layoutHeight + 16;
        const followGateOpen = deps.platformOS === 'web'
            ? !(deps.wantsPinnedRef.current && distanceFromBottom <= deps.pinThresholdPx)
            : deps.bottomFollowModeStateRef.current.mode !== 'following' && !deps.wantsPinnedRef.current;
        deps.olderPagination.onScrollObservation({
            offsetY,
            scrollable: scrollable && followGateOpen,
            trigger: params.trigger,
        });
        const loadOlderInFlightAfterObservation = deps.loadOlderInFlightRef.current;
        if (deps.platformOS === 'web') {
            const snapshot = deps.olderPagination.getSnapshot();
            deps.recordViewportTelemetryEvent({
                type: 'scroll-observed',
                mode: deps.resolveViewportTelemetryMode(),
                reason: 'observed',
                offsetY,
                layoutHeight,
                contentHeight,
                distanceFromBottom,
                ...deps.resolveWebViewportTelemetryDiagnostics({
                    metrics: params.webMetrics,
                    flashListContentHeight: params.contentHeight,
                    flashListLayoutHeight: params.layoutHeight,
                    paginationPhase: snapshot.phase,
                    paginationSuspendedReasons: snapshot.suspendedReasons,
                    programmaticWebWrite: false,
                    scrollable: scrollable && followGateOpen,
                    trigger: params.trigger ?? 'scroll',
                }),
            });
        }
        return loadOlderInFlightAfterObservation;
    }, [
        deps.bottomFollowModeStateRef,
        deps.loadOlderInFlightRef,
        deps.olderPagination,
        deps.pinThresholdPx,
        deps.platformOS,
        deps.recordViewportTelemetryEvent,
        deps.resolveViewportTelemetryMode,
        deps.resolveWebViewportTelemetryDiagnostics,
        deps.wantsPinnedRef,
    ]);

    const resolveActiveTargetWindowContinuationTarget = React.useCallback((): TranscriptJumpTarget | null => {
        const activeWindowState = deps.targetWindowHostFacts.activeWindowState;
        const targetSeq = activeWindowState?.targetSeq;
        if (typeof targetSeq !== 'number' || !Number.isFinite(targetSeq)) return null;
        const normalizedTargetSeq = Math.trunc(targetSeq);
        const rememberedTarget = deps.activeTargetWindowTargetRef.current;
        const rememberedTargetSeq = rememberedTarget?.kind === 'seq'
            ? rememberedTarget.seq
            : rememberedTarget?.seqHint;
        if (
            typeof rememberedTargetSeq === 'number' &&
            Number.isFinite(rememberedTargetSeq) &&
            Math.trunc(rememberedTargetSeq) === normalizedTargetSeq
        ) {
            return rememberedTarget;
        }
        return { kind: 'seq', seq: normalizedTargetSeq };
    }, [deps.activeTargetWindowTargetRef, deps.targetWindowHostFacts.activeWindowState]);
    const loadTargetWindowPageAtEdge = React.useCallback(async (direction: 'older' | 'newer') => {
        const activeWindowState = deps.targetWindowHostFacts.activeWindowState;
        if (!activeWindowState || !deps.sessionId) return;
        if (direction === 'older' && activeWindowState.hasMoreOlder !== true) return;
        if (direction === 'newer' && activeWindowState.hasMoreNewer !== true) {
            if (activeWindowState.hasMoreNewer === false) {
                sync.markSessionLiveTailIntent(deps.sessionId);
                deps.activeTargetWindowTargetRef.current = null;
            }
            return;
        }
        if (deps.targetWindowEdgeLoadInFlightRef.current[direction]) return;
        const target = resolveActiveTargetWindowContinuationTarget();
        if (!target) return;
        deps.targetWindowEdgeLoadInFlightRef.current[direction] = true;
        try {
            const routeSeqHint = target.kind === 'route-message-id' && typeof target.seqHint === 'number' && Number.isFinite(target.seqHint)
                ? Math.trunc(target.seqHint)
                : null;
            const loadTarget = target.kind === 'seq'
                ? { kind: 'seq' as const, seq: Math.trunc(target.seq) }
                : routeSeqHint != null
                    ? {
                        kind: 'route-message-id' as const,
                        routeMessageId: target.routeMessageId,
                        seqHint: routeSeqHint,
                    }
                    : null;
            if (!loadTarget) return;
            const result = await sync.loadTargetWindowMessages(deps.sessionId, loadTarget, { direction });
            if (result?.status === 'loaded' && result.targetPresent) {
                deps.activeTargetWindowTargetRef.current = target;
            }
        } finally {
            deps.targetWindowEdgeLoadInFlightRef.current[direction] = false;
        }
    }, [
        deps.activeTargetWindowTargetRef,
        deps.sessionId,
        deps.targetWindowEdgeLoadInFlightRef,
        deps.targetWindowHostFacts.activeWindowState,
        resolveActiveTargetWindowContinuationTarget,
    ]);
    const observePaginationEdgeReachedNudge = React.useCallback((visualEdge: 'older' | 'newer') => {
        if (deps.targetWindowActiveRef.current) {
            void loadTargetWindowPageAtEdge(visualEdge);
            return;
        }
        if (visualEdge !== 'older') return;
        const liveWebMetrics = deps.platformOS === 'web' ? deps.resolveWebScrollMetrics() : null;
        const rawEdgeOffset = liveWebMetrics
            ? liveWebMetrics.scrollTop
            : readNativeAbsoluteScrollOffset(deps.listRef.current);
        if (typeof rawEdgeOffset !== 'number') return;
        const layoutH = liveWebMetrics?.clientHeight ?? deps.listLayoutHeightRef.current;
        const contentH = liveWebMetrics?.scrollHeight ?? deps.listContentHeightRef.current;
        const nativeObservedOffset = liveWebMetrics
            ? null
            : deps.resolveNativeObservedScrollOffset(rawEdgeOffset, { contentHeight: contentH, layoutHeight: layoutH });
        const canonicalEdgeOffset = liveWebMetrics ? rawEdgeOffset : nativeObservedOffset?.canonicalOffsetY;
        if (typeof canonicalEdgeOffset !== 'number') return;
        observeOlderPaginationScroll({
            offsetY: canonicalEdgeOffset,
            layoutHeight: layoutH,
            contentHeight: contentH,
            distanceFromBottom: liveWebMetrics
                ? Math.max(0, Math.trunc(contentH - layoutH - canonicalEdgeOffset))
                : nativeObservedOffset?.distanceFromLiveTailPx ?? 0,
            webMetrics: liveWebMetrics,
            trigger: 'edge-reached',
        });
    }, [
        deps.listContentHeightRef,
        deps.listLayoutHeightRef,
        deps.listRef,
        deps.platformOS,
        deps.resolveNativeObservedScrollOffset,
        deps.resolveWebScrollMetrics,
        deps.targetWindowActiveRef,
        loadTargetWindowPageAtEdge,
        observeOlderPaginationScroll,
    ]);

    const transcriptScrollIngressPlatform: TranscriptScrollIngressPlatform =
        deps.platformOS === 'web' ? 'web' : 'native';
    const transcriptScrollIngressCallbacks = React.useMemo<TranscriptScrollIngressCallbacks>(() => ({
        activeViewportCommandOwner: () => deps.viewportCommandController.activeOwner(),
        applyEntryRestoreOwnerEffects: deps.applyEntryRestoreOwnerEffects,
        applyNativeMountSettlePassiveDriftRepinObservation: deps.applyNativeMountSettlePassiveDriftRepinObservation,
        applyNativePrependOwnerEffects: deps.prependHost.applyNativeEffects,
        applyScrollObservationPlan: applyLifecycleHostScrollObservationPlan,
        commitOpenNativeEntryRestoreVisibleState(distanceFromLiveTailPx) {
            if (deps.isLoaded && deps.listDataRef.current.length > 0) {
                deps.updateNativeViewportPaintObserved(true);
                if (deps.firstPaintTelemetryRef.current?.recorded === false) {
                    deps.recordFirstListPaint();
                }
            }
            const visibleDistanceFromBottom =
                deps.entryRestoreOwner.visibleDistanceForOpenNativeEntry({
                    observedDistanceFromBottom: distanceFromLiveTailPx,
                    sessionId: deps.sessionId,
                });
            if (visibleDistanceFromBottom == null) return;
            deps.commitJumpToBottomDistanceForVisibility(visibleDistanceFromBottom);
            deps.commitScrollPinEvent({
                type: 'scroll',
                enabled: deps.pinEnabled,
                offsetY: visibleDistanceFromBottom,
                pinnedOffsetThresholdPx: deps.pinThresholdPx,
            });
        },
        drainDeferredNewerMessages,
        hasOpenNativeEntryRestoreTransaction: () =>
            deps.entryRestoreOwner.hasOpenTransaction(deps.sessionId),
        hasOpenNativePrependTransaction: () =>
            deps.prependHost.hasOpenNativeTransaction(),
        invalidateViewportAnchorCapture: deps.invalidateViewportAnchorCapture,
        lifecycleHost: deps.lifecycleHost,
        observeMountSettleMetrics: deps.observeMountSettleMetrics,
        observeNativeConfirmation: deps.observeNativeConfirmation,
        observeNativeEntryRestoreHostFacts: deps.observeNativeEntryRestoreHostFacts,
        observeNativeBlankRecovery: deps.observeNativeBlankRecovery,
        observeNativePrependOwner: deps.observeNativePrependOwner,
        observeOlderPaginationScroll,
        observeWebGenuineScrollMovement: deps.observeWebGenuineScrollMovement,
        observeWebTranscriptNavigationVisibility: deps.observeWebTranscriptNavigationVisibilityForSession,
        preemptEntryRestoreTransaction: deps.preemptEntryRestoreTransaction,
        promotePendingJumpSeqViewportSnapshot: deps.promotePendingJumpSeqViewportSnapshot,
        recordNativeScrollObservation(input) {
            deps.recordScrollObservedTelemetry({
                offsetY: input.canonicalOffsetY,
                rawOffsetY: input.rawOffsetY,
                canonicalOffsetY: input.canonicalOffsetY,
                layoutHeight: input.layoutHeight,
                contentHeight: input.contentHeight,
                distanceFromBottom: input.distanceFromBottom,
                reason: input.reason,
            });
        },
        recordWebRouteJumpProtectionClearingMovement(timestampMs) {
            deps.lastRouteJumpProtectionClearingWebMovementAtMsRef.current = timestampMs;
        },
        recordNativeVisibleWindowTelemetry: deps.recordNativeVisibleWindowTelemetry,
        refreshInFlightWebPrependAnchor: deps.prependHost.refreshInFlightWebAnchor,
        resolveWebScrollMetrics: deps.resolveWebScrollMetrics,
        retargetPendingWebPrependAnchorForUserScroll: deps.prependHost.retargetPendingWebAnchorForUserScroll,
        shouldIgnoreNativeInvalidScrollObservation: deps.shouldIgnoreNativeInvalidScrollObservation,
        trustedNativePrependScroll: deps.prependHost.trustedNativeScroll,
        updateNativeViewportPaintObserved: deps.updateNativeViewportPaintObserved,
        verifyWebEntryRestoreTransaction: deps.verifyWebEntryRestoreTransaction,
    }), [
        applyLifecycleHostScrollObservationPlan,
        deps.applyEntryRestoreOwnerEffects,
        deps.applyNativeMountSettlePassiveDriftRepinObservation,
        deps.commitJumpToBottomDistanceForVisibility,
        deps.commitScrollPinEvent,
        deps.entryRestoreOwner,
        deps.firstPaintTelemetryRef,
        deps.invalidateViewportAnchorCapture,
        deps.isLoaded,
        deps.lastRouteJumpProtectionClearingWebMovementAtMsRef,
        deps.lifecycleHost,
        deps.listDataRef,
        deps.observeMountSettleMetrics,
        deps.observeNativeBlankRecovery,
        deps.observeNativeConfirmation,
        deps.observeNativeEntryRestoreHostFacts,
        deps.observeNativePrependOwner,
        deps.observeWebGenuineScrollMovement,
        deps.observeWebTranscriptNavigationVisibilityForSession,
        deps.pinEnabled,
        deps.pinThresholdPx,
        deps.preemptEntryRestoreTransaction,
        deps.prependHost,
        deps.promotePendingJumpSeqViewportSnapshot,
        deps.recordFirstListPaint,
        deps.recordNativeVisibleWindowTelemetry,
        deps.recordScrollObservedTelemetry,
        deps.resolveWebScrollMetrics,
        deps.sessionId,
        deps.shouldIgnoreNativeInvalidScrollObservation,
        deps.updateNativeViewportPaintObserved,
        deps.verifyWebEntryRestoreTransaction,
        deps.viewportCommandController,
        drainDeferredNewerMessages,
        observeOlderPaginationScroll,
    ]);

    const layoutObservationApplierEffects = React.useMemo<TranscriptLayoutObservationApplierEffects<WebTranscriptScrollMetrics>>(() => ({
        captureNativeBottomFollowPreviousFollow: deps.captureNativeBottomFollowPreviousFollow,
        captureWebBottomFollowPreviousMetrics: deps.captureWebBottomFollowPreviousMetrics,
        commitLayoutHeight: (height: number) => {
            deps.listLayoutHeightRef.current = height;
            deps.setListLayoutHeight(height);
        },
        observeMountSettleMetrics: () => {
            deps.observeMountSettleMetrics({
                distanceFromBottom: deps.lastPinOffsetForIntentRef.current ?? 0,
                nowMs: Date.now(),
            });
        },
        observeNativePrependOwner: deps.observeNativePrependOwner,
        observeWebPrependOwner: deps.prependHost.observeWeb,
        pinNativeInitialFollowBottomViewportIfReady: deps.pinNativeInitialFollowBottomViewportIfReady,
        recordLayoutMeasuredTelemetry: ({ contentHeight, layoutHeight }) => {
            deps.recordViewportTelemetryEvent({
                type: 'layout-measured',
                mode: deps.resolveViewportTelemetryMode(),
                reason: 'layout-change',
                layoutHeight,
                contentHeight,
            });
        },
        recordNativeVisibleWindowTelemetry: deps.recordNativeVisibleWindowTelemetry,
        requestAutomaticLiveTailPin: deps.requestAutomaticLiveTailPin,
        runEntryRestoreAttempt: deps.runEntryRestoreAttempt,
        verifyNativeSliceEntryRestoreTransaction: deps.verifyNativeSliceEntryRestoreTransaction,
    }), [
        deps.captureNativeBottomFollowPreviousFollow,
        deps.captureWebBottomFollowPreviousMetrics,
        deps.listLayoutHeightRef,
        deps.lastPinOffsetForIntentRef,
        deps.observeMountSettleMetrics,
        deps.observeNativePrependOwner,
        deps.pinNativeInitialFollowBottomViewportIfReady,
        deps.prependHost.observeWeb,
        deps.recordNativeVisibleWindowTelemetry,
        deps.recordViewportTelemetryEvent,
        deps.requestAutomaticLiveTailPin,
        deps.resolveViewportTelemetryMode,
        deps.runEntryRestoreAttempt,
        deps.setListLayoutHeight,
        deps.verifyNativeSliceEntryRestoreTransaction,
    ]);
    const contentSizeObservationApplierEffects = React.useMemo<TranscriptContentSizeObservationApplierEffects<WebTranscriptScrollMetrics>>(() => ({
        captureNativeBottomFollowPreviousFollow: deps.captureNativeBottomFollowPreviousFollow,
        captureWebBottomFollowPreviousMetrics: deps.captureWebBottomFollowPreviousMetrics,
        commitContentHeight: (measuredContentHeight: number) => {
            deps.listContentHeightRef.current = measuredContentHeight;
            if (deps.shouldCommitContentHeightState(measuredContentHeight)) {
                deps.setListContentHeight(measuredContentHeight);
            }
        },
        observeMountSettleMetrics: () => {
            deps.observeMountSettleMetrics({
                distanceFromBottom: deps.lastPinOffsetForIntentRef.current ?? 0,
                nowMs: Date.now(),
            });
        },
        observeNativePrependOwner: deps.observeNativePrependOwner,
        observeNativeStreamAppendOffsetEscape,
        observeWebPrependOwner: deps.prependHost.observeWeb,
        pinNativeInitialFollowBottomViewportIfReady: deps.pinNativeInitialFollowBottomViewportIfReady,
        prepareNativeContentMaterializationAutoPin: deps.prepareNativeContentMaterializationAutoPin,
        recordContentMeasuredTelemetry: ({ contentHeight, layoutHeight, reason }) => {
            deps.recordViewportTelemetryEvent({
                type: 'content-measured',
                mode: deps.resolveViewportTelemetryMode(),
                reason,
                layoutHeight,
                contentHeight,
            });
        },
        recordNativeVisibleWindowTelemetry: deps.recordNativeVisibleWindowTelemetry,
        requestAutomaticLiveTailPin: deps.requestAutomaticLiveTailPin,
        runEntryRestoreAttempt: deps.runEntryRestoreAttempt,
        verifyNativeSliceEntryRestoreTransaction: deps.verifyNativeSliceEntryRestoreTransaction,
    }), [
        deps.captureNativeBottomFollowPreviousFollow,
        deps.captureWebBottomFollowPreviousMetrics,
        deps.listContentHeightRef,
        deps.lastPinOffsetForIntentRef,
        deps.observeMountSettleMetrics,
        deps.observeNativePrependOwner,
        deps.pinNativeInitialFollowBottomViewportIfReady,
        deps.prepareNativeContentMaterializationAutoPin,
        deps.prependHost.observeWeb,
        deps.recordNativeVisibleWindowTelemetry,
        deps.recordViewportTelemetryEvent,
        deps.requestAutomaticLiveTailPin,
        deps.resolveViewportTelemetryMode,
        deps.runEntryRestoreAttempt,
        deps.setListContentHeight,
        deps.shouldCommitContentHeightState,
        deps.verifyNativeSliceEntryRestoreTransaction,
        observeNativeStreamAppendOffsetEscape,
    ]);
    const lastWebViewportResizeMetricsRef = React.useRef<WebTranscriptScrollMetrics | null>(null);
    React.useEffect(() => {
        const resizeObserverCtor = (globalThis as Readonly<{ ResizeObserver?: typeof ResizeObserver }>).ResizeObserver;
        if (typeof resizeObserverCtor !== 'function') return;
        let disposed = false;
        let retryId: ReturnType<typeof setTimeout> | null = null;
        let pollId: ReturnType<typeof setInterval> | null = null;
        let observer: ResizeObserver | null = null;
        const readObservedMetrics = (element: HTMLElement): WebTranscriptScrollMetrics => ({
            clientHeight: element.clientHeight,
            element,
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop,
        });
        const observeResize = (element: HTMLElement) => {
            const previousMetrics = lastWebViewportResizeMetricsRef.current;
            const nextMetrics = readObservedMetrics(element);
            lastWebViewportResizeMetricsRef.current = nextMetrics;
            const previousDistanceFromBottom = previousMetrics
                ? getWebTranscriptDistanceFromBottom(previousMetrics)
                : Number.POSITIVE_INFINITY;
            const nextDistanceFromBottom = getWebTranscriptDistanceFromBottom(nextMetrics);
            const observation = resolveWebViewportResizeObservation({
                nextMetrics,
                previousMetrics,
            });
            if (continuousFollowOwner === 'renderer') return;
            if (!observation) {
                const activeElement = typeof document === 'undefined' ? null : document.activeElement;
                const textInputFocused =
                    activeElement instanceof HTMLElement &&
                    (
                        activeElement.matches('textarea, [contenteditable="true"], [role="textbox"]') ||
                        activeElement.closest('textarea, [contenteditable="true"], [role="textbox"]') !== null
                    );
                if (
                    textInputFocused &&
                    deps.wantsPinnedRef.current &&
                    previousDistanceFromBottom <= deps.pinThresholdPx &&
                    nextDistanceFromBottom > 0
                ) {
                    nextMetrics.element.scrollTop = nextMetrics.element.scrollHeight;
                }
                return;
            }
            if (
                deps.wantsPinnedRef.current &&
                previousDistanceFromBottom <= deps.pinThresholdPx
            ) {
                observation.previousWebMetrics.element.scrollTop = observation.previousWebMetrics.element.scrollHeight;
            }
            deps.requestAutomaticLiveTailPin(
                observation.previousWebMetrics,
                observation.reason,
                false,
            );
        };
        const attach = () => {
            if (disposed) return;
            const initialMetrics = deps.resolveWebScrollMetrics();
            lastWebViewportResizeMetricsRef.current = initialMetrics;
            const element = initialMetrics?.element;
            if (!element) {
                retryId = setTimeout(attach, 100);
                return;
            }
            lastWebViewportResizeMetricsRef.current = readObservedMetrics(element);
            observer = new resizeObserverCtor(() => observeResize(element));
            observer.observe(element);
            pollId = setInterval(() => observeResize(element), 250);
        };
        attach();
        return () => {
            disposed = true;
            if (retryId !== null) {
                clearTimeout(retryId);
            }
            if (pollId !== null) {
                clearInterval(pollId);
            }
            observer?.disconnect();
        };
    }, [
        deps.requestAutomaticLiveTailPin,
        continuousFollowOwner,
        deps.resolveWebScrollMetrics,
        deps.sessionId,
    ]);

    const onLayout = React.useCallback((e: LayoutChangeEvent) => {
        const layout = e?.nativeEvent?.layout;
        deps.recordListLayoutWidth(layout?.width);
        const h = layout?.height;
        applyTranscriptLayoutObservation({
            contentHeight: deps.listContentHeightRef.current,
            continuousFollowOwner: deps.continuousFollowOwner ?? 'app',
            layoutHeight: typeof h === 'number' ? h : Number.NaN,
            layoutHeightChanged: deps.listLayoutHeightRef.current !== h,
            platformOS: deps.platformOS,
            shouldRestoreNativeEntry: deps.sessionEntryViewportRef.current?.shouldFollowBottom === false,
        }, layoutObservationApplierEffects);
    }, [
        deps.listContentHeightRef,
        continuousFollowOwner,
        deps.listLayoutHeightRef,
        deps.platformOS,
        deps.recordListLayoutWidth,
        deps.sessionEntryViewportRef,
        layoutObservationApplierEffects,
    ]);
    const onContentSizeChange = React.useCallback((_: number, h: number) => {
        const contentSizeObservation = deps.measurementHost.observeContentSizeChange({
            composerInsetHeight: deps.composerInsetHeightRef.current,
            latestCommittedActivityKey: deps.latestCommittedActivityKey ?? null,
            platform: deps.platformOS === 'web' ? 'web' : 'native',
            previousMeasuredContentHeight: deps.listContentHeightRef.current,
            rawContentHeight: h,
            sessionActive: deps.sessionActive,
            sessionId: deps.sessionId,
        });
        applyTranscriptContentSizeObservation({
            continuousFollowOwner: deps.continuousFollowOwner ?? 'app',
            layoutHeight: deps.listLayoutHeightRef.current,
            observation: contentSizeObservation,
            platformOS: deps.platformOS,
            shouldRestoreNativeEntry: deps.sessionEntryViewportRef.current?.shouldFollowBottom === false,
        }, contentSizeObservationApplierEffects);
    }, [
        deps.composerInsetHeightRef,
        continuousFollowOwner,
        deps.latestCommittedActivityKey,
        deps.listContentHeightRef,
        deps.listLayoutHeightRef,
        deps.measurementHost,
        deps.platformOS,
        deps.sessionActive,
        deps.sessionEntryViewportRef,
        deps.sessionId,
        contentSizeObservationApplierEffects,
    ]);
    const onScroll = React.useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        observeTranscriptScrollIngress({
            bottomFollowModeState: deps.bottomFollowModeStateRef.current,
            configuredBottomDistanceNoiseFloorPx:
                deps.resolveTranscriptMountSettleBottomDistanceNoiseFloorPx(),
            eventNativeEvent: e?.nativeEvent,
            hasNativeContentMeasurement: deps.hasNativeContentMeasurementForCurrentSession(),
            hasNativeInitialViewportApplied: deps.hasNativeInitialViewportAppliedForCurrentSession(),
            hasRenderedItems: deps.listDataRef.current.length > 0,
            isLoaded: deps.isLoaded,
            isWarmKeepAliveInstance: deps.isWarmKeepAliveInstance,
            lastNativePinOffset: deps.lastNativePinOffsetRef.current,
            lastScrollOffsetForIntent: deps.lastScrollOffsetForIntentRef.current,
            lastUserScrollIntentAtMs: deps.lastUserScrollIntentAtMsRef.current,
            loadOlderInFlight: deps.loadOlderInFlightRef.current,
            measuredContentHeight: deps.listContentHeightRef.current,
            measuredLayoutHeight: deps.listLayoutHeightRef.current,
            nativeCommandSpace: deps.listRef.current?.transcriptViewportCommandSpace === 'standard'
                ? 'standard'
                : 'inverted',
            nativeListDragActive: deps.nativeListDragActiveRef.current,
            nativeMomentumScrollActive: deps.nativeMomentumScrollActiveRef.current,
            nativeMountSettleDeadlineReached:
                deps.nativeMountSettleDeadlineReachedRef.current,
            nativeMountSettleStable: deps.nativeMountSettleStable,
            nowMs: Date.now(),
            pendingBottomPin: deps.pendingNativeMountSettleBottomPinRef.current,
            pinEnabled: deps.pinEnabled,
            pinThresholdPx: deps.pinThresholdPx,
            platform: transcriptScrollIngressPlatform,
            sessionEntry: {
                sessionId: deps.sessionEntryViewportRef.current?.sessionId ?? null,
                shouldFollowBottom:
                    deps.sessionEntryViewportRef.current?.shouldFollowBottom,
            },
            sessionId: deps.sessionId,
            userIntentRecentMs: deps.userIntentRecentMs,
            usesNativeFlashListBottomMaintenance: deps.usesNativeFlashListBottomMaintenance,
            wantsPinned: deps.wantsPinnedRef.current,
        }, transcriptScrollIngressCallbacks);
    }, [
        deps.bottomFollowModeStateRef,
        deps.hasNativeContentMeasurementForCurrentSession,
        deps.hasNativeInitialViewportAppliedForCurrentSession,
        deps.isLoaded,
        deps.isWarmKeepAliveInstance,
        deps.lastNativePinOffsetRef,
        deps.lastScrollOffsetForIntentRef,
        deps.lastUserScrollIntentAtMsRef,
        deps.listContentHeightRef,
        deps.listDataRef,
        deps.listLayoutHeightRef,
        deps.loadOlderInFlightRef,
        deps.nativeListDragActiveRef,
        deps.nativeMomentumScrollActiveRef,
        deps.nativeMountSettleDeadlineReachedRef,
        deps.nativeMountSettleStable,
        deps.pendingNativeMountSettleBottomPinRef,
        deps.pinEnabled,
        deps.pinThresholdPx,
        deps.resolveTranscriptMountSettleBottomDistanceNoiseFloorPx,
        deps.sessionEntryViewportRef,
        deps.sessionId,
        deps.userIntentRecentMs,
        deps.usesNativeFlashListBottomMaintenance,
        deps.wantsPinnedRef,
        transcriptScrollIngressCallbacks,
        transcriptScrollIngressPlatform,
    ]);
    const onStartReached = React.useCallback(() => {
        observePaginationEdgeReachedNudge(deps.resolveViewportReachedEdge('start'));
    }, [deps.resolveViewportReachedEdge, observePaginationEdgeReachedNudge]);
    const onEndReached = React.useCallback(() => {
        observePaginationEdgeReachedNudge(deps.resolveViewportReachedEdge('end'));
    }, [deps.resolveViewportReachedEdge, observePaginationEdgeReachedNudge]);

    return React.useMemo(() => ({
        adoptNativeFollowingForTrustedBottomArrival,
        deferAutoPinAfterLocalTranscriptInteraction,
        nativeFlashListScrollOverrideProps,
        observeNativeStreamAppendOffsetEscape,
        onContentSizeChange,
        onEndReached,
        onLayout,
        onMomentumScrollBegin: recordNativeMomentumScrollBeginIntent,
        onMomentumScrollEnd: recordNativeMomentumScrollEndSettle,
        onScroll,
        onScrollBeginDrag: recordNativeListDragEscapeIntent,
        onScrollEndDrag: recordNativeListDragEndIntent,
        onStartReached,
        platformInteractionProps,
    }), [
        adoptNativeFollowingForTrustedBottomArrival,
        deferAutoPinAfterLocalTranscriptInteraction,
        nativeFlashListScrollOverrideProps,
        observeNativeStreamAppendOffsetEscape,
        onContentSizeChange,
        onEndReached,
        onLayout,
        onScroll,
        onStartReached,
        platformInteractionProps,
        recordNativeListDragEndIntent,
        recordNativeListDragEscapeIntent,
        recordNativeMomentumScrollBeginIntent,
        recordNativeMomentumScrollEndSettle,
    ]);
}
