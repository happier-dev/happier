export type TranscriptInitialFillStatus = 'idle' | 'in_progress' | 'done';

export type TranscriptMountSettleTuning = Readonly<{
    quiescentWindowMs: number;
    dimensionNoiseFloorPx: number;
    bottomDistanceNoiseFloorPx: number;
}>;

export type TranscriptMountSettleSnapshot = Readonly<{
    firstListPaint: boolean;
    layoutCommitObserved: boolean;
    stableSettle: boolean;
    isMountSettleActive: boolean;
}>;

export type TranscriptMountSettleMetrics = Readonly<{
    sessionId: string;
    nowMs: number;
    initialFillStatus: TranscriptInitialFillStatus;
    listContentHeight: number;
    listLayoutHeight: number;
    composerInsetHeight: number;
    distanceFromBottom: number;
}>;

export type TranscriptMountSettlePinCoordinator = Readonly<{
    getSnapshot(): TranscriptMountSettleSnapshot;
    recordFirstListPaint(event: Readonly<{ sessionId: string; nowMs: number }>): void;
    recordLayoutCommitObserved(event: Readonly<{ sessionId: string; nowMs: number }>): void;
    observeMetrics(metrics: TranscriptMountSettleMetrics): void;
    sample(event: Readonly<{ sessionId: string; nowMs: number }>): void;
    /**
     * How long until quiescence could next be declared, so a caller can wake exactly then
     * instead of polling on an unrelated phase. `null` means there is nothing to wait for:
     * either settle already happened, or a precondition (first paint, layout commit,
     * initial fill) has not been met and no amount of waiting alone will change that.
     *
     * Derived from the same `lastMeaningfulChange` the settle decision uses, so the
     * schedule and the decision cannot drift apart.
     */
    nextSettleCheckDelayMs(nowMs: number): number | null;
    reset(event?: Readonly<{ reason?: 'session-change' | 'unmount' }>): void;
}>;

export function createTranscriptMountSettlePinCoordinator(
    options: Readonly<{ tuning: TranscriptMountSettleTuning }>,
): TranscriptMountSettlePinCoordinator {
    const tuning = normalizeTuning(options.tuning);
    let sessionId: string | null = null;
    let firstListPaint = false;
    let layoutCommitObserved = false;
    let stableSettle = false;
    let lastMeaningfulChangeAtMs: number | null = null;
    let lastMetrics: NormalizedMetrics | null = null;

    return {
        getSnapshot() {
            return buildSnapshot();
        },
        recordFirstListPaint(event) {
            ensureSession(event.sessionId);
            if (!firstListPaint) {
                firstListPaint = true;
                markMeaningfulChange(event.nowMs);
            }
            updateStableSettle(event.nowMs);
        },
        recordLayoutCommitObserved(event) {
            ensureSession(event.sessionId);
            if (!layoutCommitObserved) {
                layoutCommitObserved = true;
                markMeaningfulChange(event.nowMs);
            }
            updateStableSettle(event.nowMs);
        },
        observeMetrics(metrics) {
            const changedSession = ensureSession(metrics.sessionId);
            const normalized = normalizeMetrics(metrics);
            if (stableSettle) {
                lastMetrics = normalized;
                return;
            }
            if (lastMetrics !== null && metricsChanged(lastMetrics, normalized, tuning)) {
                markMeaningfulChange(normalized.nowMs);
            } else if (lastMeaningfulChangeAtMs === null) {
                markMeaningfulChange(normalized.nowMs);
            }
            lastMetrics = normalized;
            if (changedSession) {
                stableSettle = false;
            }
            updateStableSettle(normalized.nowMs);
        },
        sample(event) {
            ensureSession(event.sessionId);
            updateStableSettle(event.nowMs);
        },
        nextSettleCheckDelayMs(nowMs) {
            if (stableSettle) return null;
            if (!firstListPaint || !layoutCommitObserved) return null;
            if (lastMetrics?.initialFillStatus !== 'done') return null;
            if (lastMetrics.listLayoutHeight <= 0 || lastMetrics.listContentHeight <= 0) return null;
            if (lastMeaningfulChangeAtMs === null) return null;
            const elapsed = normalizeNumber(nowMs) - lastMeaningfulChangeAtMs;
            const remaining = tuning.quiescentWindowMs - elapsed;
            return remaining > 0 ? remaining : 0;
        },
        reset() {
            resetState(null);
        },
    };

    function buildSnapshot(): TranscriptMountSettleSnapshot {
        return {
            firstListPaint,
            layoutCommitObserved,
            stableSettle,
            isMountSettleActive: !stableSettle,
        };
    }

    function ensureSession(nextSessionId: string): boolean {
        if (sessionId === nextSessionId) return false;
        resetState(nextSessionId);
        return true;
    }

    function resetState(nextSessionId: string | null): void {
        sessionId = nextSessionId;
        firstListPaint = false;
        layoutCommitObserved = false;
        stableSettle = false;
        lastMeaningfulChangeAtMs = null;
        lastMetrics = null;
    }

    function markMeaningfulChange(nowMs: number): void {
        lastMeaningfulChangeAtMs = normalizeNumber(nowMs);
        stableSettle = false;
    }

    function updateStableSettle(nowMs: number): void {
        if (stableSettle) return;
        if (!firstListPaint || !layoutCommitObserved) return;
        if (lastMetrics?.initialFillStatus !== 'done') return;
        if (lastMetrics.listLayoutHeight <= 0 || lastMetrics.listContentHeight <= 0) return;
        if (lastMeaningfulChangeAtMs === null) return;
        if (normalizeNumber(nowMs) - lastMeaningfulChangeAtMs < tuning.quiescentWindowMs) return;
        stableSettle = true;
    }
}

type NormalizedMetrics = Readonly<{
    nowMs: number;
    initialFillStatus: TranscriptInitialFillStatus;
    listContentHeight: number;
    listLayoutHeight: number;
    composerInsetHeight: number;
    distanceFromBottom: number;
}>;

function normalizeTuning(tuning: TranscriptMountSettleTuning): TranscriptMountSettleTuning {
    return {
        quiescentWindowMs: Math.max(0, Math.trunc(normalizeNumber(tuning.quiescentWindowMs))),
        dimensionNoiseFloorPx: Math.max(0, normalizeNumber(tuning.dimensionNoiseFloorPx)),
        bottomDistanceNoiseFloorPx: Math.max(0, normalizeNumber(tuning.bottomDistanceNoiseFloorPx)),
    };
}

function normalizeMetrics(metrics: TranscriptMountSettleMetrics): NormalizedMetrics {
    return {
        nowMs: normalizeNumber(metrics.nowMs),
        initialFillStatus: metrics.initialFillStatus,
        listContentHeight: normalizeNumber(metrics.listContentHeight),
        listLayoutHeight: normalizeNumber(metrics.listLayoutHeight),
        composerInsetHeight: normalizeNumber(metrics.composerInsetHeight),
        distanceFromBottom: normalizeNumber(metrics.distanceFromBottom),
    };
}

function metricsChanged(
    previous: NormalizedMetrics,
    next: NormalizedMetrics,
    tuning: TranscriptMountSettleTuning,
): boolean {
    return (
        previous.initialFillStatus !== next.initialFillStatus ||
        Math.abs(previous.listContentHeight - next.listContentHeight) > tuning.dimensionNoiseFloorPx ||
        Math.abs(previous.listLayoutHeight - next.listLayoutHeight) > tuning.dimensionNoiseFloorPx ||
        Math.abs(previous.composerInsetHeight - next.composerInsetHeight) > tuning.dimensionNoiseFloorPx ||
        Math.abs(previous.distanceFromBottom - next.distanceFromBottom) > tuning.bottomDistanceNoiseFloorPx
    );
}

function normalizeNumber(value: number): number {
    return Number.isFinite(value) ? value : 0;
}
