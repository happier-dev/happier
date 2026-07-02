export type KnownPendingQueueState = Readonly<{
    known: true;
    pendingCount: number;
    pendingVersion: number;
}>;

export type PendingQueueState = KnownPendingQueueState | Readonly<{ known: false }>;

export const UNKNOWN_PENDING_QUEUE_STATE: PendingQueueState = { known: false };

function readNonNegativeInteger(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
    return value;
}

export function readKnownPendingQueueState(value: unknown): KnownPendingQueueState | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const pendingCount = readNonNegativeInteger(record.pendingCount);
    const pendingVersion = readNonNegativeInteger(record.pendingVersion);
    if (pendingCount === null || pendingVersion === null) return null;
    return { known: true, pendingCount, pendingVersion };
}

export function applyKnownPendingQueueState(
    current: PendingQueueState,
    next: KnownPendingQueueState,
): { state: PendingQueueState; changed: boolean } {
    if (current.known && next.pendingVersion < current.pendingVersion) {
        return { state: current, changed: false };
    }

    const changed = !current.known
        || current.pendingCount !== next.pendingCount
        || current.pendingVersion !== next.pendingVersion;
    return { state: next, changed };
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
            pendingVersion: params.current.pendingVersion,
        });
    }

    return applyKnownPendingQueueState(params.current, {
        known: true,
        pendingCount: Math.max(0, params.current.pendingCount - 1),
        pendingVersion: params.current.pendingVersion + 1,
    });
}
