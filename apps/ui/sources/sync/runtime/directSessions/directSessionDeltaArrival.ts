// Per-session freshness signal for the direct-session transcript push channel.
//
// The socket arrival path records a timestamp for every accepted
// `direct-session-transcript-delta`; tail-poll scheduling reads it to decide
// whether pushes are currently keeping a session fresh (idle heartbeat tier)
// or whether polling must take over at the active tier. Entries are recency
// hints released explicitly at server-scope switches and session deletion; a
// missed release still self-heals within the readers' freshness window.

import { registerSessionTranscriptDerivedCacheClear } from '@/sync/runtime/sessionTranscriptDerivedCaches';

const directSessionDeltaArrivedAtBySessionId = new Map<string, number>();

export function recordDirectSessionDeltaArrival(sessionId: string): void {
    directSessionDeltaArrivedAtBySessionId.set(sessionId, Date.now());
}

export function readDirectSessionDeltaArrivedAt(sessionId: string): number | null {
    return directSessionDeltaArrivedAtBySessionId.get(sessionId) ?? null;
}

export function clearDirectSessionDeltaArrival(sessionId: string): void {
    directSessionDeltaArrivedAtBySessionId.delete(sessionId);
}

export function clearDirectSessionDeltaArrivals(): void {
    directSessionDeltaArrivedAtBySessionId.clear();
}

export function resetDirectSessionDeltaArrivalForTests(): void {
    directSessionDeltaArrivedAtBySessionId.clear();
}

// Session deletion / transcript eviction releases the per-session hint so the poller does not
// read a stale "pushes are fresh" verdict for a session whose transcript state is gone.
registerSessionTranscriptDerivedCacheClear(clearDirectSessionDeltaArrival);
