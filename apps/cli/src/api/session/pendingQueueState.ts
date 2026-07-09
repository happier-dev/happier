export type KnownPendingQueueState = Readonly<{
    known: true;
    pendingCount: number;
    pendingBlockedCount: number;
    pendingVersion: number;
}>;

export type PendingQueueState = KnownPendingQueueState | Readonly<{ known: false }>;

export const UNKNOWN_PENDING_QUEUE_STATE: PendingQueueState = { known: false };

function readNonNegativeInteger(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
    return value;
}

function normalizeKnownPendingQueueState(state: KnownPendingQueueState): KnownPendingQueueState {
    const pendingBlockedCount = readNonNegativeInteger((state as Readonly<{ pendingBlockedCount?: unknown }>).pendingBlockedCount) ?? 0;
    return {
        known: true,
        pendingCount: state.pendingCount,
        pendingBlockedCount: Math.min(pendingBlockedCount, state.pendingCount),
        pendingVersion: state.pendingVersion,
    };
}

export function readKnownPendingQueueState(value: unknown): KnownPendingQueueState | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const pendingCount = readNonNegativeInteger(record.pendingCount);
    const pendingBlockedCount = Object.prototype.hasOwnProperty.call(record, 'pendingBlockedCount')
        ? readNonNegativeInteger(record.pendingBlockedCount)
        : 0;
    const pendingVersion = readNonNegativeInteger(record.pendingVersion);
    if (pendingCount === null || pendingBlockedCount === null || pendingVersion === null) return null;
    return {
        known: true,
        pendingCount,
        pendingBlockedCount: Math.min(pendingBlockedCount, pendingCount),
        pendingVersion,
    };
}

export function countMaterializablePendingRows(state: PendingQueueState): number {
    if (!state.known) return 0;
    return Math.max(0, state.pendingCount - normalizeKnownPendingQueueState(state).pendingBlockedCount);
}

export function applyKnownPendingQueueState(
    current: PendingQueueState,
    next: KnownPendingQueueState,
): { state: PendingQueueState; changed: boolean } {
    const normalizedNext = normalizeKnownPendingQueueState(next);
    if (current.known && normalizedNext.pendingVersion < current.pendingVersion) {
        return { state: current, changed: false };
    }

    const changed = !current.known
        || current.pendingCount !== normalizedNext.pendingCount
        || normalizeKnownPendingQueueState(current).pendingBlockedCount !== normalizedNext.pendingBlockedCount
        || current.pendingVersion !== normalizedNext.pendingVersion;
    return { state: normalizedNext, changed };
}

export function derivePendingQueueStateAfterMaterializeResult(params: Readonly<{
    current: PendingQueueState;
    didMaterialize: boolean;
    authoritativeState?: KnownPendingQueueState | null;
}>): { state: PendingQueueState; changed: boolean } {
    if (params.authoritativeState) {
        return applyKnownPendingQueueState(params.current, params.authoritativeState);
    }

    if (!params.current.known) {
        return { state: params.current, changed: false };
    }

    if (!params.didMaterialize) {
        return applyKnownPendingQueueState(params.current, {
            known: true,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: params.current.pendingVersion,
        });
    }

    const pendingCount = Math.max(0, params.current.pendingCount - 1);
    return applyKnownPendingQueueState(params.current, {
        known: true,
        pendingCount,
        pendingBlockedCount: Math.min(params.current.pendingBlockedCount, pendingCount),
        pendingVersion: params.current.pendingVersion + 1,
    });
}
