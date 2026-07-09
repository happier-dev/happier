import * as React from 'react';
import { Platform } from 'react-native';
import { sync, type SessionViewportAnchorSnapshot } from '@/sync/sync';
import { resolveSessionEntryViewportState } from '@/components/sessions/transcript/scroll/resolveSessionEntryBottomFollow';
import type {
    TranscriptBottomFollowModeState,
    TranscriptScrollPinState,
} from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import type { WebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import type { EntryRestoreOwner, EntryRestoreOwnerEffect } from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';
import { readSessionViewportForEntry } from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreAnchorUtilities';
import type {
    TranscriptLifecycleHost,
    TranscriptLifecycleHostSessionEntryPlan,
} from '@/components/sessions/transcript/viewport/lifecycle/lifecycleHost';
import type { TranscriptMeasurementHost } from '@/components/sessions/transcript/measurement/transcriptMeasurementHost';
import type { SessionOpenLatch } from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';
import { resolveSessionOpenWebInitialPinRetryPlan } from '@/components/sessions/transcript/viewport/sessionOpen/webInitialPinRetryPlan';
import type {
    SessionOpenArmResetPlan,
    SessionOpenDisposeResetPlan,
    SessionOpenEntryKind,
    SessionOpenInitialBottomPositionOwner,
    SessionOpenLatchEffect,
} from '@/components/sessions/transcript/viewport/sessionOpen/types';
import type { TranscriptViewportCommandController } from '@/components/sessions/transcript/viewport/createTranscriptViewportCommandController';
import type { TranscriptViewportTransactionOutcome } from '@/components/sessions/transcript/viewport/transcriptViewportOwnership';
import type { TranscriptViewportChangeState } from '@/components/sessions/transcript/chatListTypes';

type MutableRef<T> = { current: T };
type SessionEntryRenderResetEffects = TranscriptLifecycleHostSessionEntryPlan['renderResetEffects'];
type SessionEntryViewportApplyEffect = TranscriptLifecycleHostSessionEntryPlan['viewportEffects'][number];

export type SessionEntryViewportRefValue = {
    sessionId: string;
    entryKind: SessionOpenEntryKind;
    shouldFollowBottom: boolean;
    offsetY: number | null;
    anchor: SessionViewportAnchorSnapshot | null;
    sourceLastUpdatedAt: number | null;
    effects: readonly SessionEntryViewportApplyEffect[];
} | null;

type ConsumedSessionEntryViewportRefValue = {
    entryKind: SessionOpenEntryKind;
    sessionId: string;
} | null;

type NativeEntryRestorePaintReleaseTimeout = {
    issuedAtMs: number;
    sessionId: string;
    timeoutId: ReturnType<typeof setTimeout>;
} | null;

type NativeFirstPaintFallbackReleaseTimeout = {
    sessionId: string;
    timeoutId: ReturnType<typeof setTimeout>;
} | null;

type EntryRestoreDeadlineTimeout = {
    sessionId: string;
    timeoutId: ReturnType<typeof setTimeout>;
} | null;

export type TranscriptSessionEntryLifecycleDeps = Readonly<{
    applyEntryRestoreOwnerEffectsRef: MutableRef<(effects: readonly EntryRestoreOwnerEffect[]) => void>;
    applySessionOpenLatchEffectsRef: MutableRef<(effects: readonly SessionOpenLatchEffect[]) => void>;
    anchorLookupExhaustedRef: MutableRef<boolean>;
    anchorLookupInFlightRef: MutableRef<boolean>;
    anchorLookupLoadCountRef: MutableRef<number>;
    cancelScheduledPinToBottom(): void;
    clearNativePaintReleaseTimeoutsForSessionEntry(): void;
    clearWebPrependRestoreWindow(outcome: TranscriptViewportTransactionOutcome): void;
    closeEntryViewportOwnership(outcome: TranscriptViewportTransactionOutcome): void;
    commitBottomFollowModeState(next: TranscriptBottomFollowModeState): void;
    commitJumpToBottomDistanceForVisibility(distanceFromBottom: number): void;
    commitScrollPinState(next: TranscriptScrollPinState): void;
    consumedSessionEntryViewportRef: MutableRef<ConsumedSessionEntryViewportRefValue>;
    disposeEntryRestoreTransactionForExitRef: MutableRef<() => void>;
    emitViewportChange(state: TranscriptViewportChangeState): boolean;
    entryRestoreDeadlineTimeoutRef: MutableRef<EntryRestoreDeadlineTimeout>;
    entryRestoreOwner: EntryRestoreOwner;
    entrySliceWindowRef: MutableRef<{ sessionId: string; anchorRowId: string } | null>;
    flushViewportAnchorCaptureRef: MutableRef<(options?: Readonly<{ deferEmit?: boolean }>) => void>;
    hideOlderLoadSpinner(): void;
    initialBottomPositionOwner: SessionOpenInitialBottomPositionOwner;
    initialFillAbortRef: MutableRef<AbortController | null>;
    invalidateNativePrependOwner(): void;
    invalidateViewportAnchorCapture(): void;
    isLoaded: boolean;
    isPinnedRef: MutableRef<boolean>;
    getItemCount(): number;
    jumpToSeq: number | null | undefined;
    lastAutoRepinAtMsRef: MutableRef<number>;
    lastExplicitWebScrollIntentAtMsRef: MutableRef<number>;
    lastNativeRestoreIndexCommandRef: MutableRef<unknown | null>;
    lastPinOffsetForIntentRef: MutableRef<number | null>;
    lastRouteJumpProtectionClearingWebMovementAtMsRef: MutableRef<number>;
    lastScrollOffsetForIntentRef: MutableRef<number | null>;
    lastUserScrollIntentAtMsRef: MutableRef<number>;
    latestCommittedActivityKey: string | null | undefined;
    lifecycleHost: TranscriptLifecycleHost;
    listContentHeightRef: MutableRef<number>;
    listLayoutHeightRef: MutableRef<number>;
    measurementHost: Pick<TranscriptMeasurementHost, 'resetForSession'>;
    nativeBottomFollowRearmedAfterDragRef: MutableRef<boolean>;
    nativeEntryRestorePaintReleaseTimeoutRef: MutableRef<NativeEntryRestorePaintReleaseTimeout>;
    nativeFirstPaintFallbackReleaseTimeoutRef: MutableRef<NativeFirstPaintFallbackReleaseTimeout>;
    nativeMomentumScrollActiveRef: MutableRef<boolean>;
    nativeMountSettleAutoPinSuppressedRef: MutableRef<boolean>;
    pendingNativeMountSettleBottomPinHostRef: MutableRef<MutableRef<boolean> | null>;
    resetBottomFollowPinRecordsForSessionEntry(latestActivityKey: string | null | undefined): void;
    resetBottomFollowPinStateForSessionOpenArm(latestActivityKey: string | null | undefined): void;
    resetInitialFillForSessionEntry(): void;
    resetNativeMountSettleFlagsForSessionEntry(): void;
    resetNativeSessionViewportLifecycle(sessionId: string): void;
    resetOlderPaginationForSessionEntry(): void;
    resetTransientSessionEntryUiState(): void;
    resetViewportAnchorCaptureForSessionEntry(): void;
    scheduleFirstSessionOpenWebInitialPinRetryRef: MutableRef<(() => void) | null>;
    sessionEntryViewportRef: MutableRef<SessionEntryViewportRefValue>;
    sessionId: string;
    sessionOpenLatch: SessionOpenLatch;
    sessionOpenWebInitialPinRetryArmAtMsRef: MutableRef<number>;
    setEntrySliceWindow(value: { sessionId: string; anchorRowId: string } | null): void;
    setExpandedToolCallsAnchorMessageIds(value: Set<string>): void;
    setListContentHeight(value: number): void;
    viewportCommandController: TranscriptViewportCommandController;
    wantsPinnedRef: MutableRef<boolean>;
    webDomObservation: WebDomScrollObservation;
}>;

export type TranscriptSessionEntryLifecycle = Readonly<{
    applySessionEntryViewportApplyEffects(
        effects: readonly SessionEntryViewportApplyEffect[],
        entryAnchor: SessionViewportAnchorSnapshot | null,
    ): void;
    applySessionOpenArmResetPlan(plan: SessionOpenArmResetPlan): void;
    applySessionOpenDisposeResetPlan(plan: SessionOpenDisposeResetPlan): void;
}>;

export function useTranscriptSessionEntryLifecycle(
    deps: TranscriptSessionEntryLifecycleDeps,
): TranscriptSessionEntryLifecycle {
    const resetTransientSessionEntryUiState = React.useCallback(() => {
        deps.clearWebPrependRestoreWindow('abandoned-identity');
        deps.setExpandedToolCallsAnchorMessageIds(new Set());
    }, [deps.clearWebPrependRestoreWindow, deps.setExpandedToolCallsAnchorMessageIds]);

    const consumeSessionOpenArmEntryViewportState = React.useCallback(() => {
        const entryViewport = deps.sessionEntryViewportRef.current;
        const shouldFollowBottom = entryViewport?.shouldFollowBottom ?? true;
        const entryAnchor = shouldFollowBottom ? null : (entryViewport?.anchor ?? null);
        const entryEffects = entryViewport?.effects ?? [];
        if (entryViewport && entryEffects.length > 0) {
            deps.sessionEntryViewportRef.current = {
                ...entryViewport,
                effects: [],
            };
        }
        return {
            entryAnchor,
            entryEffects,
            entryOffsetY: entryViewport?.offsetY ?? null,
            shouldFollowBottom,
        };
    }, [deps.sessionEntryViewportRef]);

    const applySessionEntryViewportApplyEffects = React.useCallback((
        effects: readonly SessionEntryViewportApplyEffect[],
        entryAnchor: SessionViewportAnchorSnapshot | null,
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== deps.sessionId) continue;
            if (effect.type !== 'apply-session-entry-viewport') continue;
            deps.wantsPinnedRef.current = effect.isPinned;
            deps.isPinnedRef.current = effect.isPinned;
            deps.commitScrollPinState({
                isPinned: effect.isPinned,
                lastActivityKey: null,
                newActivityCount: 0,
            });
            deps.commitJumpToBottomDistanceForVisibility(effect.jumpButtonDistanceFromLiveTailPx);
            if (effect.shouldEmitViewportChange) {
                deps.emitViewportChange({
                    anchor: effect.shouldUseEntryAnchor ? entryAnchor : null,
                    isPinned: effect.isPinned,
                    offsetY: effect.jumpButtonDistanceFromLiveTailPx,
                    shouldRestoreViewport: effect.shouldRestoreViewport,
                });
            }
        }
    }, [
        deps.commitScrollPinState,
        deps.emitViewportChange,
        deps.sessionId,
    ]);

    const applySessionEntryRenderResetEffects = React.useCallback((sessionEntryRenderResetEffects: SessionEntryRenderResetEffects) => {
        deps.webDomObservation.reset();
        deps.nativeBottomFollowRearmedAfterDragRef.current = false;
        deps.nativeMomentumScrollActiveRef.current = false;
        deps.resetBottomFollowPinRecordsForSessionEntry(deps.latestCommittedActivityKey);
        deps.resetOlderPaginationForSessionEntry();
        if (sessionEntryRenderResetEffects.platform === 'native') {
            deps.resetNativeSessionViewportLifecycle(sessionEntryRenderResetEffects.nativeSessionViewportReset.sessionId);
        }
        deps.disposeEntryRestoreTransactionForExitRef.current();
        deps.applyEntryRestoreOwnerEffectsRef.current(deps.entryRestoreOwner.resetForSession({ sessionId: deps.sessionId }));
        deps.entrySliceWindowRef.current = null;
        const entryRestoreDeadlineTimeout = deps.entryRestoreDeadlineTimeoutRef.current;
        if (entryRestoreDeadlineTimeout) {
            deps.entryRestoreDeadlineTimeoutRef.current = null;
            clearTimeout(entryRestoreDeadlineTimeout.timeoutId);
        }
        const nativeEntryRestorePaintReleaseTimeout = deps.nativeEntryRestorePaintReleaseTimeoutRef.current;
        if (nativeEntryRestorePaintReleaseTimeout) {
            deps.nativeEntryRestorePaintReleaseTimeoutRef.current = null;
            clearTimeout(nativeEntryRestorePaintReleaseTimeout.timeoutId);
        }
        deps.invalidateNativePrependOwner();
        deps.lifecycleHost.clearNativeExplicitJumpConfirmation({ sessionId: sessionEntryRenderResetEffects.nativeExplicitJumpReset.sessionId });
        deps.lifecycleHost.resetNativeEntrySettleConfirmation({
            sessionId: sessionEntryRenderResetEffects.nativeEntrySettleReset.sessionId,
            shouldArmConfirmation: sessionEntryRenderResetEffects.nativeEntrySettleReset.shouldArmConfirmation,
        });
        deps.lastNativeRestoreIndexCommandRef.current = null;
        deps.anchorLookupLoadCountRef.current = 0;
        deps.anchorLookupInFlightRef.current = false;
        deps.anchorLookupExhaustedRef.current = false;
        deps.viewportCommandController.resetForSession({
            sessionId: deps.sessionId,
            openEntryTransaction: sessionEntryRenderResetEffects.commandControllerReset.openEntryTransaction,
        });
        deps.measurementHost.resetForSession({ sessionId: sessionEntryRenderResetEffects.measurementReset.sessionId });
    }, [
        deps.entryRestoreOwner,
        deps.latestCommittedActivityKey,
        deps.lifecycleHost,
        deps.measurementHost,
        deps.resetNativeSessionViewportLifecycle,
        deps.resetOlderPaginationForSessionEntry,
        deps.sessionId,
        deps.viewportCommandController,
        deps.webDomObservation,
    ]);

    React.useLayoutEffect(() => {
        const entryViewportSnapshot = readSessionViewportForEntry(deps.sessionId);
        const resolvedEntryViewport = resolveSessionEntryViewportState<SessionViewportAnchorSnapshot>(
            entryViewportSnapshot,
        );
        const shouldFollowBottom = resolvedEntryViewport.shouldFollowBottom;
        const persistedEntryOffsetY = resolvedEntryViewport.offsetY;
        const entryKind: SessionOpenEntryKind = deps.jumpToSeq != null
            ? 'jump'
            : (shouldFollowBottom ? 'bottom' : 'anchored');
        if (
            deps.consumedSessionEntryViewportRef.current?.sessionId === deps.sessionId &&
            deps.consumedSessionEntryViewportRef.current.entryKind === entryKind
        ) {
            return;
        }
        if (
            deps.sessionEntryViewportRef.current?.sessionId === deps.sessionId &&
            deps.sessionEntryViewportRef.current.entryKind === entryKind
        ) {
            return;
        }
        const platform = Platform.OS === 'web' ? 'web' : 'native';
        const lifecycleEntry = deps.lifecycleHost.enterSession({
            entryDistanceFromLiveTailPx: persistedEntryOffsetY,
            platform,
            sessionId: deps.sessionId,
            shouldFollowLiveTail: shouldFollowBottom,
        });
        const tuning = sync.getSyncTuning();
        const initialBottomPositionOwner = deps.initialBottomPositionOwner ?? 'app';
        const webInitialPinRetryPlan = initialBottomPositionOwner === 'app'
            ? resolveSessionOpenWebInitialPinRetryPlan(tuning)
            : { retryDelaysMs: [], stabilizeMaxMs: 0 };
        const armDecision = deps.sessionOpenLatch.arm({
            entryKind,
            initialBottomPositionOwner,
            isNativeFlashListBottomMaintenanceEnabled: Platform.OS !== 'web',
            nativeFirstPaintFallbackDelayMs:
                tuning.transcriptInitialFillBudgetMs +
                tuning.transcriptMountSettleQuiescentWindowMs * 2 +
                1,
            nowMs: Date.now(),
            platform,
            sessionId: deps.sessionId,
            shouldFollowBottom,
            webInitialPinRetryDelaysMs: webInitialPinRetryPlan.retryDelaysMs,
            webInitialPinStabilizeMs: webInitialPinRetryPlan.stabilizeMaxMs,
        });
        deps.sessionEntryViewportRef.current = {
            sessionId: deps.sessionId,
            entryKind,
            shouldFollowBottom,
            offsetY: persistedEntryOffsetY,
            anchor: resolvedEntryViewport.anchor,
            sourceLastUpdatedAt: typeof entryViewportSnapshot?.lastUpdatedAt === 'number'
                ? entryViewportSnapshot.lastUpdatedAt
                : null,
            effects: lifecycleEntry.viewportEffects,
        };
        deps.consumedSessionEntryViewportRef.current = null;
        deps.wantsPinnedRef.current = Boolean(shouldFollowBottom);
        deps.isPinnedRef.current = shouldFollowBottom;
        deps.commitBottomFollowModeState(lifecycleEntry.state.bottomFollowState);
        deps.lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
        deps.lastExplicitWebScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
        deps.lastRouteJumpProtectionClearingWebMovementAtMsRef.current = Number.NEGATIVE_INFINITY;
        deps.lastAutoRepinAtMsRef.current = Number.NEGATIVE_INFINITY;
        deps.lastPinOffsetForIntentRef.current = shouldFollowBottom ? 0 : persistedEntryOffsetY;
        deps.lastScrollOffsetForIntentRef.current = null;
        applySessionEntryRenderResetEffects(lifecycleEntry.renderResetEffects);
        deps.applySessionOpenLatchEffectsRef.current(armDecision.effects);
        deps.applySessionOpenLatchEffectsRef.current(deps.sessionOpenLatch.onHostFacts({
            contentHeight: deps.listContentHeightRef.current,
            hasEntrySliceWindow: deps.entrySliceWindowRef.current?.sessionId === deps.sessionId,
            isLoaded: deps.isLoaded,
            isScrollable: false,
            itemCount: deps.getItemCount(),
            layoutHeight: deps.listLayoutHeightRef.current,
            nowMs: Date.now(),
            sessionId: deps.sessionId,
            userWantsPinned: deps.wantsPinnedRef.current,
        }).effects);
    }, [
        applySessionEntryRenderResetEffects,
        deps.commitBottomFollowModeState,
        deps.isLoaded,
        deps.initialBottomPositionOwner,
        deps.jumpToSeq,
        deps.lifecycleHost,
        deps.sessionId,
        deps.sessionOpenLatch,
    ]);

    const applySessionOpenArmResetPlan = React.useCallback((plan: SessionOpenArmResetPlan): void => {
        if (plan.sessionId !== deps.sessionId) return;
        deps.resetViewportAnchorCaptureForSessionEntry();
        deps.resetInitialFillForSessionEntry();
        deps.resetNativeMountSettleFlagsForSessionEntry();
        deps.hideOlderLoadSpinner();
        deps.clearNativePaintReleaseTimeoutsForSessionEntry();
        deps.resetOlderPaginationForSessionEntry();
        deps.cancelScheduledPinToBottom();
        resetTransientSessionEntryUiState();
        const {
            entryAnchor,
            entryEffects,
            entryOffsetY,
            shouldFollowBottom,
        } = consumeSessionOpenArmEntryViewportState();
        deps.lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
        deps.lastExplicitWebScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
        deps.lastRouteJumpProtectionClearingWebMovementAtMsRef.current = Number.NEGATIVE_INFINITY;
        deps.lastAutoRepinAtMsRef.current = Number.NEGATIVE_INFINITY;
        deps.lastPinOffsetForIntentRef.current = shouldFollowBottom ? 0 : entryOffsetY;
        deps.lastScrollOffsetForIntentRef.current = null;
        deps.webDomObservation.reset();
        deps.resetBottomFollowPinStateForSessionOpenArm(deps.latestCommittedActivityKey);
        deps.resetNativeSessionViewportLifecycle(plan.sessionId);
        deps.invalidateNativePrependOwner();
        deps.lastNativeRestoreIndexCommandRef.current = null;
        if (Platform.OS !== 'web') {
            deps.listContentHeightRef.current = 0;
            deps.setListContentHeight(0);
        }
        const pendingNativeMountSettleBottomPinRef = deps.pendingNativeMountSettleBottomPinHostRef.current;
        if (pendingNativeMountSettleBottomPinRef) {
            pendingNativeMountSettleBottomPinRef.current = false;
        }
        if ((deps.initialBottomPositionOwner ?? 'app') === 'app') {
            deps.sessionOpenWebInitialPinRetryArmAtMsRef.current = Date.now();
        }
        applySessionEntryViewportApplyEffects(entryEffects, entryAnchor);
        if (
            (deps.initialBottomPositionOwner ?? 'app') === 'app' &&
            Platform.OS === 'web' &&
            shouldFollowBottom
        ) {
            deps.scheduleFirstSessionOpenWebInitialPinRetryRef.current?.();
        }
    }, [
        applySessionEntryViewportApplyEffects,
        consumeSessionOpenArmEntryViewportState,
        deps.cancelScheduledPinToBottom,
        deps.clearNativePaintReleaseTimeoutsForSessionEntry,
        deps.hideOlderLoadSpinner,
        deps.initialBottomPositionOwner,
        deps.latestCommittedActivityKey,
        deps.resetInitialFillForSessionEntry,
        deps.resetNativeMountSettleFlagsForSessionEntry,
        deps.resetNativeSessionViewportLifecycle,
        deps.resetOlderPaginationForSessionEntry,
        deps.resetViewportAnchorCaptureForSessionEntry,
        deps.sessionId,
        deps.webDomObservation,
        resetTransientSessionEntryUiState,
    ]);

    const applySessionOpenDisposeResetPlan = React.useCallback((plan: SessionOpenDisposeResetPlan): void => {
        if (plan.reason !== 'session-switch' && plan.reason !== 'disposed') return;
        deps.resetInitialFillForSessionEntry();
        deps.clearNativePaintReleaseTimeoutsForSessionEntry();
        deps.cancelScheduledPinToBottom();
        const pendingNativeMountSettleBottomPinRef = deps.pendingNativeMountSettleBottomPinHostRef.current;
        if (pendingNativeMountSettleBottomPinRef) {
            pendingNativeMountSettleBottomPinRef.current = false;
        }
    }, [
        deps.cancelScheduledPinToBottom,
        deps.clearNativePaintReleaseTimeoutsForSessionEntry,
        deps.pendingNativeMountSettleBottomPinHostRef,
        deps.resetInitialFillForSessionEntry,
    ]);

    return {
        applySessionEntryViewportApplyEffects,
        applySessionOpenArmResetPlan,
        applySessionOpenDisposeResetPlan,
    };
}
