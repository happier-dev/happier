export type SafeCursorLagTripwireState = Readonly<{
    blockedCursor: string;
    blockedReason: string;
    safeAdvanceCursor: string | null;
    firstSeenAtMs: number;
    consecutiveOverThresholdTicks: number;
    emitted: boolean;
}>;

export type SafeCursorLagTripwireEvent = Readonly<{
    blockedCursor: string;
    blockedReason: string;
    safeAdvanceCursor: string | null;
    lagMs: number;
    consecutiveOverThresholdTicks: number;
}>;

function normalizeMs(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function rememberBlockedCursorLag(
    current: SafeCursorLagTripwireState | null,
    event: Readonly<{
        blockedCursor: string;
        blockedReason: string;
        safeAdvanceCursor: string | null;
        nowMs: number;
    }>,
): SafeCursorLagTripwireState {
    const blockedCursor = event.blockedCursor.trim();
    const blockedReason = event.blockedReason.trim() || 'partial-materialization';
    const nowMs = normalizeMs(event.nowMs);
    if (current?.blockedCursor === blockedCursor) {
        return {
            ...current,
            blockedReason,
            safeAdvanceCursor: event.safeAdvanceCursor,
        };
    }
    return {
        blockedCursor,
        blockedReason,
        safeAdvanceCursor: event.safeAdvanceCursor,
        firstSeenAtMs: nowMs,
        consecutiveOverThresholdTicks: 0,
        emitted: false,
    };
}

export function evaluateSafeCursorLagTripwire(
    current: SafeCursorLagTripwireState | null,
    params: Readonly<{
        nowMs: number;
        alertMs: number;
    }>,
): { state: SafeCursorLagTripwireState | null; event: SafeCursorLagTripwireEvent | null } {
    if (!current) {
        return { state: null, event: null };
    }
    const nowMs = normalizeMs(params.nowMs);
    const alertMs = Math.max(1, normalizeMs(params.alertMs));
    const lagMs = Math.max(0, nowMs - current.firstSeenAtMs);
    if (lagMs < alertMs) {
        return {
            state: {
                ...current,
                consecutiveOverThresholdTicks: 0,
            },
            event: null,
        };
    }

    const consecutiveOverThresholdTicks = current.consecutiveOverThresholdTicks + 1;
    const next = {
        ...current,
        consecutiveOverThresholdTicks,
    };
    if (current.emitted || consecutiveOverThresholdTicks < 2) {
        return { state: next, event: null };
    }

    return {
        state: {
            ...next,
            emitted: true,
        },
        event: {
            blockedCursor: current.blockedCursor,
            blockedReason: current.blockedReason,
            safeAdvanceCursor: current.safeAdvanceCursor,
            lagMs,
            consecutiveOverThresholdTicks,
        },
    };
}
