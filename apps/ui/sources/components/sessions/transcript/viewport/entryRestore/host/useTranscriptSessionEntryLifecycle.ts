import * as React from 'react';
import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';
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
import type {
    SessionOpenArmResetPlan,
    SessionOpenDisposeResetPlan,
    SessionOpenEntryKind,
    SessionOpenLatchEffect,
} from '@/components/sessions/transcript/viewport/sessionOpen/types';
import type { TranscriptViewportCommandController } from '@/components/sessions/transcript/viewport/createTranscriptViewportCommandController';
import type { TranscriptViewportTransactionOutcome } from '@/components/sessions/transcript/viewport/transcriptViewportOwnership';
import type { TranscriptViewportChangeState } from '@/components/sessions/transcript/chatListTypes';
import type { TranscriptExitEntrySnapshot } from '@/components/sessions/transcript/viewport/lifecycle/transcriptSameSessionHandoff';

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
    closeEntryViewportOwnership(outcome: TranscriptViewportTransactionOutcome): void;
    commitBottomFollowModeState(next: TranscriptBottomFollowModeState): void;
    commitJumpToBottomDistanceForVisibility(distanceFromBottom: number): void;
    commitScrollPinState(next: TranscriptScrollPinState): void;
    consumedSessionEntryViewportRef: MutableRef<ConsumedSessionEntryViewportRefValue>;
    disposeEntryRestoreTransactionForExitRef: MutableRef<() => void>;
    emitViewportChange(state: TranscriptViewportChangeState): boolean;
    entryRestoreDeadlineTimeoutRef: MutableRef<EntryRestoreDeadlineTimeout>;
    entryRestoreOwner: EntryRestoreOwner;
    flushViewportAnchorCaptureRef: MutableRef<(options?: Readonly<{ deferEmit?: boolean }>) => void>;
    hideOlderLoadSpinner(): void;
    initialFillAbortRef: MutableRef<AbortController | null>;
    invalidateNativePrependOwner(): void;
    invalidateViewportAnchorCapture(): void;
    isLoaded: boolean;
    isPinnedRef: MutableRef<boolean>;
    getItemCount(): number;
    jumpToSeq: number | null | undefined;
    lastExplicitWebScrollIntentAtMsRef: MutableRef<number>;
    lastNativeRestoreIndexCommandRef: MutableRef<unknown | null>;
    lastPinOffsetForIntentRef: MutableRef<number | null>;
    lastRouteJumpProtectionClearingWebMovementAtMsRef: MutableRef<number>;
    lastScrollOffsetForIntentRef: MutableRef<number | null>;
    lastUserScrollIntentAtMsRef: MutableRef<number>;
    lifecycleHost: TranscriptLifecycleHost;
    listContentHeightRef: MutableRef<number>;
    listLayoutHeightRef: MutableRef<number>;
    measurementHost: Pick<TranscriptMeasurementHost, 'resetForSession'>;
    nativeBottomFollowRearmedAfterDragRef: MutableRef<boolean>;
    nativeEntryRestorePaintReleaseTimeoutRef: MutableRef<NativeEntryRestorePaintReleaseTimeout>;
    nativeFirstPaintFallbackReleaseTimeoutRef: MutableRef<NativeFirstPaintFallbackReleaseTimeout>;
    nativeMomentumScrollActiveRef: MutableRef<boolean>;
    resetNativeMountSettleFlagsForSessionEntry(): void;
    /**
     * Reset the native first-paint reveal flags (viewport-paint-observed +
     * entry-restore-paint-released) for the NEW entry. These are per-ENTRY reveal
     * state: a warm keep-alive re-entry into the same session re-arms and may run a
     * fresh restore transaction, and stale true flags from the previous entry forced
     * the placeholder off while that restore's write + post-measure correction ran on
     * screen (live measured cascade 2026-07-12).
     */
    resetNativeFirstPaintRevealStateForSessionEntry(): void;
    resetNativeSessionViewportLifecycle(sessionId: string): void;
    resetOlderPaginationForSessionEntry(): void;
    resetViewportAnchorCaptureForSessionEntry(): void;
    sameSessionHandoffClaimedViewportRef: MutableRef<TranscriptExitEntrySnapshot | null>;
    sameSessionHandoffViewportForRender: TranscriptExitEntrySnapshot | null;
    sessionEntryViewportRef: MutableRef<SessionEntryViewportRefValue>;
    sessionId: string;
    sessionOpenLatch: SessionOpenLatch;
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
    /**
     * Render-time entry intent from the immutable per-(sessionId,jumpToSeq) snapshot: true when
     * this session's entry follows the live tail. This is the canonical basis for Legend's
     * initial tail placement — the live bottom-follow mode ref lags one render behind on
     * warm-instance session switches.
     */
    entryShouldFollowBottomForRender: boolean;
    entryAnchorForRender: SessionViewportAnchorSnapshot | null;
}>;

export function useTranscriptSessionEntryLifecycle(
    deps: TranscriptSessionEntryLifecycleDeps,
): TranscriptSessionEntryLifecycle {
    // Capture entry intent during the parent render. Renderer children run their layout effects
    // before this host's layout effect and can publish provisional at-end facts while their empty
    // geometry mounts. Those facts may update the live sync viewport, but they must not rewrite
    // the immutable snapshot that this specific entry transaction was opened to restore.
    const entryViewportSnapshotForRenderRef = React.useRef<{
        jumpToSeq: number | null;
        sessionId: string;
        snapshot: ReturnType<typeof readSessionViewportForEntry>;
    } | null>(null);
    const entryJumpToSeq = deps.jumpToSeq ?? null;
    const handoffViewportForRender = entryJumpToSeq === null
        ? deps.sameSessionHandoffViewportForRender
        : null;
    const handoffSnapshotForRender = handoffViewportForRender
        ? {
            ...handoffViewportForRender,
            lastUpdatedAt: handoffViewportForRender.capturedAtMs,
            source: 'observed' as const,
        }
        : null;
    const committedEntryViewportSnapshot = entryViewportSnapshotForRenderRef.current;
    const entryViewportSnapshotForRender =
        committedEntryViewportSnapshot?.sessionId === deps.sessionId &&
        committedEntryViewportSnapshot.jumpToSeq === entryJumpToSeq
            ? committedEntryViewportSnapshot
            : {
            jumpToSeq: entryJumpToSeq,
            sessionId: deps.sessionId,
            snapshot: handoffSnapshotForRender ?? readSessionViewportForEntry(deps.sessionId),
        };
    useCommittedTranscriptRef(
        entryViewportSnapshotForRenderRef,
        entryViewportSnapshotForRender,
    );
    const resolvedEntryViewportForRender = resolveSessionEntryViewportState(
        entryViewportSnapshotForRender.snapshot,
    );
    const resetTransientSessionEntryUiState = React.useCallback(() => {
        deps.setExpandedToolCallsAnchorMessageIds(new Set());
    }, [deps.setExpandedToolCallsAnchorMessageIds]);

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
        deps.resetOlderPaginationForSessionEntry();
        if (sessionEntryRenderResetEffects.platform === 'native') {
            deps.resetNativeSessionViewportLifecycle(sessionEntryRenderResetEffects.nativeSessionViewportReset.sessionId);
        }
        deps.disposeEntryRestoreTransactionForExitRef.current();
        deps.applyEntryRestoreOwnerEffectsRef.current(deps.entryRestoreOwner.resetForSession({ sessionId: deps.sessionId }));
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
        deps.lifecycleHost,
        deps.measurementHost,
        deps.resetNativeSessionViewportLifecycle,
        deps.resetOlderPaginationForSessionEntry,
        deps.sessionId,
        deps.viewportCommandController,
        deps.webDomObservation,
    ]);

    React.useLayoutEffect(() => {
        const claimedHandoffViewport = entryJumpToSeq === null
            ? deps.sameSessionHandoffClaimedViewportRef.current
            : null;
        const entryViewportSnapshot = claimedHandoffViewport
            ? {
                ...claimedHandoffViewport,
                lastUpdatedAt: claimedHandoffViewport.capturedAtMs,
                source: 'observed' as const,
            }
            : entryViewportSnapshotForRender.snapshot;
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
        const armDecision = deps.sessionOpenLatch.arm({
            entryKind,
            nativeFirstPaintFallbackDelayMs:
                tuning.transcriptInitialFillBudgetMs +
                tuning.transcriptMountSettleQuiescentWindowMs * 2 +
                1,
            nowMs: Date.now(),
            platform,
            sessionId: deps.sessionId,
            shouldFollowBottom,
            // Matches the fill executor's absolute ceiling: past this, the open
            // phase is over no matter what.
            webOpenPhaseDeadlineDelayMs: tuning.transcriptInitialFillBudgetMs * 5,
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
        deps.lastPinOffsetForIntentRef.current = shouldFollowBottom ? 0 : persistedEntryOffsetY;
        deps.lastScrollOffsetForIntentRef.current = null;
        applySessionEntryRenderResetEffects(lifecycleEntry.renderResetEffects);
        deps.applySessionOpenLatchEffectsRef.current(armDecision.effects);
        deps.applySessionOpenLatchEffectsRef.current(deps.sessionOpenLatch.onHostFacts({
            contentHeight: deps.listContentHeightRef.current,
            isLoaded: deps.isLoaded,
            isScrollable: false,
            itemCount: deps.getItemCount(),
            layoutHeight: deps.listLayoutHeightRef.current,
            nowMs: Date.now(),
            sessionId: deps.sessionId,
        }).effects);
    }, [
        applySessionEntryRenderResetEffects,
        deps.commitBottomFollowModeState,
        deps.isLoaded,
        entryViewportSnapshotForRender.snapshot,
        deps.jumpToSeq,
        deps.lifecycleHost,
        deps.sessionId,
        deps.sessionOpenLatch,
    ]);

    const resetInitialFillForSessionEntry = React.useCallback(() => {
        deps.initialFillAbortRef.current?.abort();
        deps.initialFillAbortRef.current = null;
    }, [deps.initialFillAbortRef]);
    const clearNativePaintReleaseTimeoutsForSessionEntry = React.useCallback(() => {
        const nativeFirstPaintFallbackReleaseTimeout = deps.nativeFirstPaintFallbackReleaseTimeoutRef.current;
        if (nativeFirstPaintFallbackReleaseTimeout) {
            deps.nativeFirstPaintFallbackReleaseTimeoutRef.current = null;
            clearTimeout(nativeFirstPaintFallbackReleaseTimeout.timeoutId);
        }
        const nativeEntryRestorePaintReleaseTimeout = deps.nativeEntryRestorePaintReleaseTimeoutRef.current;
        if (nativeEntryRestorePaintReleaseTimeout) {
            deps.nativeEntryRestorePaintReleaseTimeoutRef.current = null;
            clearTimeout(nativeEntryRestorePaintReleaseTimeout.timeoutId);
        }
    }, [
        deps.nativeEntryRestorePaintReleaseTimeoutRef,
        deps.nativeFirstPaintFallbackReleaseTimeoutRef,
    ]);

    const applySessionOpenArmResetPlan = React.useCallback((plan: SessionOpenArmResetPlan): void => {
        if (plan.sessionId !== deps.sessionId) return;
        deps.resetViewportAnchorCaptureForSessionEntry();
        resetInitialFillForSessionEntry();
        deps.resetNativeMountSettleFlagsForSessionEntry();
        deps.resetNativeFirstPaintRevealStateForSessionEntry();
        deps.hideOlderLoadSpinner();
        clearNativePaintReleaseTimeoutsForSessionEntry();
        deps.resetOlderPaginationForSessionEntry();
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
        deps.lastPinOffsetForIntentRef.current = shouldFollowBottom ? 0 : entryOffsetY;
        deps.lastScrollOffsetForIntentRef.current = null;
        deps.webDomObservation.reset();
        deps.resetNativeSessionViewportLifecycle(plan.sessionId);
        deps.invalidateNativePrependOwner();
        deps.lastNativeRestoreIndexCommandRef.current = null;
        if (Platform.OS !== 'web') {
            deps.listContentHeightRef.current = 0;
            deps.setListContentHeight(0);
        }
        applySessionEntryViewportApplyEffects(entryEffects, entryAnchor);
    }, [
        applySessionEntryViewportApplyEffects,
        clearNativePaintReleaseTimeoutsForSessionEntry,
        consumeSessionOpenArmEntryViewportState,
        deps.hideOlderLoadSpinner,
        deps.resetNativeMountSettleFlagsForSessionEntry,
        deps.resetNativeSessionViewportLifecycle,
        deps.resetOlderPaginationForSessionEntry,
        deps.resetViewportAnchorCaptureForSessionEntry,
        deps.sessionId,
        deps.webDomObservation,
        resetInitialFillForSessionEntry,
        resetTransientSessionEntryUiState,
    ]);

    const applySessionOpenDisposeResetPlan = React.useCallback((plan: SessionOpenDisposeResetPlan): void => {
        if (plan.reason !== 'session-switch' && plan.reason !== 'disposed') return;
        resetInitialFillForSessionEntry();
        clearNativePaintReleaseTimeoutsForSessionEntry();
    }, [
        clearNativePaintReleaseTimeoutsForSessionEntry,
        resetInitialFillForSessionEntry,
    ]);

    return {
        applySessionEntryViewportApplyEffects,
        applySessionOpenArmResetPlan,
        applySessionOpenDisposeResetPlan,
        entryAnchorForRender:
            entryJumpToSeq === null && !resolvedEntryViewportForRender.shouldFollowBottom
                ? resolvedEntryViewportForRender.anchor
                : null,
        entryShouldFollowBottomForRender: resolvedEntryViewportForRender.shouldFollowBottom,
    };
}
