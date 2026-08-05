import * as React from 'react';
import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';
import { Platform } from 'react-native';
import { sync, type SessionViewportAnchorSnapshot, type SessionViewportSnapshot } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
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
import {
    resolveTranscriptViewportAnchorIndex,
} from '@/components/sessions/transcript/viewport/entryRestore/transcriptViewportAnchorResolution';
import type { SessionOpenLatch } from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';
import type {
    SessionOpenArmResetPlan,
    SessionOpenDisposeResetPlan,
    SessionOpenEntryKind,
    SessionOpenLatchEffect,
} from '@/components/sessions/transcript/viewport/sessionOpen/types';
import {
    resolveNativeTranscriptViewportAnchorRestoreObservation,
} from '@/components/sessions/transcript/viewport/driver/transcriptNativeViewportAnchor';
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
import type { TranscriptJumpTarget } from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';

import type {
    TranscriptUserScrollIntentOwner,
    TranscriptUserScrollIntentTimestampReader,
} from '@/components/sessions/transcript/viewport/driver/userScrollIntentOwner';

type MutableRef<T> = { current: T };
type LoadOlderOptions = TranscriptPrependOlderLoadOptions;

function sessionViewportAnchorsMatch(
    currentAnchor: SessionViewportSnapshot['anchor'],
    entryAnchor: SessionViewportAnchorSnapshot | null,
): boolean {
    if (currentAnchor == null || entryAnchor == null) return currentAnchor == null && entryAnchor == null;
    const currentSeq = currentAnchor.seq ?? null;
    const entrySeq = entryAnchor.seq ?? null;
    return (
        currentAnchor.kind === entryAnchor.kind &&
        currentAnchor.itemId === entryAnchor.itemId &&
        (currentAnchor.messageId ?? null) === (entryAnchor.messageId ?? null) &&
        (currentSeq === null || entrySeq === null || currentSeq === entrySeq) &&
        currentAnchor.itemOffsetPx === entryAnchor.itemOffsetPx
    );
}

function isSessionEntryViewportEcho(
    currentViewport: SessionViewportSnapshot,
    entryViewport: SessionEntryViewportRefValue,
): boolean {
    if (!entryViewport) return false;
    if (entryViewport.shouldFollowBottom !== false) return false;
    if (currentViewport.isPinned !== false) return false;
    if (typeof entryViewport.offsetY !== 'number' || !Number.isFinite(entryViewport.offsetY)) return false;
    if (currentViewport.offsetY !== entryViewport.offsetY) return false;
    return sessionViewportAnchorsMatch(currentViewport.anchor, entryViewport.anchor);
}

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
    activeTargetWindowTargetRef: MutableRef<TranscriptJumpTarget | null>;
    anchorLookupExhaustedRef: MutableRef<boolean>;
    anchorLookupInFlightRef: MutableRef<boolean>;
    anchorLookupLoadCountRef: MutableRef<number>;
    applyEntryRestoreOwnerEffectsRef: MutableRef<(effects: readonly EntryRestoreOwnerEffect[]) => void>;
    applySessionOpenArmResetPlan(plan: SessionOpenArmResetPlan): void;
    applySessionOpenDisposeResetPlan(plan: SessionOpenDisposeResetPlan): void;
    applySessionOpenLatchEffectsRef: MutableRef<(effects: readonly SessionOpenLatchEffect[]) => void>;
    attemptEntryRestoreRef: MutableRef<() => void>;
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
    executeViewportCommand(command: TranscriptViewportCommand): boolean;
    hasNativeContentMeasurementForCurrentSession(): boolean;
    initialFillAbortRef: MutableRef<AbortController | null>;
    invalidateViewportAnchorCapture(): void;
    isLoaded: boolean;
    isScrollable(): boolean;
    isViewportAnchorSeqLoaded(seq: number, items: readonly ChatTranscriptListItem[]): boolean;
    jumpToSeq: number | null | undefined;
    lastScrollOffsetForIntentRef: MutableRef<number | null>;
    lastUserScrollIntentAtMsRef: TranscriptUserScrollIntentTimestampReader;
    userScrollIntent: TranscriptUserScrollIntentOwner;
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
    nativeMountSettleStable: boolean;
    observeMountSettleMetrics(): void;
    pinThresholdPx: number;
    recordEntryOwnerOutcome(params: Readonly<{
        outcome: 'confirmed' | 'fallback';
        sessionId: string;
    }>): void;
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
    scheduleNativePaintReleaseForEntryRestore(options?: Readonly<{ force?: boolean }>): void;
    sessionEntryViewportRef: MutableRef<SessionEntryViewportRefValue>;
    sessionId: string;
    sessionOpenLatch: SessionOpenLatch;
    setNativeMountSettleDeadlineReached(value: boolean): void;
    updateNativeInitialViewportPendingObservation(pending: boolean): void;
    updateNativeViewportPaintObserved(observed: boolean): void;
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
        mountSettleStable?: boolean;
        nowMs: number;
        offsetY: number;
    }>): readonly EntryRestoreOwnerEffect[];
    runEntryRestoreAttempt(): void;
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
        const entryViewport = deps.sessionEntryViewportRef.current;
        const entrySourceLastUpdatedAt = entryViewport?.sourceLastUpdatedAt;
        const currentViewportIsNewerObservedState =
            typeof currentViewport.lastUpdatedAt === 'number' &&
            currentViewport.lastUpdatedAt !== entrySourceLastUpdatedAt;
        if (!currentViewportIsNewerObservedState) return false;
        return !isSessionEntryViewportEcho(currentViewport, entryViewport);
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
                    let usedWebDistanceFallback = false;
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
                                        usedWebDistanceFallback = true;
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
                    if (Platform.OS === 'web' && usedWebDistanceFallback) {
                        deps.recordEntryOwnerOutcome({
                            outcome: 'fallback',
                            sessionId: deps.sessionId,
                        });
                    }
                    if (!issued && !scrollToIndexRequested) {
                        deps.applyEntryRestoreOwnerEffectsRef.current(deps.entryRestoreOwner.markInitialCommandFailed({
                            sessionId: deps.sessionId,
                        }));
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
                case 'request-bounded-materialization':
                    requestBoundedEntryViewportMaterialization(effect.targetSeq);
                    break;
                case 'close-entry-ownership':
                    deps.recordEntryOwnerOutcome({
                        outcome: effect.outcome === 'confirmed' ? 'confirmed' : 'fallback',
                        sessionId: deps.sessionId,
                    });
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
        deps.recordEntryOwnerOutcome,
        deps.recordViewportTelemetryEvent,
        deps.resolveViewportCommand,
        deps.resolveWebScrollMetrics,
        deps.restoreWebViewportAnchorThroughViewportCommand,
        deps.scheduleNativePaintReleaseForEntryRestore,
        deps.updateNativeInitialViewportPendingObservation,
    ]);
    useCommittedTranscriptRef(
        deps.applyEntryRestoreOwnerEffectsRef,
        applyEntryRestoreOwnerEffects,
    );

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
    useCommittedTranscriptRef(
        deps.disposeEntryRestoreTransactionForExitRef,
        disposeEntryRestoreTransactionForExit,
    );

    const canRequestBoundedEntryViewportMaterialization = React.useCallback((): boolean => {
        if (deps.anchorLookupExhaustedRef.current) return false;
        if (deps.anchorLookupInFlightRef.current) return true;
        return deps.anchorLookupLoadCountRef.current < sync.getSyncTuning().transcriptViewportAnchorOlderLookupMaxLoads;
    }, []);

    const requestBoundedEntryViewportMaterialization = React.useCallback((targetSeq?: number | null): boolean => {
        if (deps.anchorLookupInFlightRef.current) return true;
        if (deps.anchorLookupExhaustedRef.current) return false;
        const maxLoads = sync.getSyncTuning().transcriptViewportAnchorOlderLookupMaxLoads;
        if (deps.anchorLookupLoadCountRef.current >= maxLoads) return false;
        deps.anchorLookupInFlightRef.current = true;
        deps.anchorLookupLoadCountRef.current += 1;
        const requestedSessionId = deps.sessionId;
        fireAndForget((async () => {
            let shouldRetryRestore = false;
            try {
                if (typeof targetSeq === 'number' && Number.isFinite(targetSeq) && targetSeq > 0) {
                    const normalizedTargetSeq = Math.trunc(targetSeq);
                    const target = { kind: 'seq' as const, seq: normalizedTargetSeq };
                    const result = await sync.loadTargetWindowMessages(requestedSessionId, target, {
                        direction: 'initial',
                    });
                    if (deps.currentSessionIdRef.current !== requestedSessionId) return;
                    if (result?.status === 'loaded' && result.targetPresent) {
                        deps.activeTargetWindowTargetRef.current = target;
                        shouldRetryRestore = true;
                    }
                } else {
                    const result = await deps.loadOlder({ preservePrependViewport: false, showLoadingIndicator: false });
                    if (deps.currentSessionIdRef.current !== requestedSessionId) return;
                    shouldRetryRestore = true;
                    if (result && (result.status === 'no_more' || result.hasMore === false)) {
                        deps.anchorLookupExhaustedRef.current = true;
                    }
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
    }, [deps.activeTargetWindowTargetRef, deps.currentSessionIdRef, deps.loadOlder, deps.sessionId]);

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
        mountSettleStable?: boolean;
        nowMs: number;
        offsetY: number;
    }>): readonly EntryRestoreOwnerEffect[] => {
        const tolerancePx = Math.max(deps.pinThresholdPx, 2);
        return deps.entryRestoreOwner.observeNativeHostFacts({
            contentHeight: params.contentHeight,
            distanceFromBottom: params.distanceFromBottom,
            layoutHeight: params.layoutHeight,
            mountSettleStable: params.mountSettleStable,
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
            sessionId: deps.sessionId,
            tolerancePx,
        });
    }, [deps.entryRestoreOwner, deps.pinThresholdPx, deps.sessionId, deps.resolveNearestSurvivingViewportAnchorIndex]);

    // Settle-edge re-confirmation: estimate-space distance restores can only be judged
    // against SETTLED geometry, and the clamp that drags a stale offset to the tail
    // produces no scroll events afterwards — without this feed, an open transaction
    // whose content shrank below the issued height would never see an observation
    // again (live clamp-to-tail defect, 2026-07-13).
    React.useEffect(() => {
        if (Platform.OS === 'web') return;
        if (!deps.nativeMountSettleStable) return;
        if (!deps.entryRestoreOwner.hasOpenTransaction(deps.sessionId)) return;
        const contentHeight = deps.listContentHeightRef.current;
        const layoutHeight = deps.listLayoutHeightRef.current;
        const offsetY = readNativeAbsoluteScrollOffset(deps.listRef.current);
        if (offsetY == null || contentHeight <= 0 || layoutHeight <= 0) return;
        const effects = observeNativeEntryRestoreHostFacts({
            contentHeight,
            distanceFromBottom: Math.max(0, Math.trunc(contentHeight - layoutHeight - offsetY)),
            layoutHeight,
            mountSettleStable: true,
            nowMs: Date.now(),
            offsetY,
        });
        if (effects.length === 0) return;
        applyEntryRestoreOwnerEffects(effects);
        if (effects.some((effect) => effect.type === 'native-initial-viewport-applied')) {
            deps.updateNativeViewportPaintObserved(true);
        }
    }, [
        applyEntryRestoreOwnerEffects,
        deps.entryRestoreOwner,
        deps.listContentHeightRef,
        deps.listLayoutHeightRef,
        deps.listRef,
        deps.nativeMountSettleStable,
        deps.sessionId,
        deps.updateNativeViewportPaintObserved,
        observeNativeEntryRestoreHostFacts,
    ]);

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
        const exactAnchorItem = exactAnchorSourceIndex == null ? null : items[exactAnchorSourceIndex] ?? null;
        const exactAnchorRendererTarget = exactAnchorItem
            ? deps.renderWindowProjection.indexMap.resolveRendererTargetForItemId(exactAnchorItem.id)
            : null;
        if (
            exactAnchorRendererTarget?.kind === 'outside-data'
            && exactAnchorRendererTarget.reason === 'projection-window'
            && exactAnchorRendererTarget.targetSeq != null
        ) {
            const metrics = Platform.OS === 'web' && anchor ? deps.resolveWebScrollMetrics() : null;
            const exactAnchorIsMountedInWebDom = metrics != null && anchor != null
                ? resolveWebTranscriptViewportAnchorAlignment({
                    container: metrics.element,
                    anchor: {
                        itemId: anchor.itemId,
                        itemOffsetPx: anchor.itemOffsetPx,
                        kind: anchor.kind,
                        messageId: anchor.messageId ?? null,
                    },
                }).status !== 'not_found'
                : false;
            if (!exactAnchorIsMountedInWebDom) {
                if (requestBoundedEntryViewportMaterialization(exactAnchorRendererTarget.targetSeq)) return;
            }
        }
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
            userScrollObserved:
                hasObservedScrollSinceSessionEntry(),
        });
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
        requestBoundedEntryViewportMaterialization,
        verifyWebEntryRestoreTransaction,
    ]);
    useCommittedTranscriptRef(deps.attemptEntryRestoreRef, runEntryRestoreAttempt);

    React.useLayoutEffect(() => {
        runEntryRestoreAttempt();
        if (Platform.OS === 'web') {
            verifyWebEntryRestoreTransaction();
        }
    }, [
        deps.listContentHeight,
        deps.listDataLength,
        deps.listLayoutHeight,
        deps.sessionId,
        runEntryRestoreAttempt,
        verifyWebEntryRestoreTransaction,
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
        deps.applySessionOpenArmResetPlan,
        deps.applySessionOpenDisposeResetPlan,
        deps.nativeMountSettleDeadlineReachedRef,
        deps.setNativeMountSettleDeadlineReached,
        deps.updateNativeInitialViewportPendingObservation,
        runEntryRestoreAttempt,
        verifyWebEntryRestoreTransaction,
    ]);
    useCommittedTranscriptRef(
        deps.applySessionOpenLatchEffectsRef,
        applySessionOpenLatchEffects,
    );

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
        const shouldFollowBottomDuringInitialFill =
            deps.sessionEntryViewportRef.current?.shouldFollowBottom !== false;
        fireAndForget((async () => {
            const tuning = sync.getSyncTuning();
            const startedAtMs = Date.now();
            const { budgetMs, maxNoProgressLoads } = resolveTranscriptInitialFillTuning({
                transcriptInitialFillBudgetMs: tuning.transcriptInitialFillBudgetMs,
                transcriptInitialFillMaxNoProgressLoads: tuning.transcriptInitialFillMaxNoProgressLoads,
            });
            let consecutiveNoProgressLoads = 0;
            // ONE fill-sufficiency contract, displayable-content based (S-L/S-M 2026-07-11):
            // sufficiency is scrollability of the DISPLAYED main lane (the break below), so the
            // bound must be displayable too. Older pages can legitimately apply only
            // sidechain-routed raw events that never render in the main transcript, and a
            // wall-clock budget anchored at the fill start starved exactly those sessions into
            // an underfilled, unscrollable (= stuck, no older-load trigger) transcript. The
            // budget now bounds time WITHOUT displayable progress (main-lane content height
            // growth); raw page progress keeps the stuck-server guard, and an absolute ceiling
            // bounds pathological fills. Removal condition: DR-029 readiness redesign
            // (POST-BURN) owning a first-class fill/readiness pipeline.
            const absoluteFillDeadlineMs = startedAtMs + budgetMs * 5;
            let lastDisplayableProgressAtMs = startedAtMs;
            let displayableContentHeightBaselinePx = deps.listContentHeightRef.current;
            // Settlement is load-bearing: an abort or a failed/rejected load must
            // still close the open phase. Settling a superseded session is safe:
            // the latch ignores mismatched sessions.
            try {
                while (true) {
                    if (signal.aborted) return;
                    if (deps.isScrollable() && deps.committedMessagesCount > 0) break;
                    if (Date.now() - lastDisplayableProgressAtMs >= budgetMs) break;
                    if (Date.now() >= absoluteFillDeadlineMs) break;
                    const result = await deps.loadOlder({ preservePrependViewport: false, showLoadingIndicator: false });
                    if (!result) break;
                    if (result.status === 'no_more') break;
                    const madeProgress = result.status === 'loaded' && result.loaded > 0;
                    consecutiveNoProgressLoads = madeProgress ? 0 : consecutiveNoProgressLoads + 1;
                    await Promise.resolve();
                    await Promise.resolve();
                    const displayableContentHeightPx = deps.listContentHeightRef.current;
                    if (displayableContentHeightPx > displayableContentHeightBaselinePx + 1) {
                        displayableContentHeightBaselinePx = displayableContentHeightPx;
                        lastDisplayableProgressAtMs = Date.now();
                    }
                    if (consecutiveNoProgressLoads >= maxNoProgressLoads) break;
                }
            } finally {
                applySessionOpenLatchEffects(deps.sessionOpenLatch.onInitialFillSettled({
                    nowMs: Date.now(),
                    sessionId: deps.sessionId,
                }).effects);
            }
            if (signal.aborted) return;
            deps.observeMountSettleMetrics();
            if (!shouldFollowBottomDuringInitialFill) {
                runEntryRestoreAttempt();
                verifyWebEntryRestoreTransaction();
            }
        })(), { tag: 'ChatList.initialFillOlderMessages' });
    }, [
        applySessionOpenLatchEffects,
        deps.committedMessagesCount,
        deps.initialFillAbortRef,
        deps.isLoaded,
        deps.isScrollable,
        deps.jumpToSeq,
        deps.listContentHeight,
        deps.listContentHeightRef,
        deps.listLayoutHeight,
        deps.loadOlder,
        deps.observeMountSettleMetrics,
        deps.sessionEntryViewportRef,
        deps.sessionId,
        deps.sessionOpenLatch,
        runEntryRestoreAttempt,
        verifyWebEntryRestoreTransaction,
    ]);
    useCommittedTranscriptRef(
        requestSessionOpenInitialFillRef,
        requestSessionOpenInitialFill,
    );
    React.useEffect(() => {
        if (!deps.sessionId) return;
        const decision = deps.sessionOpenLatch.onHostFacts({
            contentHeight: deps.listContentHeight,
            isLoaded: deps.isLoaded,
            isScrollable: deps.isScrollable(),
            itemCount: deps.displayItemsLength,
            layoutHeight: deps.listLayoutHeight,
            nowMs: Date.now(),
            sessionId: deps.sessionId,
        });
        applySessionOpenLatchEffects(decision.effects);
    }, [
        applySessionOpenLatchEffects,
        deps.displayItemsLength,
        deps.isLoaded,
        deps.isScrollable,
        deps.listContentHeight,
        deps.listLayoutHeight,
        deps.sessionId,
        deps.sessionOpenLatch,
    ]);

    return {
        applyEntryRestoreOwnerEffects,
        applySessionOpenLatchEffects,
        disposeEntryRestoreTransactionForExit,
        observeNativeEntryRestoreHostFacts,
        runEntryRestoreAttempt,
        verifyWebEntryRestoreTransaction,
    };
}
