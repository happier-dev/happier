/**
 * Canonical seam for releasing per-session derived transcript memory.
 *
 * Several module-scoped memo caches (e.g. the per-session message-array and
 * subagent-source caches in `sync/store/hooks.ts`) root a session's materialized
 * `Message` objects — including a ref to the whole `messagesById` record —
 * outside the zustand store. Removing the store entry alone would leave those
 * roots alive, so both transcript owners of "this session's transcript memory
 * is being released" — `evictSessionMessages` (bounded retention eviction) and
 * `deleteSession` — MUST call `clearSessionTranscriptDerivedCachesForSession`.
 *
 * Cache owners register a clear function here at module init instead of being
 * imported directly, which keeps `sync/store/domains/**` free of import cycles
 * with `sync/store/hooks.ts`.
 */

type SessionTranscriptDerivedCacheClear = (sessionId: string) => void;

const clearFns = new Set<SessionTranscriptDerivedCacheClear>();

export function registerSessionTranscriptDerivedCacheClear(clear: SessionTranscriptDerivedCacheClear): () => void {
    clearFns.add(clear);
    return () => {
        clearFns.delete(clear);
    };
}

export function clearSessionTranscriptDerivedCachesForSession(sessionId: string): void {
    for (const clear of clearFns) {
        clear(sessionId);
    }
}
