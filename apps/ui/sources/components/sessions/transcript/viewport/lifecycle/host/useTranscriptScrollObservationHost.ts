import * as React from 'react';
import { Platform, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { sync } from '@/sync/sync';
import { resolveDetachedInputAnchorCaptureState } from '@/components/sessions/transcript/viewport/prepend/host/useTranscriptViewportAnchorCaptureHost';
import {
    type TranscriptViewportTelemetryObservationReason,
    type TranscriptViewportTelemetryEvent,
    type TranscriptViewportTelemetryScrollReason,
    type TranscriptViewportTelemetryWebTrigger,
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
import type { WebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import type { WebScrollMovementFact } from '@/components/sessions/transcript/scroll/resolveWebGenuineScrollMovement';
import {
    applyTranscriptLifecycleScrollObservationPlan,
    type TranscriptLifecycleScrollObservationPlanContinuationInput,
} from '@/components/sessions/transcript/viewport/lifecycle/lifecycleHostScrollObservationApplier';
import {
    observeTranscriptScrollIngress,
    type TranscriptScrollIngressCallbacks,
    type TranscriptScrollIngressPlatform,
} from '@/components/sessions/transcript/viewport/lifecycle/scrollIngressObservation';
import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';
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
import type {
    TranscriptOlderPaginationScrollMetrics,
    TranscriptOlderPaginationSnapshot,
} from '@/components/sessions/transcript/pagination/useTranscriptOlderPagination';
import type { TranscriptMeasurementHost } from '@/components/sessions/transcript/measurement/transcriptMeasurementHost';
import type { TranscriptJumpTarget } from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';
import type { TranscriptTargetWindowState } from '@/components/sessions/transcript/viewport/window/transcriptTargetWindowTypes';
import type { TranscriptBlankRecoveryEffect } from '@/components/sessions/transcript/viewport/visibility/blankRecoveryOwner';
import type { ScrollObservedTelemetryParams } from '@/components/sessions/transcript/viewport/telemetryHost/viewportEvents';
import {
    registerWebTranscriptKeyboardOwner,
    type WebTranscriptKeyboardVerticalDirection,
} from '@/components/sessions/transcript/viewport/lifecycle/webTranscriptKeyboardOwner';

import type { TranscriptUserScrollIntentOwner, TranscriptUserScrollIntentTimestampReader } from '@/components/sessions/transcript/viewport/driver/userScrollIntentOwner';

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
    trigger: TranscriptViewportTelemetryWebTrigger;
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
    /** Re-debounces (never destroys) a pending viewport anchor capture on external movement. */
    deferViewportAnchorCapture: () => void;
    invalidateViewportAnchorCapture: () => void;
    lastExplicitWebScrollIntentAtMsRef: MutableRef<number>;
    lastNativePinOffsetRef: MutableRef<number | null>;
    lastPinOffsetForIntentRef: MutableRef<number | null>;
    lastRouteJumpProtectionClearingWebMovementAtMsRef: MutableRef<number>;
    lastScrollOffsetForIntentRef: MutableRef<number | null>;
    lastUserScrollIntentAtMsRef: TranscriptUserScrollIntentTimestampReader;
    userScrollIntent: TranscriptUserScrollIntentOwner;
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
        isReadyForLoad(): boolean;
        isNearOlderEdge(input: Readonly<{
            offsetY: number;
            scrollable: boolean;
            trigger?: TranscriptOlderPaginationScrollMetrics['trigger'];
            itemsToOlderEdge?: number | null;
        }>): boolean;
        onScrollObservation(input: Readonly<{
            offsetY: number;
            scrollable: boolean;
            trigger?: TranscriptOlderPaginationScrollMetrics['trigger'];
            itemsToOlderEdge?: number | null;
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
    preemptExplicitJumpForUserTakeover(): void;
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
    /**
     * Estimate-immune item-space edge proximity for the older-pagination machine
     * (`resolveItemsToOlderEdge` over the driver fact seam's visible source range).
     * Native only; undefined/null on web or when the list cannot report a reliable
     * genuine-subset visible range yet.
     */
    readItemsToOlderEdge?: () => number | null;
    readItemsToNewerEdge?: () => number | null;
    resolveTranscriptMountSettleBottomDistanceNoiseFloorPx: () => number | null;
    resolveViewportReachedEdge: (edge: 'start' | 'end') => 'older' | 'newer';
    resolveViewportTelemetryMode: (mode?: TranscriptViewportMode) => TranscriptViewportMode;
    resolveWebScrollMetrics: () => WebTranscriptScrollMetrics | null;
    resolveWebViewportTelemetryDiagnostics: (params: WebViewportTelemetryDiagnosticsInput) => Record<string, unknown>;
    webDomObservation: WebDomScrollObservation;
    sessionActive: boolean;
    sessionEntryViewportRef: MutableRef<{ sessionId: string; shouldFollowBottom: boolean } | null>;
    sessionId: string;
    shouldCommitContentHeightState: (height: number) => boolean;
    shouldIgnoreNativeInvalidScrollObservation: (rawOffsetY: number, distanceFromLiveTailPx: number) => boolean;
    shouldSuppressGenericViewportStateForProtectedJumpSeq: () => boolean;
    showFirstPaintPlaceholder: boolean;
    targetWindowActiveRef: MutableRef<boolean>;
    targetWindowEdgeLoadInFlightRef: MutableRef<'newer' | 'older' | null>;
    targetWindowHostFacts: Readonly<{
        activeWindowState: TranscriptTargetWindowState | null;
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
    observeCommittedProjectionLayout: () => void;
    onContentSizeChange: (_: number, h: number) => void;
    onEndReached: () => void;
    onLayout: (e: LayoutChangeEvent) => void;
    onMomentumScrollBegin: () => void;
    onMomentumScrollEnd: () => void;
    onScroll: (
        e: NativeSyntheticEvent<NativeScrollEvent>,
        webMovementFact?: WebScrollMovementFact,
    ) => void;
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
            if (effect.type === 'web-user-scroll-preempt-entry-restore') {
                deps.preemptEntryRestoreTransaction();
            } else {
                deps.preemptExplicitJumpForUserTakeover();
            }
        }
    }, [
        deps.preemptExplicitJumpForUserTakeover,
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
            deps.userScrollIntent.recordInput({ atMs: effect.timestampMs });
        }
    }, [deps.sessionId, deps.userScrollIntent]);
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

    const scheduleDetachedInputAnchorCapture = React.useCallback(() => {
        // Unforgeable input while measurably detached schedules the debounced anchor capture
        // directly and corrects a stale want-pin bit: the generic observation effect that
        // maintains both can starve for a whole detach when giant-row layout churn defeats
        // scroll-frame genuineness classification (live A->B->A RED 2026-07-11).
        const captureState = resolveDetachedInputAnchorCaptureState(
            deps.resolveWebScrollMetrics(),
            deps.pinThresholdPxRef.current,
        );
        if (!captureState) return;
        deps.wantsPinnedRef.current = false;
        deps.scheduleViewportAnchorCaptureRef.current(captureState);
    }, [
        deps.pinThresholdPxRef,
        deps.resolveWebScrollMetrics,
        deps.scheduleViewportAnchorCaptureRef,
        deps.wantsPinnedRef,
    ]);
    const stopScrollEventPropagationOnWeb = React.useCallback((event: unknown) => {
        if (deps.platformOS !== 'web') return;
        const nowMs = Date.now();
        deps.lastExplicitWebScrollIntentAtMsRef.current = nowMs;
        scheduleDetachedInputAnchorCapture();
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
        scheduleDetachedInputAnchorCapture,
    ]);
    const markUserScrollIntentOnWeb = React.useCallback(() => {
        if (deps.platformOS !== 'web') return;
        const nowMs = Date.now();
        deps.lastExplicitWebScrollIntentAtMsRef.current = nowMs;
        scheduleDetachedInputAnchorCapture();
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
        scheduleDetachedInputAnchorCapture,
    ]);
    const recordWebKeyboardViewportInput = React.useCallback((
        verticalDirection: WebTranscriptKeyboardVerticalDirection,
    ): void => {
        if (deps.platformOS !== 'web') return;
        // Keyboard is first-class movement evidence. Record it before browser default
        // scrolling; the renderer preserves only follow-affirming movement toward a held end.
        markUserScrollIntentOnWeb();
        deps.listRef.current?.notifyViewportInput?.({ kind: 'keyboard', verticalDirection });
    }, [deps.listRef, deps.platformOS, markUserScrollIntentOnWeb]);
    React.useEffect(() => {
        if (deps.platformOS !== 'web' || typeof document === 'undefined') return;
        return registerWebTranscriptKeyboardOwner({
            document,
            onViewportKeyboardInput: recordWebKeyboardViewportInput,
            resolveScroller: () => deps.resolveWebScrollMetrics()?.element ?? null,
        });
    }, [
        deps.platformOS,
        deps.resolveWebScrollMetrics,
        recordWebKeyboardViewportInput,
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
                    deps.userScrollIntent.recordInput({ atMs: effect.timestampMs });
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
                    deps.userScrollIntent.recordInput({ atMs: effect.timestampMs });
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
                deps.userScrollIntent.revokeInputEvidence();
                // A trusted arrival at the bottom IS the reader back at the live tail.
                deps.userScrollIntent.releaseLiveTailParking();
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
            // The reader's measured position, into the intent owner's durable parked fact. The
            // owner parks only while raw input is live and releases on any arrival inside the pin
            // band, so growth below a following reader cannot park them and a false park heals.
            deps.userScrollIntent.observeDistanceFromLiveTail({
                atMs: Date.now(),
                distanceFromLiveTailPx: state.lastDistanceFromLiveTailPx,
                pinThresholdPx: deps.pinThresholdPxRef.current,
            });
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
        deps.pinThresholdPxRef,
        deps.platformOS,
        deps.scheduleViewportAnchorCaptureRef,
        deps.sessionId,
        deps.shouldSuppressGenericViewportStateForProtectedJumpSeq,
        deps.userScrollIntent,
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
            // Renderer-owned continuous follow still reports the reader's measured position here,
            // and it is the only observation the app gets on that path — so the parked fact must
            // be fed from it too, or the whole model is dead wherever Legend owns follow.
            deps.userScrollIntent.observeDistanceFromLiveTail({
                atMs: Date.now(),
                distanceFromLiveTailPx: state.lastDistanceFromLiveTailPx,
                pinThresholdPx: deps.pinThresholdPxRef.current,
            });
            deps.commitJumpToBottomDistanceForVisibility(state.jumpButtonDistanceFromLiveTailPx);
            deps.commitScrollPinEvent(state.scrollPinEvent);
        }
        return applied;
    }, [
        deps.commitJumpToBottomDistanceForVisibility,
        deps.commitScrollPinEvent,
        deps.lastPinOffsetForIntentRef,
        deps.pinThresholdPxRef,
        deps.sessionId,
        deps.userScrollIntent,
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
        // Untrusted/passive movement must re-debounce the pending capture, not destroy it:
        // hard invalidation here let a trailing Legend estimate-correction scroll inside the
        // debounce window permanently drop shallow-detach anchor persistence, so re-entry
        // restored the live tail instead of the detached position (live A->B->A RED
        // 2026-07-11). The capture reads fresh geometry at fire time, so deferring until
        // movement quiesces captures the settled truth.
        if (applied) deps.deferViewportAnchorCapture();
        return applied;
    }, [deps.deferViewportAnchorCapture, deps.sessionId]);
    const applyNativeMomentumSettleAwayReleaseStateEffects = React.useCallback((
        effects: readonly NativeMomentumSettleAwayReleaseStateEffect[],
    ): boolean => {
        let appliedRelease = false;
        for (const effect of effects) {
            if (effect.sessionId !== deps.sessionId) continue;
            if (effect.type !== 'apply-native-momentum-settle-away-release-state') continue;
            deps.wantsPinnedRef.current = false;
            deps.cancelScheduledPinToBottom();
            // A native momentum settle that landed away from the tail IS the reader parking.
            deps.userScrollIntent.observeDistanceFromLiveTail({
                atMs: Date.now(),
                distanceFromLiveTailPx: effect.distanceFromLiveTailPx,
                pinThresholdPx: deps.pinThresholdPxRef.current,
            });
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
        deps.pinThresholdPxRef,
        deps.scheduleViewportAnchorCaptureRef,
        deps.sessionId,
        deps.userScrollIntent,
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
    const targetWindowNearEdgeRef = React.useRef<Record<'older' | 'newer', boolean>>({
        newer: false,
        older: false,
    });
    const targetWindowAttemptKeyRef = React.useRef<Record<'older' | 'newer', string | null>>({
        newer: null,
        older: null,
    });
    const targetWindowRetryTimeoutRef = React.useRef<Record<
        'older' | 'newer',
        ReturnType<typeof setTimeout> | null
    >>({
        newer: null,
        older: null,
    });
    const targetWindowObservedIdRef = React.useRef<string | null>(null);
    const targetWindowContinuationMountedRef = React.useRef(true);
    const clearTargetWindowRetryTimeout = React.useCallback((direction: 'older' | 'newer') => {
        const timeout = targetWindowRetryTimeoutRef.current[direction];
        if (timeout == null) return;
        clearTimeout(timeout);
        targetWindowRetryTimeoutRef.current[direction] = null;
    }, []);
    React.useEffect(() => {
        targetWindowContinuationMountedRef.current = true;
        return () => {
            targetWindowContinuationMountedRef.current = false;
            clearTargetWindowRetryTimeout('older');
            clearTargetWindowRetryTimeout('newer');
        };
    }, [clearTargetWindowRetryTimeout]);
    const currentTargetWindowOwnerRef = React.useRef({
        activeTargetWindowTargetRef: deps.activeTargetWindowTargetRef,
        activeWindowState: deps.targetWindowHostFacts.activeWindowState,
        sessionId: deps.sessionId,
    });
    useCommittedTranscriptRef(currentTargetWindowOwnerRef, {
        activeTargetWindowTargetRef: deps.activeTargetWindowTargetRef,
        activeWindowState: deps.targetWindowHostFacts.activeWindowState,
        sessionId: deps.sessionId,
    });
    const drainTargetWindowContinuationsRef = React.useRef<() => void>(() => {});
    const observeTargetWindowIdentity = React.useCallback((windowId: string | null | undefined): boolean => {
        const normalizedWindowId = typeof windowId === 'string' && windowId.length > 0
            ? windowId
            : null;
        if (targetWindowObservedIdRef.current === normalizedWindowId) return normalizedWindowId !== null;
        targetWindowObservedIdRef.current = normalizedWindowId;
        clearTargetWindowRetryTimeout('older');
        clearTargetWindowRetryTimeout('newer');
        targetWindowNearEdgeRef.current = { newer: false, older: false };
        targetWindowAttemptKeyRef.current = { newer: null, older: null };
        return normalizedWindowId !== null;
    }, [clearTargetWindowRetryTimeout]);
    const drainTargetWindowContinuations: () => void = React.useCallback(() => {
        const activeWindowState = deps.targetWindowHostFacts.activeWindowState;
        if (
            !targetWindowContinuationMountedRef.current ||
            !activeWindowState ||
            !deps.sessionId ||
            !deps.sessionActive ||
            deps.isWarmKeepAliveInstance
        ) return;
        if (targetWindowObservedIdRef.current !== activeWindowState.windowId) return;
        if (!deps.olderPagination.isReadyForLoad()) return;
        if (deps.targetWindowEdgeLoadInFlightRef.current !== null) return;
        const windowId = activeWindowState.windowId;
        if (typeof windowId !== 'string' || windowId.length === 0) return;
        const direction = (['older', 'newer'] as const).find((candidate) => {
            if (!targetWindowNearEdgeRef.current[candidate]) return false;
            const hasMore = candidate === 'older'
                ? activeWindowState.hasMoreOlder
                : activeWindowState.hasMoreNewer;
            if (hasMore !== true) return false;
            const cursor = candidate === 'older'
                ? activeWindowState.olderCursor
                : activeWindowState.newerCursor;
            const attemptKey = `${windowId}:${candidate}:${cursor == null ? 'null' : Math.trunc(cursor)}`;
            return targetWindowAttemptKeyRef.current[candidate] !== attemptKey;
        });
        if (!direction) return;
        const target = resolveActiveTargetWindowContinuationTarget();
        if (!target) return;
        const cursor = direction === 'older'
            ? activeWindowState.olderCursor
            : activeWindowState.newerCursor;
        const attemptKey = `${windowId}:${direction}:${cursor == null ? 'null' : Math.trunc(cursor)}`;
        // Consume the cursor attempt only after all readiness/ownership guards pass.
        // Persistent not-ready and same-cursor results stay consumed. A classified
        // transport failure is explicitly rearmed after the ordinary pager cooldown.
        targetWindowAttemptKeyRef.current[direction] = attemptKey;
        deps.targetWindowEdgeLoadInFlightRef.current = direction;
        void (async () => {
            try {
                const routeSeqHint =
                    target.kind === 'route-message-id' &&
                    typeof target.seqHint === 'number' &&
                    Number.isFinite(target.seqHint)
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
                const result = await sync.loadTargetWindowMessages(
                    deps.sessionId,
                    loadTarget,
                    { direction },
                );
                if (
                    result?.status === 'retryable_error' &&
                    targetWindowContinuationMountedRef.current &&
                    targetWindowObservedIdRef.current === windowId &&
                    targetWindowNearEdgeRef.current[direction] &&
                    targetWindowAttemptKeyRef.current[direction] === attemptKey
                ) {
                    clearTargetWindowRetryTimeout(direction);
                    const configuredCooldownMs = sync.getSyncTuning().transcriptOlderLoadCooldownMs;
                    const cooldownMs = Number.isFinite(configuredCooldownMs)
                        ? Math.max(0, Math.trunc(configuredCooldownMs))
                        : 0;
                    targetWindowRetryTimeoutRef.current[direction] = setTimeout(() => {
                        targetWindowRetryTimeoutRef.current[direction] = null;
                        if (
                            !targetWindowContinuationMountedRef.current ||
                            targetWindowObservedIdRef.current !== windowId ||
                            !targetWindowNearEdgeRef.current[direction] ||
                            targetWindowAttemptKeyRef.current[direction] !== attemptKey
                        ) return;
                        targetWindowAttemptKeyRef.current[direction] = null;
                        drainTargetWindowContinuationsRef.current();
                    }, cooldownMs);
                }
                const currentOwner = currentTargetWindowOwnerRef.current;
                if (
                    targetWindowContinuationMountedRef.current &&
                    result?.status === 'loaded' &&
                    result.targetPresent &&
                    currentOwner.sessionId === deps.sessionId &&
                    currentOwner.activeWindowState?.windowId === windowId
                ) {
                    currentOwner.activeTargetWindowTargetRef.current = target;
                }
            } finally {
                if (deps.targetWindowEdgeLoadInFlightRef.current === direction) {
                    deps.targetWindowEdgeLoadInFlightRef.current = null;
                }
                // The opposite near edge may have been waiting behind this request
                // (especially an underfilled target window). Drain synchronously after
                // ownership is released; no unrelated gesture or timer is required.
                drainTargetWindowContinuationsRef.current();
            }
        })();
    }, [
        deps.activeTargetWindowTargetRef,
        deps.isWarmKeepAliveInstance,
        deps.olderPagination,
        deps.sessionActive,
        deps.sessionId,
        deps.targetWindowEdgeLoadInFlightRef,
        deps.targetWindowHostFacts.activeWindowState,
        clearTargetWindowRetryTimeout,
        resolveActiveTargetWindowContinuationTarget,
    ]);
    useCommittedTranscriptRef(
        drainTargetWindowContinuationsRef,
        drainTargetWindowContinuations,
    );
    const targetWindowReadinessOpen = deps.olderPagination.isReadyForLoad();
    React.useEffect(() => {
        if (!observeTargetWindowIdentity(deps.targetWindowHostFacts.activeWindowState?.windowId)) return;
        if (targetWindowReadinessOpen) drainTargetWindowContinuationsRef.current();
    }, [
        deps.targetWindowHostFacts.activeWindowState?.hasMoreNewer,
        deps.targetWindowHostFacts.activeWindowState?.hasMoreOlder,
        deps.targetWindowHostFacts.activeWindowState?.newerCursor,
        deps.targetWindowHostFacts.activeWindowState?.olderCursor,
        deps.targetWindowHostFacts.activeWindowState?.targetSeq,
        deps.targetWindowHostFacts.activeWindowState?.windowId,
        observeTargetWindowIdentity,
        targetWindowReadinessOpen,
    ]);
    const observeTargetWindowProximity = React.useCallback((near: Readonly<{
        newer: boolean;
        older: boolean;
    }>) => {
        if (!observeTargetWindowIdentity(deps.targetWindowHostFacts.activeWindowState?.windowId)) return;
        for (const direction of ['older', 'newer'] as const) {
            const wasNear = targetWindowNearEdgeRef.current[direction];
            const isNear = near[direction];
            targetWindowNearEdgeRef.current[direction] = isNear;
            if (wasNear && !isNear) {
                clearTargetWindowRetryTimeout(direction);
                targetWindowAttemptKeyRef.current[direction] = null;
            }
        }
        drainTargetWindowContinuations();
    }, [
        clearTargetWindowRetryTimeout,
        deps.targetWindowHostFacts.activeWindowState,
        drainTargetWindowContinuations,
        observeTargetWindowIdentity,
    ]);
    const observeTargetWindowReachedEdge = React.useCallback((direction: 'older' | 'newer') => {
        const activeWindowState = deps.targetWindowHostFacts.activeWindowState;
        if (!observeTargetWindowIdentity(activeWindowState?.windowId)) return;
        targetWindowNearEdgeRef.current[direction] = true;
        if (direction === 'newer' && activeWindowState?.hasMoreNewer === false) {
            sync.markSessionLiveTailIntent(deps.sessionId);
            deps.activeTargetWindowTargetRef.current = null;
            return;
        }
        drainTargetWindowContinuations();
    }, [
        deps.activeTargetWindowTargetRef,
        deps.sessionId,
        deps.targetWindowHostFacts.activeWindowState,
        drainTargetWindowContinuations,
        observeTargetWindowIdentity,
    ]);

    const observeOlderPaginationScroll = React.useCallback((params: Readonly<{
        offsetY: number;
        layoutHeight: number;
        contentHeight: number;
        distanceFromBottom: number;
        itemsToOlderEdgeOverride?: number;
        webMetrics?: WebTranscriptScrollMetrics | null;
        trigger?: TranscriptOlderPaginationScrollMetrics['trigger'];
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
        // Native px offsets above are estimate-derived; attach the estimate-immune
        // item-space proximity from the driver fact seam so the pagination machine can
        // arm before the literal top (single attach point for scroll + edge-reached).
        const itemsToOlderEdge = deps.platformOS === 'web'
            ? null
            : params.itemsToOlderEdgeOverride ?? deps.readItemsToOlderEdge?.() ?? null;
        const itemsToNewerEdge = deps.platformOS === 'web'
            ? null
            : deps.readItemsToNewerEdge?.() ?? null;
        const paginationObservation = {
            offsetY,
            scrollable: scrollable && followGateOpen,
            trigger: params.trigger,
            itemsToOlderEdge,
        };
        // Active target windows own their directional cursors. Route the same
        // canonical proximity fact to that owner before touching the ordinary
        // tail machine, so a far-jump window can prefetch before its marker is
        // visible without consuming a hidden tail cursor.
        if (deps.targetWindowActiveRef.current) {
            const underfilled = layoutHeight > 0 && contentHeight <= layoutHeight + 16;
            observeTargetWindowProximity({
                older: underfilled || deps.olderPagination.isNearOlderEdge({
                    ...paginationObservation,
                    scrollable,
                }),
                newer: underfilled || deps.olderPagination.isNearOlderEdge({
                    itemsToOlderEdge: itemsToNewerEdge,
                    offsetY: distanceFromBottom,
                    scrollable,
                    trigger: params.trigger,
                }),
            });
            return deps.targetWindowEdgeLoadInFlightRef.current !== null;
        }
        deps.olderPagination.onScrollObservation(paginationObservation);
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
        deps.readItemsToOlderEdge,
        deps.readItemsToNewerEdge,
        deps.targetWindowActiveRef,
        deps.targetWindowEdgeLoadInFlightRef,
        observeTargetWindowProximity,
    ]);

    const observePaginationEdgeReachedNudge = React.useCallback((visualEdge: 'older' | 'newer') => {
        if (deps.targetWindowActiveRef.current) {
            observeTargetWindowReachedEdge(visualEdge);
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
        observeTargetWindowReachedEdge,
        observeOlderPaginationScroll,
    ]);
    const observeCommittedProjectionLayout = React.useCallback(() => {
        if (!deps.sessionActive || deps.isWarmKeepAliveInstance) return;
        const liveWebMetrics = deps.platformOS === 'web' ? deps.resolveWebScrollMetrics() : null;
        const layoutHeight = liveWebMetrics?.clientHeight ?? deps.listLayoutHeightRef.current;
        const contentHeight = liveWebMetrics?.scrollHeight ?? deps.listContentHeightRef.current;
        const rawOffsetY = liveWebMetrics
            ? liveWebMetrics.scrollTop
            : readNativeAbsoluteScrollOffset(deps.listRef.current);
        const nativeObservedOffset = liveWebMetrics || typeof rawOffsetY !== 'number'
            ? null
            : deps.resolveNativeObservedScrollOffset(rawOffsetY, {
                contentHeight,
                layoutHeight,
            });
        if (!deps.targetWindowActiveRef.current) {
            const committedItemsToOlderEdge = deps.platformOS === 'web'
                ? null
                : deps.readItemsToOlderEdge?.() ?? null;
            // A missing native visible-range subset is unknown, not evidence that
            // a committed layout stayed at or left the edge.
            if (deps.platformOS !== 'web' && committedItemsToOlderEdge == null) return;
            // Feed every committed list layout to the existing pagination owner.
            // An exact-edge commit during a load may authorize one continuation;
            // a commit away from the edge clears that latch. Physical `start`
            // orientation never participates in this canonical-space observation.
            observeOlderPaginationScroll({
                contentHeight,
                distanceFromBottom: liveWebMetrics
                    ? getWebTranscriptDistanceFromBottom(liveWebMetrics)
                    : nativeObservedOffset?.distanceFromLiveTailPx ?? Number.MAX_SAFE_INTEGER,
                itemsToOlderEdgeOverride: committedItemsToOlderEdge ?? undefined,
                layoutHeight,
                offsetY: liveWebMetrics
                    ? liveWebMetrics.scrollTop
                    : nativeObservedOffset?.canonicalOffsetY ?? Number.MAX_SAFE_INTEGER,
                trigger: 'layout-committed',
                webMetrics: liveWebMetrics,
            });
            return;
        }

        observeOlderPaginationScroll({
            contentHeight,
            distanceFromBottom: liveWebMetrics
                ? getWebTranscriptDistanceFromBottom(liveWebMetrics)
                : nativeObservedOffset?.distanceFromLiveTailPx ?? Number.MAX_SAFE_INTEGER,
            layoutHeight,
            offsetY: liveWebMetrics
                ? liveWebMetrics.scrollTop
                : nativeObservedOffset?.canonicalOffsetY ?? Number.MAX_SAFE_INTEGER,
            trigger: 'scroll',
            webMetrics: liveWebMetrics,
        });
    }, [
        deps.isWarmKeepAliveInstance,
        deps.listContentHeightRef,
        deps.listLayoutHeightRef,
        deps.listRef,
        deps.platformOS,
        deps.readItemsToNewerEdge,
        deps.readItemsToOlderEdge,
        deps.resolveNativeObservedScrollOffset,
        deps.resolveWebScrollMetrics,
        deps.sessionActive,
        deps.targetWindowActiveRef,
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
        if (deps.platformOS !== 'web' || continuousFollowOwner === 'renderer') return;
        const resizeObserverCtor = (globalThis as Readonly<{ ResizeObserver?: typeof ResizeObserver }>).ResizeObserver;
        if (typeof resizeObserverCtor !== 'function') return;
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
            const observation = resolveWebViewportResizeObservation({
                nextMetrics,
                previousMetrics,
            });
            if (!observation) return;
            if (
                deps.wantsPinnedRef.current &&
                previousDistanceFromBottom <= deps.pinThresholdPx
            ) {
                deps.webDomObservation.recordProgrammaticScrollTopWrite({
                    element: observation.previousWebMetrics.element,
                    targetScrollTop: observation.previousWebMetrics.element.scrollHeight,
                });
            }
            deps.requestAutomaticLiveTailPin(
                observation.previousWebMetrics,
                observation.reason,
                false,
            );
        };
        const initialMetrics = deps.resolveWebScrollMetrics();
        lastWebViewportResizeMetricsRef.current = initialMetrics;
        const element = initialMetrics?.element;
        if (!element) return;
        lastWebViewportResizeMetricsRef.current = readObservedMetrics(element);
        const observer = new resizeObserverCtor(() => observeResize(element));
        observer.observe(element);
        return () => {
            observer.disconnect();
        };
    }, [
        deps.requestAutomaticLiveTailPin,
        continuousFollowOwner,
        deps.platformOS,
        deps.webDomObservation,
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
    const onScroll = React.useCallback((
        e: NativeSyntheticEvent<NativeScrollEvent>,
        webMovementFact?: WebScrollMovementFact,
    ) => {
        observeTranscriptScrollIngress({
            bottomFollowModeState: deps.bottomFollowModeStateRef.current,
            configuredBottomDistanceNoiseFloorPx:
                deps.resolveTranscriptMountSettleBottomDistanceNoiseFloorPx(),
            continuousFollowOwner,
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
            ...(webMovementFact ? { webMovementFact } : {}),
        }, transcriptScrollIngressCallbacks);
    }, [
        deps.bottomFollowModeStateRef,
        continuousFollowOwner,
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
        observeCommittedProjectionLayout,
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
        observeCommittedProjectionLayout,
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
