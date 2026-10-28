// Per-session freshness signal for the direct-session transcript push channel.
//
// The socket arrival path records a timestamp for every accepted
// `direct-session-transcript-delta`; tail-poll scheduling reads it to decide
// whether pushes are currently keeping a session fresh (idle heartbeat tier)
// or whether polling must take over at the active tier. Entries are plain
// recency hints: staleness is bounded by the readers' freshness window, so a
// leftover timestamp after a server-scope switch self-heals within that
// window and needs no scope-aware invalidation.

const directSessionDeltaArrivedAtBySessionId = new Map<string, number>();

export function recordDirectSessionDeltaArrival(sessionId: string): void {
    directSessionDeltaArrivedAtBySessionId.set(sessionId, Date.now());
}

export function readDirectSessionDeltaArrivedAt(sessionId: string): number | null {
    return directSessionDeltaArrivedAtBySessionId.get(sessionId) ?? null;
}

export function resetDirectSessionDeltaArrivalForTests(): void {
    directSessionDeltaArrivedAtBySessionId.clear();
}
