import type {
    TranscriptViewportTelemetryObservationReason,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { WebTranscriptPrependAnchor } from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor';
import { resolvePendingWebPrependAnchorIndex } from './webTranscriptPrependAnchorIndex';
import { resolveWebTranscriptPrependRangeReservePx } from '@/components/sessions/transcript/webTranscriptPrependRangeReserve';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type { TranscriptViewportTransactionOutcome } from '../transcriptViewportOwnership';
import type {
    TranscriptViewportOwner,
    TranscriptViewportAnchorIdentity,
    TranscriptViewportMode,
} from '../transcriptViewportTypes';

type WebPrependAnchorState = Readonly<{
    anchor: WebTranscriptPrependAnchor;
    sessionId: string;
}>;

type WebPrependPendingState = WebPrependAnchorState & Readonly<{
    indexRecoveryPending: boolean;
    rangeReservePx: number;
}>;

type WebPrependTelemetryContentItem = Readonly<{
    kind: string;
    messageId?: string;
    toolMessageIds?: readonly string[];
}>;

type WebPrependTelemetryItem = Readonly<{
    id: string;
    kind: string;
    messageId?: string;
    toolMessageIds?: readonly string[];
    turn?: Readonly<{
        content: readonly WebPrependTelemetryContentItem[];
        userMessageId?: string | null;
    }>;
}>;

export type WebPrependTelemetryFactsInput = Readonly<{
    items: readonly WebPrependTelemetryItem[];
}>;

export type WebPrependTelemetryFacts = Readonly<{
    pendingWebPrependAnchorId?: string;
    pendingWebPrependAnchorIndex?: number;
    pendingWebPrependAnchorKind: 'stable' | 'item' | 'none';
}>;

export type WebPrependBeforeLoadInput = Readonly<{
    anchor: WebTranscriptPrependAnchor | null;
    preservePrependViewport: boolean;
    sessionId: string;
}>;

export type WebPrependAfterLoadInput = Readonly<{
    activeOwner: TranscriptViewportOwner;
    loadedRowCount: number;
    nowMs: number;
    preservePrependViewport: boolean;
    sessionId: string;
}>;

export type WebPrependRestoreResult =
    | Readonly<{
        didAdjustScroll: boolean;
        strategy: 'anchor' | 'item' | 'growth' | 'none';
    }>
    | Readonly<{
        didAdjustScroll: boolean;
        status: 'restored' | 'already_aligned' | 'not_found' | 'not_applied';
    }>;

export type WebPrependRestoreResultInput = Readonly<{
    currentMetrics: WebTranscriptScrollMetrics | null;
    nowMs: number;
    refreshedAnchor?: WebTranscriptPrependAnchor | null;
    result: WebPrependRestoreResult;
    sessionId: string;
}>;

export type WebPrependRefreshInFlightInput = Readonly<{
    anchor: WebTranscriptPrependAnchor | null;
    sessionId: string;
    userScrolledDuringLoad: boolean;
}>;

export type WebPrependRetargetPendingInput = Readonly<{
    anchor: WebTranscriptPrependAnchor | null;
    sessionId: string;
}>;

export type WebPrependRetryInput = Readonly<{
    currentItemIndex?: number | null;
    items?: readonly WebPrependTelemetryItem[];
    nowMs: number;
    recoveryAnchor: TranscriptViewportAnchorIdentity | null;
    sessionId: string;
}>;

export type WebPrependObservePendingInput = Readonly<{
    nowMs: number;
    sessionId: string;
}>;

export type WebPrependOwnerEffect =
    | Readonly<{
        anchor: WebTranscriptPrependAnchor;
        sessionId: string;
        type: 'execute-web-prepend-restore';
    }>
    | Readonly<{
        anchor: TranscriptViewportAnchorIdentity;
        index: number;
        itemOffsetPx: 0;
        sessionId: string;
        type: 'execute-anchor-recovery';
    }>
    | Readonly<{
        sessionId: string;
        type: 'preempt-entry-restore-for-prepend';
    }>
    | Readonly<{
        sessionId: string;
        type: 'open-prepend-ownership';
    }>
    | Readonly<{
        outcome: TranscriptViewportTransactionOutcome;
        sessionId: string;
        type: 'close-prepend-ownership';
    }>
    | Readonly<{
        reservePx: number;
        type: 'set-web-range-reserve';
    }>
    | Readonly<{
        type: 'clear-web-range-reserve';
    }>
    | Readonly<{
        expiresAtMs: number;
        sessionId: string;
        type: 'schedule-web-restore-expiry';
    }>
    | Readonly<{
        sessionId?: string;
        type: 'clear-web-restore-expiry';
    }>
    | Readonly<{
        sessionId: string;
        type: 'schedule-web-index-recovery';
    }>
    | Readonly<{
        sessionId?: string;
        type: 'clear-web-index-recovery';
    }>
    | Readonly<{
        mode: TranscriptViewportMode;
        programmaticWebWrite: boolean;
        reason: TranscriptViewportTelemetryObservationReason;
        type: 'record-restore-decision';
        webTrigger: 'prepend-restore';
    }>;

export type WebPrependOwner = Readonly<{
    acceptRestoreResult(params: WebPrependRestoreResultInput): readonly WebPrependOwnerEffect[];
    afterLoad(params: WebPrependAfterLoadInput): readonly WebPrependOwnerEffect[];
    beforeLoad(params: WebPrependBeforeLoadInput): readonly WebPrependOwnerEffect[];
    clear(params: Readonly<{
        outcome: TranscriptViewportTransactionOutcome;
        sessionId?: string;
    }>): readonly WebPrependOwnerEffect[];
    expire(params: Readonly<{ nowMs: number }>): readonly WebPrependOwnerEffect[];
    hasRestoreWindow(): boolean;
    observePending(params: WebPrependObservePendingInput): readonly WebPrependOwnerEffect[];
    refreshInFlightForUserScroll(params: WebPrependRefreshInFlightInput): readonly WebPrependOwnerEffect[];
    retargetPendingForUserScroll(params: WebPrependRetargetPendingInput): readonly WebPrependOwnerEffect[];
    retryPending(params: WebPrependRetryInput): readonly WebPrependOwnerEffect[];
    telemetryFacts(params: WebPrependTelemetryFactsInput): WebPrependTelemetryFacts;
}>;

type NormalizedRestoreResult = Readonly<{
    didAdjustScroll: boolean;
    mode: TranscriptViewportMode;
    reason: TranscriptViewportTelemetryObservationReason;
    requiresIndexRecovery: boolean;
}>;

export function createWebPrependOwner(): WebPrependOwner {
    let inFlightAnchor: WebPrependAnchorState | null = null;
    let pendingAnchor: WebPrependPendingState | null = null;

    function beforeLoad(params: WebPrependBeforeLoadInput): readonly WebPrependOwnerEffect[] {
        inFlightAnchor = params.preservePrependViewport && isValidPrependAnchor(params.anchor)
            ? {
                anchor: params.anchor,
                sessionId: params.sessionId,
            }
            : null;
        return [];
    }

    function afterLoad(params: WebPrependAfterLoadInput): readonly WebPrependOwnerEffect[] {
        const captured = inFlightAnchor?.sessionId === params.sessionId ? inFlightAnchor.anchor : null;
        inFlightAnchor = null;
        const shouldPreservePrependViewport = params.preservePrependViewport || captured != null;
        if (!shouldPreservePrependViewport || params.loadedRowCount <= 0) return [];
        if (!isValidPrependAnchor(captured)) {
            return [restoreDecisionEffect('skipped', 'restore-anchor', false)];
        }

        const anchor = withRestoreExpiry(captured, params.nowMs);
        pendingAnchor = {
            anchor,
            indexRecoveryPending: false,
            rangeReservePx: 0,
            sessionId: params.sessionId,
        };
        return [
            restoreDecisionEffect('pending', 'restore-anchor', false),
            ...(params.activeOwner === 'entry'
                ? [{ sessionId: params.sessionId, type: 'preempt-entry-restore-for-prepend' } as const]
                : []),
            { sessionId: params.sessionId, type: 'open-prepend-ownership' },
            { anchor, sessionId: params.sessionId, type: 'execute-web-prepend-restore' },
        ];
    }

    function acceptRestoreResult(params: WebPrependRestoreResultInput): readonly WebPrependOwnerEffect[] {
        if (!pendingAnchor || pendingAnchor.sessionId !== params.sessionId) return [];
        if (params.nowMs > pendingAnchor.anchor.expiresAtMs) {
            return expire(params);
        }

        const normalized = normalizeRestoreResult(params.result);
        const effects: WebPrependOwnerEffect[] = [
            restoreDecisionEffect(normalized.reason, normalized.mode, normalized.didAdjustScroll),
        ];

        if (!params.currentMetrics) {
            effects.push(...clearState({
                outcome: normalized.didAdjustScroll ? 'confirmed' : 'abandoned-identity',
                sessionId: params.sessionId,
            }));
            return effects;
        }

        effects.push(resolveRangeReserveEffect(pendingAnchor.anchor, params.currentMetrics));
        const refreshedAnchorBase = isValidPrependAnchor(params.refreshedAnchor)
            ? params.refreshedAnchor
            : pendingAnchor.anchor;
        const refreshedAnchor = normalized.didAdjustScroll
            ? withRestoreExpiry(refreshedAnchorBase, params.nowMs)
            : refreshedAnchorBase;
        const canRecoverByIndex = hasRecoverableAnchorIdentity(refreshedAnchor);
        const nextIndexRecoveryPending = canRecoverByIndex && (
            normalized.requiresIndexRecovery ||
            (pendingAnchor.indexRecoveryPending && isRecoverableAnchorStillMissing(params.result))
        );
        pendingAnchor = {
            anchor: refreshedAnchor,
            indexRecoveryPending: nextIndexRecoveryPending,
            rangeReservePx: resolveWebTranscriptPrependRangeReservePx({
                baselineScrollHeight: pendingAnchor.anchor.metrics.scrollHeight,
                currentScrollHeight: params.currentMetrics.scrollHeight,
            }),
            sessionId: params.sessionId,
        };
        effects.push(scheduleExpiryEffect(pendingAnchor));
        if (nextIndexRecoveryPending) {
            effects.push(scheduleIndexRecoveryEffect(params.sessionId));
        }
        return effects;
    }

    function refreshInFlightForUserScroll(
        params: WebPrependRefreshInFlightInput,
    ): readonly WebPrependOwnerEffect[] {
        if (!params.userScrolledDuringLoad) return [];
        if (!isValidPrependAnchor(params.anchor)) return [];
        const existingAnchor = inFlightAnchor?.sessionId === params.sessionId
            ? inFlightAnchor.anchor
            : null;
        inFlightAnchor = {
            anchor: existingAnchor
                ? {
                    ...params.anchor,
                    metrics: {
                        ...params.anchor.metrics,
                        scrollHeight: existingAnchor.metrics.scrollHeight,
                    },
                }
                : params.anchor,
            sessionId: params.sessionId,
        };
        return [];
    }

    function retargetPendingForUserScroll(
        params: WebPrependRetargetPendingInput,
    ): readonly WebPrependOwnerEffect[] {
        if (!pendingAnchor || pendingAnchor.sessionId !== params.sessionId) return [];
        if (!isValidPrependAnchor(params.anchor)) return [];
        pendingAnchor = {
            ...pendingAnchor,
            anchor: params.anchor,
            indexRecoveryPending: false,
        };
        return [
            { sessionId: params.sessionId, type: 'clear-web-index-recovery' },
            scheduleExpiryEffect(pendingAnchor),
        ];
    }

    function retryPending(params: WebPrependRetryInput): readonly WebPrependOwnerEffect[] {
        if (!pendingAnchor || pendingAnchor.sessionId !== params.sessionId) return [];
        if (!pendingAnchor.indexRecoveryPending) return [];
        if (params.nowMs > pendingAnchor.anchor.expiresAtMs) {
            return expire(params);
        }

        const index = resolveRecoveryIndex({
            anchor: pendingAnchor.anchor,
            currentItemIndex: params.currentItemIndex,
            items: params.items,
        });
        if (index === undefined || params.recoveryAnchor == null) {
            return [scheduleIndexRecoveryEffect(params.sessionId)];
        }

        return [
            { sessionId: params.sessionId, type: 'clear-web-index-recovery' },
            {
                anchor: params.recoveryAnchor,
                index,
                itemOffsetPx: 0,
                sessionId: params.sessionId,
                type: 'execute-anchor-recovery',
            },
            {
                anchor: pendingAnchor.anchor,
                sessionId: params.sessionId,
                type: 'execute-web-prepend-restore',
            },
        ];
    }

    function expire(params: Readonly<{ nowMs: number }>): readonly WebPrependOwnerEffect[] {
        const state = pendingAnchor ?? inFlightAnchor;
        if (!state) return [];
        if (pendingAnchor && params.nowMs <= pendingAnchor.anchor.expiresAtMs) {
            return [scheduleExpiryEffect(pendingAnchor)];
        }
        return [
            ...clearState({ outcome: 'abandoned-identity', sessionId: state.sessionId }),
            restoreDecisionEffect('skipped', 'restore-anchor', false),
        ];
    }

    function clear(params: Readonly<{
        outcome: TranscriptViewportTransactionOutcome;
        sessionId?: string;
    }>): readonly WebPrependOwnerEffect[] {
        return clearState(params);
    }

    function clearState(params: Readonly<{
        outcome: TranscriptViewportTransactionOutcome;
        sessionId?: string;
    }>): readonly WebPrependOwnerEffect[] {
        const state = pendingAnchor ?? inFlightAnchor;
        if (params.sessionId && state?.sessionId && state.sessionId !== params.sessionId) return [];
        const sessionId = params.sessionId ?? state?.sessionId;
        const hadState = pendingAnchor != null || inFlightAnchor != null;
        const shouldClearRangeReserve = pendingAnchor?.rangeReservePx !== 0 || hadState;
        pendingAnchor = null;
        inFlightAnchor = null;
        if (!sessionId || !hadState) return [];
        const effects: WebPrependOwnerEffect[] = [
            { sessionId, type: 'clear-web-restore-expiry' },
            { sessionId, type: 'clear-web-index-recovery' },
        ];
        if (shouldClearRangeReserve) {
            effects.push({ type: 'clear-web-range-reserve' });
        }
        effects.push({
            outcome: params.outcome,
            sessionId,
            type: 'close-prepend-ownership',
        });
        return effects;
    }

    function hasRestoreWindow(): boolean {
        return inFlightAnchor != null || pendingAnchor != null;
    }

    function observePending(params: WebPrependObservePendingInput): readonly WebPrependOwnerEffect[] {
        if (!pendingAnchor || pendingAnchor.sessionId !== params.sessionId) return [];
        if (params.nowMs > pendingAnchor.anchor.expiresAtMs) {
            return expire(params);
        }
        return [{ anchor: pendingAnchor.anchor, sessionId: params.sessionId, type: 'execute-web-prepend-restore' }];
    }

    function telemetryFacts(params: WebPrependTelemetryFactsInput): WebPrependTelemetryFacts {
        if (!pendingAnchor) {
            return { pendingWebPrependAnchorKind: 'none' };
        }
        const anchorKind = pendingAnchor.anchor.anchorTestId
            ? 'stable'
            : pendingAnchor.anchor.itemTestId
                ? 'item'
                : 'none';
        const anchorId = pendingAnchor.anchor.anchorTestId ?? pendingAnchor.anchor.itemTestId ?? undefined;
        const index = resolvePendingWebPrependAnchorIndex({
            anchorTestId: pendingAnchor.anchor.anchorTestId,
            itemTestId: pendingAnchor.anchor.itemTestId,
            items: params.items,
        });
        return {
            pendingWebPrependAnchorKind: anchorKind,
            ...(anchorId ? { pendingWebPrependAnchorId: anchorId } : {}),
            ...(index !== undefined ? { pendingWebPrependAnchorIndex: index } : {}),
        };
    }

    return {
        acceptRestoreResult,
        afterLoad,
        beforeLoad,
        clear,
        expire,
        hasRestoreWindow,
        observePending,
        refreshInFlightForUserScroll,
        retargetPendingForUserScroll,
        retryPending,
        telemetryFacts,
    };
}

function normalizeRestoreResult(result: WebPrependRestoreResult): NormalizedRestoreResult {
    if ('strategy' in result) {
        switch (result.strategy) {
            case 'growth':
                return {
                    didAdjustScroll: result.didAdjustScroll,
                    mode: 'restore-distance',
                    reason: 'restored',
                    requiresIndexRecovery: true,
                };
            case 'none':
                return {
                    didAdjustScroll: result.didAdjustScroll,
                    mode: 'restore-anchor',
                    reason: 'not-ready',
                    requiresIndexRecovery: false,
                };
            case 'anchor':
            case 'item':
                return {
                    didAdjustScroll: result.didAdjustScroll,
                    mode: 'restore-anchor',
                    reason: result.didAdjustScroll ? 'restored' : 'observed',
                    requiresIndexRecovery: false,
                };
        }
    }

    switch (result.status) {
        case 'restored':
            return {
                didAdjustScroll: result.didAdjustScroll,
                mode: 'restore-anchor',
                reason: 'restored',
                requiresIndexRecovery: false,
            };
        case 'already_aligned':
            return {
                didAdjustScroll: result.didAdjustScroll,
                mode: 'restore-anchor',
                reason: 'observed',
                requiresIndexRecovery: false,
            };
        case 'not_found':
            return {
                didAdjustScroll: result.didAdjustScroll,
                mode: 'restore-anchor',
                reason: 'not-ready',
                requiresIndexRecovery: true,
            };
        case 'not_applied':
            return {
                didAdjustScroll: result.didAdjustScroll,
                mode: 'restore-anchor',
                reason: 'not-ready',
                requiresIndexRecovery: false,
            };
    }
}

function restoreDecisionEffect(
    reason: TranscriptViewportTelemetryObservationReason,
    mode: TranscriptViewportMode,
    programmaticWebWrite: boolean,
): WebPrependOwnerEffect {
    return {
        mode,
        programmaticWebWrite,
        reason,
        type: 'record-restore-decision',
        webTrigger: 'prepend-restore',
    };
}

function scheduleExpiryEffect(state: WebPrependAnchorState): WebPrependOwnerEffect {
    return {
        expiresAtMs: state.anchor.expiresAtMs,
        sessionId: state.sessionId,
        type: 'schedule-web-restore-expiry',
    };
}

function scheduleIndexRecoveryEffect(sessionId: string): WebPrependOwnerEffect {
    return {
        sessionId,
        type: 'schedule-web-index-recovery',
    };
}

function resolveRangeReserveEffect(
    anchor: WebTranscriptPrependAnchor,
    metrics: Pick<WebTranscriptScrollMetrics, 'scrollHeight'>,
): WebPrependOwnerEffect {
    const reservePx = resolveWebTranscriptPrependRangeReservePx({
        baselineScrollHeight: anchor.metrics.scrollHeight,
        currentScrollHeight: metrics.scrollHeight,
    });
    return reservePx > 0
        ? { reservePx, type: 'set-web-range-reserve' }
        : { type: 'clear-web-range-reserve' };
}

function resolveRecoveryIndex(params: Readonly<{
    anchor: WebTranscriptPrependAnchor;
    currentItemIndex?: number | null;
    items?: readonly WebPrependTelemetryItem[];
}>): number | undefined {
    if (typeof params.currentItemIndex === 'number' && Number.isFinite(params.currentItemIndex)) {
        const index = Math.trunc(params.currentItemIndex);
        return index >= 0 ? index : undefined;
    }
    if (!params.items) return undefined;
    return resolvePendingWebPrependAnchorIndex({
        anchorTestId: params.anchor.anchorTestId,
        itemTestId: params.anchor.itemTestId,
        items: params.items,
    });
}

function withRestoreExpiry(anchor: WebTranscriptPrependAnchor, nowMs: number): WebTranscriptPrependAnchor {
    const stabilizeForMs = Number.isFinite(anchor.stabilizeForMs)
        ? Math.max(0, Math.trunc(anchor.stabilizeForMs))
        : 0;
    const baseMs = Number.isFinite(nowMs) ? Math.trunc(nowMs) : 0;
    return {
        ...anchor,
        expiresAtMs: baseMs + stabilizeForMs,
        stabilizeForMs,
    };
}

function isValidPrependAnchor(anchor: WebTranscriptPrependAnchor | null | undefined): anchor is WebTranscriptPrependAnchor {
    if (!anchor) return false;
    if (!hasFiniteMetric(anchor.metrics.scrollTop)) return false;
    if (!hasFiniteMetric(anchor.metrics.scrollHeight)) return false;
    if (!hasFiniteMetric(anchor.metrics.clientHeight)) return false;
    return true;
}

function hasFiniteMetric(value: number): boolean {
    return typeof value === 'number' && Number.isFinite(value);
}

function hasRecoverableAnchorIdentity(anchor: WebTranscriptPrependAnchor): boolean {
    return anchor.anchorTestId != null || anchor.itemTestId != null;
}

function isRecoverableAnchorStillMissing(result: WebPrependRestoreResult): boolean {
    if ('strategy' in result) return result.strategy === 'none';
    return result.status === 'not_found';
}
