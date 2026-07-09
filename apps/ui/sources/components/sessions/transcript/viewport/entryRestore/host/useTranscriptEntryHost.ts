import * as React from 'react';
import { Platform } from 'react-native';
import { getStorage } from '@/sync/domains/state/storage';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { sync, type SessionViewportAnchorSnapshot } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import { TRANSCRIPT_VISUAL_UPDATE_FALLBACK_TIMEOUT_MS } from '@/components/sessions/transcript/_constants';
import type {
    TranscriptViewportTelemetryEvent,
    TranscriptViewportTelemetryObservationReason,
    TranscriptViewportTelemetryScrollReason,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import { resolveTranscriptInitialFillTuning } from '@/components/sessions/transcript/scroll/resolveTranscriptInitialFillTuning';
import type { RestoreDecisionTelemetryParams } from '@/components/sessions/transcript/viewport/telemetryHost/viewportEvents';
import { readNativeAbsoluteScrollOffset } from '@/components/sessions/transcript/viewport/driver/readNativeAbsoluteScrollOffset';
import {
    type TranscriptViewportCommand,
    type TranscriptViewportControllerInput,
    type TranscriptViewportMode,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type { TranscriptViewportTransactionOutcome } from '@/components/sessions/transcript/viewport/transcriptViewportOwnership';
import type { ScrollableChatListRef } from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';
import type {
    EntryRestoreOwner,
    EntryRestoreOwnerAnchor,
    EntryRestoreOwnerEffect,
} from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';
import type { EntryRestoreSliceTarget } from '@/components/sessions/transcript/viewport/entryRestore/resolveEntryRestoreTarget';
import {
    canUseWriteFreeEntrySliceForAnchorOffset,
} from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreAnchorUtilities';
import {
    resolveTranscriptViewportAnchorIndex,
} from '@/components/sessions/transcript/viewport/entryRestore/transcriptViewportAnchorResolution';
import type { SessionOpenLatch } from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';
import { resolveSessionOpenWebInitialPinRetryPlan } from '@/components/sessions/transcript/viewport/sessionOpen/webInitialPinRetryPlan';
import type {
    SessionOpenArmResetPlan,
    SessionOpenDisposeResetPlan,
    SessionOpenEntryKind,
    SessionOpenLatchEffect,
} from '@/components/sessions/transcript/viewport/sessionOpen/types';
import {
    resolveNativeTranscriptViewportAnchorRestoreObservation,
} from '@/components/sessions/transcript/viewport/driver/transcriptNativeViewportAnchor';
import { resolveNativeSliceEntryObservation } from '@/components/sessions/transcript/viewport/nativeEntryRestoreObservationPolicy';
import {
    didWebViewportAnchorRestoreSucceed,
} from '@/components/sessions/transcript/viewport/prepend/webViewportAnchorRestoreResult';
import {
    resolveWebTranscriptViewportAnchorAlignment,
    type WebTranscriptViewportAnchor,
    type WebTranscriptViewportAnchorRestoreResult,
} from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import {
    getWebTranscriptDistanceFromBottom,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type {
    TranscriptPrependOlderLoadOptions,
    TranscriptPrependOlderLoadResult,
} from '@/components/sessions/transcript/viewport/prepend/host/runTranscriptPrependOlderLoad';
import type { TranscriptRenderWindowProjection } from '@/components/sessions/transcript/viewport/window/resolveTranscriptRenderWindowProjection';
import { waitForVisualUpdateWithTimeout } from '@/components/sessions/transcript/pagination/waitForVisualUpdateWithTimeout';

type MutableRef<T> = { current: T };
type LoadOlderOptions = TranscriptPrependOlderLoadOptions;

export type SessionEntryViewportRefValue = {
    sessionId: string;
    entryKind: SessionOpenEntryKind;
    shouldFollowBottom: boolean;
    offsetY: number | null;
    anchor: SessionViewportAnchorSnapshot | null;
    sourceLastUpdatedAt: number | null;
    effects: readonly SessionEntryViewportApplyEffect[];
} | null;

export type ConsumedSessionEntryViewportRefValue = {
    entryKind: SessionOpenEntryKind;
    sessionId: string;
} | null;

export type EntrySliceWindow = {
    sessionId: string;
    anchorRowId: string;
} | null;

type SessionEntryViewportApplyEffect = Readonly<{
    isPinned: boolean;
    jumpButtonDistanceFromLiveTailPx: number;
    sessionId: string;
    shouldEmitViewportChange: boolean;
    shouldRestoreViewport: boolean;
    shouldUseEntryAnchor: boolean;
    type: 'apply-session-entry-viewport';
}>;

type TranscriptEntryHostDeps = Readonly<{
    anchorLookupExhaustedRef: MutableRef<boolean>;
    anchorLookupInFlightRef: MutableRef<boolean>;
    anchorLookupLoadCountRef: MutableRef<number>;
    applyEntryRestoreOwnerEffectsRef: MutableRef<(effects: readonly EntryRestoreOwnerEffect[]) => void>;
    applySessionOpenArmResetPlan(plan: SessionOpenArmResetPlan): void;
    applySessionOpenDisposeResetPlan(plan: SessionOpenDisposeResetPlan): void;
    applySessionOpenLatchEffectsRef: MutableRef<(effects: readonly SessionOpenLatchEffect[]) => void>;
    attemptEntryRestoreRef: MutableRef<() => void>;
    autoPinDelayMs: number;
    closeEntryViewportOwnership(outcome: TranscriptViewportTransactionOutcome): void;
    committedMessagesCount: number;
    composerInsetHeightRef: MutableRef<number>;
    currentSessionIdRef: MutableRef<string>;
    decomposedItems: readonly ChatTranscriptListItem[];
    displayItemsLength: number;
    disposeEntryRestoreTransactionForExitRef: MutableRef<() => void>;
    entryRestoreDeadlineTimeoutRef: MutableRef<{
        sessionId: string;
        timeoutId: ReturnType<typeof setTimeout>;
    } | null>;
    entryRestoreOwner: EntryRestoreOwner;
    entrySliceWindowRef: MutableRef<EntrySliceWindow>;
    executeViewportCommand(command: TranscriptViewportCommand): boolean;
    hasNativeContentMeasurementForCurrentSession(): boolean;
    initialFillAbortRef: MutableRef<AbortController | null>;
    initialWebPinStabilizingRef: MutableRef<boolean>;
    invalidateViewportAnchorCapture(): void;
    isLoaded: boolean;
    isScrollable(): boolean;
    isViewportAnchorSeqLoaded(seq: number, items: readonly ChatTranscriptListItem[]): boolean;
    jumpToSeq: number | null | undefined;
    jumpToSeqActiveRef: MutableRef<boolean>;
    lastScrollOffsetForIntentRef: MutableRef<number | null>;
    lastUserScrollIntentAtMsRef: MutableRef<number>;
    latestJumpToSeqRef: MutableRef<number | null>;
    listContentHeight: number;
    listContentHeightRef: MutableRef<number>;
    listDataLength: number;
    listDataRef: MutableRef<readonly ChatTranscriptListItem[]>;
    listLayoutHeight: number;
    listLayoutHeightRef: MutableRef<number>;
    listRef: MutableRef<ScrollableChatListRef | null>;
    loadOlder(options?: LoadOlderOptions): Promise<TranscriptPrependOlderLoadResult | null>;
    markNativeInitialViewportAppliedForCurrentSession(): void;
    nativeMountSettleDeadlineReachedRef: MutableRef<boolean>;
    observeMountSettleMetrics(): void;
    pinThresholdPx: number;
    pinToBottom(reason: TranscriptViewportTelemetryScrollReason): boolean;
    pinToBottomRespectingNativeMountSettle(reason: TranscriptViewportTelemetryScrollReason): void;
    recordRestoreDecisionTelemetry(
        reason: TranscriptViewportTelemetryObservationReason,
        params?: RestoreDecisionTelemetryParams,
    ): void;
    recordViewportTelemetryEvent(
        event: Readonly<Record<string, unknown> & {
            mode: TranscriptViewportMode;
            type: TranscriptViewportTelemetryEvent['type'];
        }>,
        options?: Readonly<{ sessionId?: string }>,
    ): void;
    renderWindowProjection: TranscriptRenderWindowProjection<ChatTranscriptListItem>;
    requestBottomFollowScheduledWriteRef: MutableRef<(
        previousWebMetrics?: WebTranscriptScrollMetrics | null,
        reason?: TranscriptViewportTelemetryScrollReason,
        nativePrevFollowAtBottom?: boolean,
        writer?: 'settle-reconfirm',
    ) => void>;
    resolveEntryRestoreOwnerAnchor(
        anchor: SessionViewportAnchorSnapshot,
        sourceIndex: number | null,
        items: readonly ChatTranscriptListItem[],
    ): EntryRestoreOwnerAnchor | null;
    resolveNearestSurvivingViewportAnchorIndex(anchor: SessionViewportAnchorSnapshot): number | null;
    resolveNearestSurvivingViewportAnchorIndexFromItems(
        anchor: SessionViewportAnchorSnapshot,
        items: readonly ChatTranscriptListItem[],
    ): number | null;
    resolveSeqForViewportAnchor(anchor: SessionViewportAnchorSnapshot): number | null;
    resolveViewportCommand(input: TranscriptViewportControllerInput): TranscriptViewportCommand;
    resolveWebScrollMetrics(): WebTranscriptScrollMetrics | null;
    restoreWebViewportAnchorThroughViewportCommand(params: Readonly<{
        anchor: WebTranscriptViewportAnchor;
        itemIndex?: number | null;
        reason?: Extract<TranscriptViewportTelemetryScrollReason, 'content-size-change' | 'entry-restore'>;
    }>): WebTranscriptViewportAnchorRestoreResult;
    revealEntrySliceWindow(): number;
    scheduleNativePaintReleaseForEntryRestore(options?: Readonly<{ force?: boolean }>): void;
    scheduleFirstSessionOpenWebInitialPinRetryRef: MutableRef<(() => void) | null>;
    sessionEntryViewportRef: MutableRef<SessionEntryViewportRefValue>;
    sessionId: string;
    sessionOpenLatch: SessionOpenLatch;
    sessionOpenWebInitialPinRetryArmAtMsRef: MutableRef<number>;
    sessionOpenWebInitialPinRetryTimeoutRef: MutableRef<{
        deadlineAtMs: number;
        retryIndex: number;
        sessionId: string;
        timeoutId: ReturnType<typeof setTimeout>;
    } | null>;
    setEntrySliceWindow(value: EntrySliceWindow): void;
    setNativeMountSettleDeadlineReached(value: boolean): void;
    updateNativeInitialViewportPendingObservation(pending: boolean): void;
    updateNativeViewportPaintObserved(observed: boolean): void;
    waitForNextVisualUpdate(): Promise<void>;
    wantsPinnedRef: MutableRef<boolean>;
}>;

export type TranscriptEntryHost = Readonly<{
    applyEntryRestoreOwnerEffects(effects: readonly EntryRestoreOwnerEffect[]): void;
    applySessionOpenLatchEffects(effects: readonly SessionOpenLatchEffect[]): void;
    disposeEntryRestoreTransactionForExit(): void;
    observeNativeEntryRestoreHostFacts(params: Readonly<{
        contentHeight: number;
        distanceFromBottom: number;
        layoutHeight: number;
        nowMs: number;
        offsetY: number;
        rawOffsetY?: number;
        targetKind?: 'slice-anchor';
    }>): readonly EntryRestoreOwnerEffect[];
    runEntryRestoreAttempt(): void;
    verifyNativeSliceEntryRestoreTransaction(): void;
    verifyWebEntryRestoreTransaction(): void;
}>;

export function useTranscriptEntryHost(deps: TranscriptEntryHostDeps): TranscriptEntryHost {
    const requestSessionOpenInitialFillRef = React.useRef<() => void>(() => {});
    const hasObservedScrollSinceSessionEntry = React.useCallback((): boolean => {
        if (
            deps.lastUserScrollIntentAtMsRef.current !== Number.NEGATIVE_INFINITY ||
            deps.lastScrollOffsetForIntentRef.current !== null
        ) {
            return true;
        }
        const currentViewport = typeof sync.getSessionViewport === 'function'
            ? sync.getSessionViewport(deps.sessionId)
            : null;
        if (currentViewport?.source !== 'observed' || currentViewport.isPinned !== false) return false;
        const entrySourceLastUpdatedAt = deps.sessionEntryViewportRef.current?.sourceLastUpdatedAt;
        return (
            typeof currentViewport.lastUpdatedAt === 'number' &&
            currentViewport.lastUpdatedAt !== entrySourceLastUpdatedAt
        );
    }, [
        deps.lastScrollOffsetForIntentRef,
        deps.lastUserScrollIntentAtMsRef,
        deps.sessionEntryViewportRef,
        deps.sessionId,
    ]);

    const resolveEntryRestoreCanonicalMetrics = React.useCallback((): { contentHeight: number; layoutHeight: number } => {
        if (Platform.OS === 'web') {
            const metrics = deps.resolveWebScrollMetrics();
            return {
                contentHeight: metrics ? Math.max(0, Math.trunc(metrics.scrollHeight)) : 0,
                layoutHeight: metrics ? Math.max(0, Math.trunc(metrics.clientHeight)) : 0,
            };
        }
        if (!deps.hasNativeContentMeasurementForCurrentSession()) {
            return { contentHeight: 0, layoutHeight: deps.listLayoutHeightRef.current };
        }
        const contentHeight = Math.max(0, Math.trunc(deps.listContentHeightRef.current - deps.composerInsetHeightRef.current));
        return { contentHeight, layoutHeight: deps.listLayoutHeightRef.current };
    }, [deps.hasNativeContentMeasurementForCurrentSession, deps.resolveWebScrollMetrics]);

    const applyEntryRestoreOwnerEffects = React.useCallback((
        effects: readonly EntryRestoreOwnerEffect[],
    ) => {
        for (const effect of effects) {
            switch (effect.type) {
                case 'execute-command': {
                    let issued = false;
                    let scrollToIndexRequested = false;
                    if (effect.command.type === 'restore-web-anchor-through-command') {
                        const restoreResult = deps.restoreWebViewportAnchorThroughViewportCommand({
                            anchor: {
                                ...effect.command.anchor,
                                messageId: effect.command.anchor.messageId ?? null,
                            },
                            itemIndex: effect.command.itemIndex,
                        });
                        scrollToIndexRequested = restoreResult.status === 'scroll_requested';
                        issued = didWebViewportAnchorRestoreSucceed(restoreResult);
                        if (issued) {
                            const metrics = deps.resolveWebScrollMetrics();
                            if (metrics) {
                                deps.applyEntryRestoreOwnerEffectsRef.current(deps.entryRestoreOwner.observeWeb({
                                    contentHeight: metrics.scrollHeight,
                                    layoutHeight: metrics.clientHeight,
                                    nowMs: Date.now(),
                                    observation: { status: 'aligned' },
                                    sessionId: deps.sessionId,
                                }));
                            }
                        }
                        if (!issued && !scrollToIndexRequested) {
                            const entryViewportForFallback = deps.sessionEntryViewportRef.current;
                            const fallbackOffsetY =
                                entryViewportForFallback?.sessionId === deps.sessionId
                                    ? entryViewportForFallback.offsetY
                                    : null;
                            if (typeof fallbackOffsetY === 'number' && fallbackOffsetY > 0) {
                                const fallbackMetrics = deps.resolveWebScrollMetrics();
                                // Guard: only attempt the distance-from-bottom fallback when the
                                // content is fully rendered at the target depth. On a fresh mount
                                // listDataRef may be empty (listData length=0 triggers the hot-tail
                                // guard prematurely) while scrollHeight is still 0. Writing
                                // scrollTop=0 in that state closes the transaction with
                                // lastClosedSessionId set, permanently blocking future restores.
                                const fallbackDistancePx = Math.max(0, Math.trunc(fallbackOffsetY));
                                const fallbackIsReachable = fallbackMetrics != null &&
                                    Math.max(0, fallbackMetrics.scrollHeight - fallbackMetrics.clientHeight) >= fallbackDistancePx;
                                if (fallbackIsReachable) {
                                    const fallbackCommand = deps.resolveViewportCommand({
                                        contentHeight: fallbackMetrics.scrollHeight,
                                        distanceFromLiveTailPx: Math.max(0, Math.trunc(fallbackOffsetY)),
                                        reason: 'entry-restore',
                                        sessionId: deps.sessionId,
                                        type: 'restore-distance',
                                    });
                                    issued = deps.executeViewportCommand(fallbackCommand);
                                    if (issued) {
                                        deps.applyEntryRestoreOwnerEffectsRef.current(deps.entryRestoreOwner.observeWeb({
                                            contentHeight: fallbackMetrics.scrollHeight,
                                            layoutHeight: fallbackMetrics.clientHeight,
                                            nowMs: Date.now(),
                                            observation: { status: 'aligned' },
                                            sessionId: deps.sessionId,
                                        }));
                                    }
                                }
                            }
                        }
                    } else {
                        const command = deps.resolveViewportCommand(effect.command);
                        const commandWithContentHeight =
                            Platform.OS !== 'web' &&
                            command.kind === 'restore-distance' &&
                            effect.command.type === 'restore-distance' &&
                            typeof effect.command.contentHeight === 'number'
                                ? { ...command, contentHeight: effect.command.contentHeight }
                                : command;
                        issued = deps.executeViewportCommand(commandWithContentHeight);
                    }
                    if (!issued) {
                        deps.applyEntryRestoreOwnerEffectsRef.current(deps.entryRestoreOwner.markInitialCommandFailed({
                            sessionId: deps.sessionId,
                        }));
                        if (scrollToIndexRequested) {
                            const attemptRef = deps.attemptEntryRestoreRef;
                            setTimeout(() => {
                                attemptRef.current?.();
                            }, 300);
                        }
                    }
                    break;
                }
                case 'schedule-entry-deadline': {
                    const scheduled = deps.entryRestoreDeadlineTimeoutRef.current;
                    if (scheduled) {
                        deps.entryRestoreDeadlineTimeoutRef.current = null;
                        clearTimeout(scheduled.timeoutId);
                    }
                    const handle = {
                        sessionId: effect.sessionId,
                        timeoutId: null as unknown as ReturnType<typeof setTimeout>,
                    };
                    handle.timeoutId = setTimeout(() => {
                        if (deps.entryRestoreDeadlineTimeoutRef.current !== handle) return;
                        deps.entryRestoreDeadlineTimeoutRef.current = null;
                        deps.applyEntryRestoreOwnerEffectsRef.current(deps.entryRestoreOwner.runDeadline({
                            nowMs: Number.MAX_SAFE_INTEGER,
                            sessionId: handle.sessionId,
                        }));
                    }, Math.max(0, Math.trunc(effect.deadlineMs)));
                    deps.entryRestoreDeadlineTimeoutRef.current = handle;
                    break;
                }
                case 'clear-entry-deadline': {
                    const scheduled = deps.entryRestoreDeadlineTimeoutRef.current;
                    if (!scheduled) break;
                    deps.entryRestoreDeadlineTimeoutRef.current = null;
                    clearTimeout(scheduled.timeoutId);
                    break;
                }
                case 'set-native-initial-viewport-pending-observation':
                    deps.updateNativeInitialViewportPendingObservation(effect.pending);
                    break;
                case 'set-entry-slice-window':
                    deps.entrySliceWindowRef.current = {
                        anchorRowId: effect.anchorRowId,
                        sessionId: effect.sessionId,
                    };
                    deps.setEntrySliceWindow(deps.entrySliceWindowRef.current);
                    break;
                case 'clear-entry-slice-window':
                    deps.entrySliceWindowRef.current = null;
                    deps.setEntrySliceWindow(null);
                    break;
                case 'request-bounded-materialization':
                    requestBoundedEntryViewportMaterialization();
                    break;
                case 'request-bottom-follow-write':
                    if (effect.sessionId === deps.sessionId) {
                        deps.requestBottomFollowScheduledWriteRef.current(null, effect.reason, false, effect.writer);
                    }
                    break;
                case 'close-entry-ownership':
                    deps.closeEntryViewportOwnership(effect.outcome);
                    break;
                case 'record-restore-decision':
                    deps.recordRestoreDecisionTelemetry(effect.reason, {
                        mode: effect.mode,
                        offsetY: effect.offsetY,
                        contentHeight: effect.contentHeight,
                        layoutHeight: effect.layoutHeight,
                    });
                    break;
                case 'record-restore-decision-for-session':
                    deps.recordViewportTelemetryEvent({
                        type: 'restore-decision',
                        mode: effect.mode,
                        reason: effect.reason,
                        offsetY: effect.offsetY,
                    }, { sessionId: effect.sessionId });
                    break;
                case 'native-initial-viewport-applied':
                    deps.updateNativeInitialViewportPendingObservation(false);
                    deps.invalidateViewportAnchorCapture();
                    deps.markNativeInitialViewportAppliedForCurrentSession();
                    break;
                case 'schedule-native-entry-paint-release':
                    deps.updateNativeInitialViewportPendingObservation(false);
                    deps.scheduleNativePaintReleaseForEntryRestore({ force: effect.force });
                    break;
                case 'reveal-entry-slice-window':
                    deps.revealEntrySliceWindow();
                    break;
            }
        }
    }, [
        deps.closeEntryViewportOwnership,
        deps.entryRestoreOwner,
        deps.executeViewportCommand,
        deps.invalidateViewportAnchorCapture,
        deps.markNativeInitialViewportAppliedForCurrentSession,
        deps.sessionId,
        deps.recordRestoreDecisionTelemetry,
        deps.recordViewportTelemetryEvent,
        deps.resolveViewportCommand,
        deps.resolveWebScrollMetrics,
        deps.restoreWebViewportAnchorThroughViewportCommand,
        deps.scheduleNativePaintReleaseForEntryRestore,
        deps.updateNativeInitialViewportPendingObservation,
    ]);
    deps.applyEntryRestoreOwnerEffectsRef.current = applyEntryRestoreOwnerEffects;

    const resolveEntryRestoreDeadlineMs = React.useCallback((): number => {
        const tuning = sync.getSyncTuning();
        return resolveTranscriptInitialFillTuning({
            transcriptInitialFillBudgetMs: tuning.transcriptInitialFillBudgetMs,
            transcriptInitialFillMaxNoProgressLoads: tuning.transcriptInitialFillMaxNoProgressLoads,
        }).budgetMs;
    }, []);

    const disposeEntryRestoreTransactionForExit = React.useCallback(() => {
        applyEntryRestoreOwnerEffects(deps.entryRestoreOwner.disposeForExit({
            currentSessionId: deps.currentSessionIdRef.current,
        }));
    }, [
        applyEntryRestoreOwnerEffects,
        deps.entryRestoreOwner,
    ]);
    deps.disposeEntryRestoreTransactionForExitRef.current = disposeEntryRestoreTransactionForExit;

    const canRequestBoundedEntryViewportMaterialization = React.useCallback((): boolean => {
        if (deps.anchorLookupExhaustedRef.current) return false;
        if (deps.anchorLookupInFlightRef.current) return true;
        return deps.anchorLookupLoadCountRef.current < sync.getSyncTuning().transcriptViewportAnchorOlderLookupMaxLoads;
    }, []);

    const requestBoundedEntryViewportMaterialization = React.useCallback((): boolean => {
        if (deps.anchorLookupInFlightRef.current) return true;
        if (deps.anchorLookupExhaustedRef.current) return false;
        const maxLoads = sync.getSyncTuning().transcriptViewportAnchorOlderLookupMaxLoads;
        if (deps.anchorLookupLoadCountRef.current >= maxLoads) return false;
        deps.anchorLookupInFlightRef.current = true;
        deps.anchorLookupLoadCountRef.current += 1;
        fireAndForget((async () => {
            let shouldRetryRestore = false;
            try {
                const result = await deps.loadOlder({ preservePrependViewport: false, showLoadingIndicator: false });
                shouldRetryRestore = true;
                if (result && (result.status === 'no_more' || result.hasMore === false)) {
                    deps.anchorLookupExhaustedRef.current = true;
                }
                await Promise.resolve();
                await Promise.resolve();
            } finally {
                deps.anchorLookupInFlightRef.current = false;
            }
            if (shouldRetryRestore) {
                deps.attemptEntryRestoreRef.current();
            }
        })(), { tag: 'ChatList.restoreEntryAnchorLookup' });
        return true;
    }, [deps.loadOlder]);

    const verifyWebEntryRestoreTransaction = React.useCallback(() => {
        if (Platform.OS !== 'web') return;
        if (
            hasObservedScrollSinceSessionEntry()
        ) {
            applyEntryRestoreOwnerEffects(deps.entryRestoreOwner.preempt({
                reason: 'trusted-scroll',
                sessionId: deps.sessionId,
            }));
            return;
        }
        const metrics = deps.resolveWebScrollMetrics();
        if (!metrics) return;
        const tolerancePx = Math.max(deps.pinThresholdPx, 2);
        const effects = deps.entryRestoreOwner.observeWebHostFacts({
            contentHeight: metrics.scrollHeight,
            distanceFromBottom: getWebTranscriptDistanceFromBottom(metrics),
            layoutHeight: metrics.clientHeight,
            nowMs: Date.now(),
            resolveAnchorObservation: (anchor) => {
                const alignment = resolveWebTranscriptViewportAnchorAlignment({
                    container: metrics.element,
                    anchor: { ...anchor, messageId: anchor.messageId ?? null },
                    tolerancePx,
                });
                return alignment.status === 'aligned' || alignment.status === 'misaligned'
                    ? { status: alignment.status }
                    : null;
            },
            sessionId: deps.sessionId,
            tolerancePx,
            wantsPinned: deps.wantsPinnedRef.current,
        });
        applyEntryRestoreOwnerEffects(effects);
    }, [
        applyEntryRestoreOwnerEffects,
        deps.entryRestoreOwner,
        hasObservedScrollSinceSessionEntry,
        deps.pinThresholdPx,
        deps.sessionId,
        deps.resolveWebScrollMetrics,
    ]);

    const observeNativeEntryRestoreHostFacts = React.useCallback((params: Readonly<{
        contentHeight: number;
        distanceFromBottom: number;
        layoutHeight: number;
        nowMs: number;
        offsetY: number;
        rawOffsetY?: number;
        targetKind?: 'slice-anchor';
    }>): readonly EntryRestoreOwnerEffect[] => {
        const tolerancePx = Math.max(deps.pinThresholdPx, 2);
        return deps.entryRestoreOwner.observeNativeHostFacts({
            contentHeight: params.contentHeight,
            distanceFromBottom: params.distanceFromBottom,
            layoutHeight: params.layoutHeight,
            nowMs: params.nowMs,
            observedOffsetY: params.offsetY,
            resolveAnchorObservation: (anchor) => {
                const nativeAnchor: SessionViewportAnchorSnapshot = {
                    ...anchor,
                    capturedAtMs: anchor.capturedAtMs ?? Date.now(),
                };
                const anchorIndex = resolveTranscriptViewportAnchorIndex({
                    anchor: nativeAnchor,
                    items: deps.listDataRef.current,
                }) ?? deps.resolveNearestSurvivingViewportAnchorIndex(nativeAnchor);
                if (anchorIndex == null) return null;
                const observation = resolveNativeTranscriptViewportAnchorRestoreObservation({
                    ref: deps.listRef.current,
                    index: anchorIndex,
                    itemOffsetPx: anchor.itemOffsetPx,
                    tolerancePx,
                });
                if (observation.status === 'aligned' || observation.status === 'misaligned') {
                    return { status: observation.status };
                }
                return null;
            },
            resolveSliceObservation: (anchor) => {
                const anchorIndex = resolveTranscriptViewportAnchorIndex({
                    anchor,
                    items: deps.listDataRef.current,
                });
                if (anchorIndex == null) return null;
                const layout = (() => {
                    try {
                        return deps.listRef.current?.getLayout?.(anchorIndex) ?? null;
                    } catch {
                        return null;
                    }
                })();
                const visibleRange = (() => {
                    try {
                        return deps.listRef.current?.computeVisibleIndices?.() ?? null;
                    } catch {
                        return null;
                    }
                })();
                const status = resolveNativeSliceEntryObservation({
                    anchorIndex,
                    anchorLayout: layout,
                    absoluteScrollOffset: params.rawOffsetY ?? params.offsetY,
                    contentHeight: params.contentHeight,
                    itemOffsetPx: anchor.itemOffsetPx,
                    layoutHeight: deps.listLayoutHeightRef.current,
                    tolerancePx,
                    visibleRange,
                });
                return status === 'inconclusive' ? null : { status };
            },
            sessionId: deps.sessionId,
            targetKind: params.targetKind,
            tolerancePx,
        });
    }, [deps.entryRestoreOwner, deps.pinThresholdPx, deps.sessionId, deps.resolveNearestSurvivingViewportAnchorIndex]);

    const verifyNativeSliceEntryRestoreTransaction = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        if (!deps.entryRestoreOwner.hasOpenTransaction(deps.sessionId)) return;
        const effects = observeNativeEntryRestoreHostFacts({
            contentHeight: deps.listContentHeightRef.current,
            distanceFromBottom: 0,
            layoutHeight: deps.listLayoutHeightRef.current,
            nowMs: Date.now(),
            offsetY: readNativeAbsoluteScrollOffset(deps.listRef.current) ?? Number.NaN,
            targetKind: 'slice-anchor',
        });
        if (effects.length === 0) return;
        applyEntryRestoreOwnerEffects(effects);
        if (effects.some((effect) => effect.type === 'native-initial-viewport-applied')) {
            deps.updateNativeViewportPaintObserved(true);
        }
    }, [applyEntryRestoreOwnerEffects, deps.entryRestoreOwner, observeNativeEntryRestoreHostFacts, deps.sessionId, deps.updateNativeViewportPaintObserved]);

    const runEntryRestoreAttempt = React.useCallback((): void => {
        const entryViewport = deps.sessionEntryViewportRef.current;
        if (!entryViewport || entryViewport.sessionId !== deps.sessionId) return;
        const { contentHeight, layoutHeight } = resolveEntryRestoreCanonicalMetrics();
        const renderedItems = deps.listDataRef.current;
        const items = Platform.OS === 'web' ? deps.decomposedItems : renderedItems;
        const anchor = entryViewport.anchor;
        const exactAnchorSourceIndex = anchor
            ? resolveTranscriptViewportAnchorIndex({ anchor, items })
            : null;
        const nearestAnchorSourceIndex = anchor ? deps.resolveNearestSurvivingViewportAnchorIndexFromItems(anchor, items) : null;
        const toCommandIndex = (sourceIndex: number | null): number | null => {
            if (sourceIndex == null) return null;
            return Platform.OS === 'web'
                ? deps.renderWindowProjection.indexMap.sourceIndexToRenderedIndex(sourceIndex)
                : sourceIndex;
        };
        const exactAnchorCommandIndex = toCommandIndex(exactAnchorSourceIndex);
        const nearestAnchorCommandIndex = toCommandIndex(nearestAnchorSourceIndex);
        const anchorSeq = anchor ? deps.resolveSeqForViewportAnchor(anchor) : null;
        const restoredAnchorForOwner = anchor
            ? deps.resolveEntryRestoreOwnerAnchor(anchor, exactAnchorSourceIndex ?? nearestAnchorSourceIndex, items)
            : null;
        const resolveEntrySliceRenderedAnchor = (sliceTarget: EntryRestoreSliceTarget): EntryRestoreOwnerAnchor | null => {
            const baseAnchor: SessionViewportAnchorSnapshot = {
                kind: anchor?.kind ?? 'message',
                messageId: sliceTarget.anchorMessageId,
                itemId: anchor?.itemId ?? sliceTarget.anchorMessageId,
                itemOffsetPx: sliceTarget.anchorItemOffsetPx,
                capturedAtMs: anchor?.capturedAtMs ?? Date.now(),
            };
            if (resolveTranscriptViewportAnchorIndex({ anchor: baseAnchor, items: deps.listDataRef.current }) != null) {
                return baseAnchor;
            }
            const state = getStorage().getState();
            const session = state?.sessionMessages?.[deps.sessionId];
            const messagesById: Record<string, Message | undefined> =
                session?.messagesById ?? session?.messagesMap ?? {};
            let renderedId: string | null = null;
            for (const message of Object.values(messagesById)) {
                if (message?.realID === sliceTarget.anchorMessageId) {
                    renderedId = message.id;
                    break;
                }
            }
            if (renderedId == null && sliceTarget.anchorSeq != null) {
                for (const message of Object.values(messagesById)) {
                    if (
                        typeof message?.seq === 'number' &&
                        Math.trunc(message.seq) === sliceTarget.anchorSeq
                    ) {
                        renderedId = message.id;
                        break;
                    }
                }
            }
            if (renderedId == null) return null;
            return { ...baseAnchor, messageId: renderedId, itemId: renderedId };
        };
        const sliceTarget: EntryRestoreSliceTarget | null =
            Platform.OS !== 'web' &&
            !deps.sessionOpenLatch.isEntrySliceDegraded(deps.sessionId) &&
            anchor &&
            typeof anchor.messageId === 'string' &&
            anchor.messageId.trim().length > 0
                ? {
                    kind: 'slice',
                    anchorMessageId: anchor.messageId,
                    anchorSeq,
                    anchorItemOffsetPx: Number.isFinite(anchor.itemOffsetPx) ? anchor.itemOffsetPx : 0,
                }
                : null;
        const renderedSliceAnchor = sliceTarget ? resolveEntrySliceRenderedAnchor(sliceTarget) : null;
        const renderedSliceIndex = renderedSliceAnchor
            ? resolveTranscriptViewportAnchorIndex({ anchor: renderedSliceAnchor, items: deps.listDataRef.current })
            : null;
        const anchorRowId =
            renderedSliceIndex != null && typeof deps.listDataRef.current[renderedSliceIndex]?.id === 'string'
                ? deps.listDataRef.current[renderedSliceIndex].id
                : null;
        const effects = deps.entryRestoreOwner.attempt({
            canMaterializeOlder: canRequestBoundedEntryViewportMaterialization(),
            contentHeight,
            currentSessionId: deps.sessionId,
            deadlineMs: resolveEntryRestoreDeadlineMs(),
            exactAnchorCommandIndex,
            exactAnchorIndex: exactAnchorSourceIndex,
            fillSettled: deps.sessionOpenLatch.initialFillStatus() === 'done',
            items,
            jumpToSeqActive: deps.jumpToSeq != null || deps.latestJumpToSeqRef.current != null,
            layoutHeight,
            nearestAnchorCommandIndex,
            nearestAnchorIndex: nearestAnchorSourceIndex,
            nowMs: Date.now(),
            platform: Platform.OS === 'web' ? 'web' : 'native',
            restoredViewport: {
                anchor: restoredAnchorForOwner,
                anchorSeqLoaded: anchorSeq != null ? deps.isViewportAnchorSeqLoaded(anchorSeq, items) : false,
                offsetY: typeof entryViewport.offsetY === 'number' ? entryViewport.offsetY : null,
                sessionId: entryViewport.sessionId,
                shouldFollowBottom: entryViewport.shouldFollowBottom,
            },
            slice: sliceTarget
                ? {
                    anchorRowId,
                    capable: true,
                    renderedAnchor: renderedSliceAnchor,
                    renderedAnchorIndex: renderedSliceIndex,
                    target: sliceTarget,
                    writeFree: canUseWriteFreeEntrySliceForAnchorOffset(sliceTarget.anchorItemOffsetPx),
                }
                : { capable: false },
            userScrollObserved:
                hasObservedScrollSinceSessionEntry(),
        });
        if (
            sliceTarget &&
            effects.length === 0 &&
            deps.entryRestoreOwner.telemetryState(deps.sessionId) === 'none'
        ) {
            deps.sessionOpenLatch.markEntrySliceDegraded(deps.sessionId);
        }
        applyEntryRestoreOwnerEffects(effects);
        if (Platform.OS === 'web' && deps.sessionOpenLatch.initialFillStatus() === 'done') {
            verifyWebEntryRestoreTransaction();
        }
    }, [
        applyEntryRestoreOwnerEffects,
        canRequestBoundedEntryViewportMaterialization,
        deps.decomposedItems,
        deps.entryRestoreOwner,
        deps.isViewportAnchorSeqLoaded,
        deps.jumpToSeq,
        deps.renderWindowProjection,
        deps.resolveEntryRestoreOwnerAnchor,
        deps.resolveNearestSurvivingViewportAnchorIndexFromItems,
        deps.resolveSeqForViewportAnchor,
        deps.sessionId,
        deps.sessionOpenLatch,
        resolveEntryRestoreCanonicalMetrics,
        resolveEntryRestoreDeadlineMs,
        verifyWebEntryRestoreTransaction,
    ]);
    deps.attemptEntryRestoreRef.current = runEntryRestoreAttempt;

    React.useLayoutEffect(() => {
        runEntryRestoreAttempt();
        if (Platform.OS === 'web') {
            verifyWebEntryRestoreTransaction();
        } else {
            verifyNativeSliceEntryRestoreTransaction();
        }
    }, [
        deps.listContentHeight,
        deps.listDataLength,
        deps.listLayoutHeight,
        deps.sessionId,
        runEntryRestoreAttempt,
        verifyNativeSliceEntryRestoreTransaction,
        verifyWebEntryRestoreTransaction,
    ]);

    const beginSessionOpenWebBottomEntry = React.useCallback((deadlineMs: number): boolean => {
        if (Platform.OS !== 'web') return false;
        if (deps.entryRestoreOwner.hasOpenTransaction(deps.sessionId)) return true;
        const metrics = deps.resolveWebScrollMetrics();
        if (!metrics) return false;
        deps.pinToBottom('initial-open');
        applyEntryRestoreOwnerEffects(deps.entryRestoreOwner.beginWebBottom({
            contentHeight: Math.max(0, Math.trunc(metrics.scrollHeight)),
            deadlineMs,
            layoutHeight: Math.max(0, Math.trunc(metrics.clientHeight)),
            nowMs: Date.now(),
            sessionId: deps.sessionId,
        }));
        return deps.entryRestoreOwner.hasOpenTransaction(deps.sessionId);
    }, [applyEntryRestoreOwnerEffects, deps.entryRestoreOwner, deps.pinToBottom, deps.resolveWebScrollMetrics, deps.sessionId]);

    const executeSessionOpenInitialPinAttempt = React.useCallback((): boolean => {
        if (Platform.OS === 'web') {
            if (deps.wantsPinnedRef.current === false) {
                deps.applyEntryRestoreOwnerEffectsRef.current(deps.entryRestoreOwner.preempt({
                    reason: 'trusted-scroll',
                    sessionId: deps.sessionId,
                }));
                deps.initialWebPinStabilizingRef.current = false;
                return true;
            }
            if (Date.now() - deps.lastUserScrollIntentAtMsRef.current < deps.autoPinDelayMs) return false;
            let pinApplied = false;
            if (!deps.entryRestoreOwner.hasOpenTransaction(deps.sessionId)) {
                pinApplied = deps.pinToBottom('initial-open');
            }
            if (deps.entryRestoreOwner.hasOpenTransaction(deps.sessionId)) {
                verifyWebEntryRestoreTransaction();
            }
            if (!deps.entryRestoreOwner.hasOpenTransaction(deps.sessionId)) {
                if (!pinApplied) {
                    return false;
                }
                deps.initialWebPinStabilizingRef.current = false;
                return true;
            }
            return false;
        }
        deps.pinToBottomRespectingNativeMountSettle('initial-open');
        return false;
    }, [
        deps.applyEntryRestoreOwnerEffectsRef,
        deps.autoPinDelayMs,
        deps.entryRestoreOwner,
        deps.initialWebPinStabilizingRef,
        deps.lastUserScrollIntentAtMsRef,
        deps.pinToBottom,
        deps.pinToBottomRespectingNativeMountSettle,
        deps.sessionId,
        deps.wantsPinnedRef,
        verifyWebEntryRestoreTransaction,
    ]);

    const clearSessionOpenWebInitialPinRetry = React.useCallback((): void => {
        const existing = deps.sessionOpenWebInitialPinRetryTimeoutRef.current;
        if (!existing) return;
        clearTimeout(existing.timeoutId);
        deps.sessionOpenWebInitialPinRetryTimeoutRef.current = null;
        deps.initialWebPinStabilizingRef.current = false;
    }, [
        deps.initialWebPinStabilizingRef,
        deps.sessionOpenWebInitialPinRetryTimeoutRef,
    ]);

    const scheduleSessionOpenWebInitialPinRetry = React.useCallback((deadlineAtMs: number, retryIndex = 0): void => {
        if (Platform.OS !== 'web') return;
        if (deps.jumpToSeqActiveRef.current) return;
        const existing = deps.sessionOpenWebInitialPinRetryTimeoutRef.current;
        if (existing) {
            if (existing.sessionId === deps.sessionId && existing.deadlineAtMs <= deadlineAtMs) return;
            clearSessionOpenWebInitialPinRetry();
        }
        deps.initialWebPinStabilizingRef.current = true;
        const timeoutId = setTimeout(() => {
            const handle = deps.sessionOpenWebInitialPinRetryTimeoutRef.current;
            if (!handle || handle.timeoutId !== timeoutId) return;
            deps.sessionOpenWebInitialPinRetryTimeoutRef.current = null;
            if (handle.sessionId !== deps.currentSessionIdRef.current) return;
            if (deps.jumpToSeqActiveRef.current) return;
            const completed = executeSessionOpenInitialPinAttempt();
            if (
                !completed &&
                deps.wantsPinnedRef.current !== false &&
                !deps.entryRestoreOwner.hasOpenTransaction(handle.sessionId) &&
                Date.now() - deps.lastUserScrollIntentAtMsRef.current >= deps.autoPinDelayMs
            ) {
                deps.pinToBottom('initial-open');
            }
            const retryPlan = resolveSessionOpenWebInitialPinRetryPlan(sync.getSyncTuning());
            const nextRetryIndex = handle.retryIndex + 1;
            const nextRetryDelayMs = retryPlan.retryDelaysMs[nextRetryIndex];
            if (
                !deps.jumpToSeqActiveRef.current &&
                deps.wantsPinnedRef.current !== false &&
                typeof nextRetryDelayMs === 'number' &&
                Number.isFinite(nextRetryDelayMs) &&
                Date.now() - deps.lastUserScrollIntentAtMsRef.current >= deps.autoPinDelayMs
            ) {
                scheduleSessionOpenWebInitialPinRetry(
                    deps.sessionOpenWebInitialPinRetryArmAtMsRef.current + Math.max(0, Math.trunc(nextRetryDelayMs)),
                    nextRetryIndex,
                );
            }
        }, Math.max(0, deadlineAtMs - Date.now()));
        deps.sessionOpenWebInitialPinRetryTimeoutRef.current = {
            deadlineAtMs,
            retryIndex,
            sessionId: deps.sessionId,
            timeoutId,
        };
    }, [
        deps.autoPinDelayMs,
        deps.currentSessionIdRef,
        deps.entryRestoreOwner,
        deps.initialWebPinStabilizingRef,
        deps.jumpToSeqActiveRef,
        deps.lastUserScrollIntentAtMsRef,
        deps.pinToBottom,
        deps.sessionId,
        deps.sessionOpenWebInitialPinRetryArmAtMsRef,
        deps.sessionOpenWebInitialPinRetryTimeoutRef,
        deps.wantsPinnedRef,
        clearSessionOpenWebInitialPinRetry,
        executeSessionOpenInitialPinAttempt,
    ]);

    const scheduleFirstSessionOpenWebInitialPinRetry = React.useCallback((): void => {
        if (Platform.OS !== 'web' || deps.sessionOpenWebInitialPinRetryTimeoutRef.current) return;
        const [retryDelayMs] = resolveSessionOpenWebInitialPinRetryPlan(sync.getSyncTuning()).retryDelaysMs;
        if (typeof retryDelayMs !== 'number' || !Number.isFinite(retryDelayMs)) return;
        scheduleSessionOpenWebInitialPinRetry(
            deps.sessionOpenWebInitialPinRetryArmAtMsRef.current + Math.max(0, Math.trunc(retryDelayMs)),
            0,
        );
    }, [
        deps.sessionOpenWebInitialPinRetryArmAtMsRef,
        deps.sessionOpenWebInitialPinRetryTimeoutRef,
        scheduleSessionOpenWebInitialPinRetry,
    ]);
    deps.scheduleFirstSessionOpenWebInitialPinRetryRef.current = scheduleFirstSessionOpenWebInitialPinRetry;

    React.useEffect(() => {
        return () => {
            clearSessionOpenWebInitialPinRetry();
        };
    }, [clearSessionOpenWebInitialPinRetry, deps.sessionId]);

    React.useEffect(() => {
        if (
            Platform.OS !== 'web' ||
            !deps.sessionId ||
            !deps.isLoaded ||
            deps.jumpToSeq != null ||
            (
                deps.sessionEntryViewportRef.current !== null &&
                (
                    deps.sessionEntryViewportRef.current.sessionId !== deps.sessionId ||
                    deps.sessionEntryViewportRef.current.shouldFollowBottom === false
                )
            ) ||
            deps.entryRestoreOwner.hasOpenTransaction(deps.sessionId)
        ) {
            return;
        }
        scheduleFirstSessionOpenWebInitialPinRetry();
    }, [
        deps.entryRestoreOwner,
        deps.isLoaded,
        deps.jumpToSeq,
        deps.sessionEntryViewportRef,
        deps.sessionId,
        scheduleFirstSessionOpenWebInitialPinRetry,
    ]);

    const applySessionOpenLatchEffects = React.useCallback((effects: readonly SessionOpenLatchEffect[]): void => {
        for (const effect of effects) {
            switch (effect.type) {
                case 'apply-arm-reset-plan':
                    deps.applySessionOpenArmResetPlan(effect.plan);
                    continue;
                case 'apply-dispose-reset-plan':
                    deps.applySessionOpenDisposeResetPlan(effect.plan);
                    continue;
                case 'hold-native-first-paint-placeholder':
                    continue;
                case 'release-native-first-paint-placeholder':
                    deps.nativeMountSettleDeadlineReachedRef.current = true;
                    deps.setNativeMountSettleDeadlineReached(true);
                    deps.updateNativeInitialViewportPendingObservation(false);
                    break;
                case 'request-initial-pin': {
                    const completed = executeSessionOpenInitialPinAttempt();
                    if (!completed) scheduleFirstSessionOpenWebInitialPinRetry();
                    break;
                }
                case 'begin-web-bottom-entry':
                    if (beginSessionOpenWebBottomEntry(effect.deadlineMs)) {
                        verifyWebEntryRestoreTransaction();
                    }
                    break;
                case 'schedule-web-initial-pin-retry':
                    scheduleSessionOpenWebInitialPinRetry(effect.deadlineAtMs);
                    break;
                case 'request-initial-fill':
                    requestSessionOpenInitialFillRef.current();
                    break;
                case 'request-entry-restore-attempt':
                    runEntryRestoreAttempt();
                    verifyWebEntryRestoreTransaction();
                    break;
            }
        }
    }, [
        beginSessionOpenWebBottomEntry,
        deps.applySessionOpenArmResetPlan,
        deps.applySessionOpenDisposeResetPlan,
        deps.nativeMountSettleDeadlineReachedRef,
        deps.setNativeMountSettleDeadlineReached,
        deps.updateNativeInitialViewportPendingObservation,
        executeSessionOpenInitialPinAttempt,
        runEntryRestoreAttempt,
        scheduleFirstSessionOpenWebInitialPinRetry,
        scheduleSessionOpenWebInitialPinRetry,
        verifyWebEntryRestoreTransaction,
    ]);
    deps.applySessionOpenLatchEffectsRef.current = applySessionOpenLatchEffects;

    React.useLayoutEffect(() => {
        if (!deps.sessionId || !deps.isLoaded || deps.jumpToSeq != null) return;
        const sessionEntryViewport = deps.sessionEntryViewportRef.current;
        if (
            Platform.OS === 'web' &&
            deps.sessionOpenLatch.phase() !== 'done' &&
            (
                sessionEntryViewport === null ||
                (
                    sessionEntryViewport.sessionId === deps.sessionId &&
                    sessionEntryViewport.shouldFollowBottom !== false
                )
            )
        ) {
            const completed = executeSessionOpenInitialPinAttempt();
            if (!completed) scheduleFirstSessionOpenWebInitialPinRetry();
        }
        applySessionOpenLatchEffects(deps.sessionOpenLatch.onHostFacts({
            contentHeight: deps.listContentHeightRef.current,
            hasEntrySliceWindow: deps.entrySliceWindowRef.current?.sessionId === deps.sessionId,
            isLoaded: deps.isLoaded,
            isScrollable: false,
            itemCount: deps.listDataLength,
            layoutHeight: deps.listLayoutHeightRef.current,
            nowMs: Date.now(),
            sessionId: deps.sessionId,
            userWantsPinned: deps.wantsPinnedRef.current,
        }).effects);
    }, [
        applySessionOpenLatchEffects,
        deps.entrySliceWindowRef,
        deps.isLoaded,
        deps.jumpToSeq,
        deps.listContentHeightRef,
        deps.listDataLength,
        deps.listLayoutHeightRef,
        deps.sessionEntryViewportRef,
        deps.sessionId,
        deps.sessionOpenLatch,
        deps.wantsPinnedRef,
        executeSessionOpenInitialPinAttempt,
        scheduleFirstSessionOpenWebInitialPinRetry,
    ]);

    React.useEffect(() => {
        if (!deps.sessionId || !deps.isLoaded || deps.jumpToSeq != null) return;
        const sessionEntryViewport = deps.sessionEntryViewportRef.current;
        if (
            Platform.OS === 'web' &&
            deps.sessionOpenLatch.phase() !== 'done' &&
            (
                sessionEntryViewport === null ||
                (
                    sessionEntryViewport.sessionId === deps.sessionId &&
                    sessionEntryViewport.shouldFollowBottom !== false
                )
            )
        ) {
            const completed = executeSessionOpenInitialPinAttempt();
            if (!completed) scheduleFirstSessionOpenWebInitialPinRetry();
        }
        applySessionOpenLatchEffects(deps.sessionOpenLatch.onHostFacts({
            contentHeight: deps.listContentHeightRef.current,
            hasEntrySliceWindow: deps.entrySliceWindowRef.current?.sessionId === deps.sessionId,
            isLoaded: deps.isLoaded,
            isScrollable: false,
            itemCount: deps.listDataLength,
            layoutHeight: deps.listLayoutHeightRef.current,
            nowMs: Date.now(),
            sessionId: deps.sessionId,
            userWantsPinned: deps.wantsPinnedRef.current,
        }).effects);
    }, [
        applySessionOpenLatchEffects,
        deps.entrySliceWindowRef,
        deps.isLoaded,
        deps.jumpToSeq,
        deps.listContentHeightRef,
        deps.listDataLength,
        deps.listLayoutHeightRef,
        deps.sessionEntryViewportRef,
        deps.sessionId,
        deps.sessionOpenLatch,
        deps.wantsPinnedRef,
        executeSessionOpenInitialPinAttempt,
        scheduleFirstSessionOpenWebInitialPinRetry,
    ]);

    const requestSessionOpenInitialFill = React.useCallback(() => {
        if (!deps.isLoaded) return;
        if (deps.jumpToSeq != null) return;
        if (!deps.sessionId) return;
        if (deps.sessionOpenLatch.initialFillStatus() !== 'idle') return;
        if (deps.listLayoutHeight <= 0 || deps.listContentHeight <= 0) return;
        if (!deps.sessionOpenLatch.markInitialFillInProgress(deps.sessionId)) return;
        deps.initialFillAbortRef.current?.abort();
        const controller = new AbortController();
        deps.initialFillAbortRef.current = controller;
        const signal = controller.signal;
        const shouldPinDuringInitialFill = deps.sessionEntryViewportRef.current?.shouldFollowBottom !== false;
        fireAndForget((async () => {
            if (shouldPinDuringInitialFill) {
                deps.pinToBottomRespectingNativeMountSettle('initial-open');
                if (Platform.OS === 'web') {
                    await waitForVisualUpdateWithTimeout({
                        waitForNextVisualUpdate: deps.waitForNextVisualUpdate,
                        timeoutMs: TRANSCRIPT_VISUAL_UPDATE_FALLBACK_TIMEOUT_MS,
                    });
                }
            }
            const tuning = sync.getSyncTuning();
            const startedAtMs = Date.now();
            const { budgetMs, maxNoProgressLoads } = resolveTranscriptInitialFillTuning({
                transcriptInitialFillBudgetMs: tuning.transcriptInitialFillBudgetMs,
                transcriptInitialFillMaxNoProgressLoads: tuning.transcriptInitialFillMaxNoProgressLoads,
            });
            let consecutiveNoProgressLoads = 0;
            while (true) {
                if (signal.aborted) return;
                if (deps.isScrollable() && deps.committedMessagesCount > 0) break;
                if (deps.entrySliceWindowRef.current?.sessionId === deps.sessionId) break;
                if (Date.now() - startedAtMs >= budgetMs) break;
                const result = await deps.loadOlder({ preservePrependViewport: false, showLoadingIndicator: false });
                if (!result) break;
                if (result.status === 'no_more') break;
                const madeProgress = result.status === 'loaded' && result.loaded > 0;
                consecutiveNoProgressLoads = madeProgress ? 0 : consecutiveNoProgressLoads + 1;
                await Promise.resolve();
                await Promise.resolve();
                if (shouldPinDuringInitialFill && deps.wantsPinnedRef.current) {
                    deps.pinToBottomRespectingNativeMountSettle('initial-open');
                }
                if (consecutiveNoProgressLoads >= maxNoProgressLoads) break;
            }
            if (signal.aborted) return;
            applySessionOpenLatchEffects(deps.sessionOpenLatch.onInitialFillSettled({
                nowMs: Date.now(),
                sessionId: deps.sessionId,
            }).effects);
            deps.observeMountSettleMetrics();
            if (!shouldPinDuringInitialFill) {
                runEntryRestoreAttempt();
                verifyWebEntryRestoreTransaction();
            }
        })(), { tag: 'ChatList.initialFillOlderMessages' });
    }, [
        applySessionOpenLatchEffects,
        deps.committedMessagesCount,
        deps.entrySliceWindowRef,
        deps.initialFillAbortRef,
        deps.isLoaded,
        deps.isScrollable,
        deps.jumpToSeq,
        deps.listContentHeight,
        deps.listLayoutHeight,
        deps.loadOlder,
        deps.observeMountSettleMetrics,
        deps.pinToBottomRespectingNativeMountSettle,
        deps.sessionEntryViewportRef,
        deps.sessionId,
        deps.sessionOpenLatch,
        deps.waitForNextVisualUpdate,
        deps.wantsPinnedRef,
        runEntryRestoreAttempt,
        verifyWebEntryRestoreTransaction,
    ]);
    requestSessionOpenInitialFillRef.current = requestSessionOpenInitialFill;
    React.useEffect(() => {
        requestSessionOpenInitialFill();
    }, [requestSessionOpenInitialFill]);

    React.useEffect(() => {
        if (!deps.sessionId) return;
        const decision = deps.sessionOpenLatch.onHostFacts({
            contentHeight: deps.listContentHeight,
            hasEntrySliceWindow: deps.entrySliceWindowRef.current?.sessionId === deps.sessionId,
            isLoaded: deps.isLoaded,
            isScrollable: deps.isScrollable(),
            itemCount: deps.displayItemsLength,
            layoutHeight: deps.listLayoutHeight,
            nowMs: Date.now(),
            sessionId: deps.sessionId,
            userWantsPinned: deps.wantsPinnedRef.current,
        });
        applySessionOpenLatchEffects(decision.effects);
    }, [
        applySessionOpenLatchEffects,
        deps.displayItemsLength,
        deps.entrySliceWindowRef,
        deps.isLoaded,
        deps.isScrollable,
        deps.listContentHeight,
        deps.listLayoutHeight,
        deps.sessionId,
        deps.sessionOpenLatch,
        deps.wantsPinnedRef,
    ]);

    return {
        applyEntryRestoreOwnerEffects,
        applySessionOpenLatchEffects,
        disposeEntryRestoreTransactionForExit,
        observeNativeEntryRestoreHostFacts,
        runEntryRestoreAttempt,
        verifyNativeSliceEntryRestoreTransaction,
        verifyWebEntryRestoreTransaction,
    };
}
