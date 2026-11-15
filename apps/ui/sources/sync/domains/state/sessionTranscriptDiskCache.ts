import { z } from 'zod';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { buildScopedKey, deleteWarmCacheRecordsWithPrefix, loadScopedRecord, saveScopedRecord } from './warmCachePersistence';
import { Platform } from 'react-native';

/**
 * Best-effort disk copy of a session transcript, written when bounded transcript retention
 * (`sessionTranscriptRetention` → `evictSessionMessages`) drops the hydrated transcript from
 * memory, and read back as a first-paint baseline when the session is reopened before the
 * first-open server load lands.
 *
 * The server remains the canonical authority: the hydrate path funnels through `applyMessages`
 * (the canonical reducer ingest) and never marks the session loaded, so the normal first-open
 * fetch still runs, still sets `isLoaded`, and newer/older pagination still reconciles coverage
 * against the server. A hydrated baseline that is older than the server produces the same
 * mixed-coverage shape as any paged session: a first-class window gap, not a fork of the load
 * pipeline.
 *
 * At-rest placement follows the warm-cache owner: encrypted MMKV on native. Web and the
 * Tauri desktop shell (the web build) are NOT written: react-native-mmkv's web adapter backs
 * onto `localStorage`, whose per-origin quota is single-digit MBs — one 10k-message
 * transcript can consume it whole, and the next settings write then throws inside boot-path
 * persistence (observed as a desktop failure after a full workday of testing). Transcript
 * persistence on the web origin would be a recurring quota bomb, so evicted transcripts stay
 * memory-only there: eviction still bounds memory, and reopen falls back to the first-open
 * fetch exactly as before this cache existed. Persistence is best-effort ("if possible"): a
 * skip, a quota failure, or a missing scope never blocks eviction.
 */

const SESSION_TRANSCRIPT_DISK_CACHE_PREFIX = 'session-transcript-v1';

function isWebRuntime(): boolean {
    return Platform.OS === 'web';
}

let webPruneCompleted = false;

/**
 * One-time retirement of transcript records the pre-gate build wrote into the web origin:
 * installs whose localStorage quota those records filled recover their settings writes
 * without manual intervention. Best-effort and idempotent.
 */
function pruneWebSessionTranscriptDiskCacheOnce(): void {
    if (webPruneCompleted) return;
    webPruneCompleted = true;
    try {
        deleteWarmCacheRecordsWithPrefix(`${SESSION_TRANSCRIPT_DISK_CACHE_PREFIX}:`);
    } catch {
        // The prune itself is best-effort: a store that cannot be opened is a no-op miss for
        // every reader anyway.
    }
}

/**
 * Envelope validation only. The messages themselves were normalized by the store before they
 * were persisted, and on hydrate they re-enter through `applyMessages`' reducer — duplicating
 * the full `Message` union here would be a second schema for the same wire shape. The envelope
 * guarantees the record is ours and each entry has an identity the store can key on.
 */
const SessionTranscriptDiskCacheRecordSchema = z.object({
    v: z.literal(1),
    messages: z.array(z.object({ id: z.string().min(1) }).passthrough()),
});

function buildSessionTranscriptDiskCacheKey(
    scope: ServerAccountScope | null,
    sessionId: string,
): string | null {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return null;
    return buildScopedKey(
        `${SESSION_TRANSCRIPT_DISK_CACHE_PREFIX}:${normalizedSessionId}`,
        scope?.serverId,
        scope?.accountId,
    );
}

export type EvictedSessionTranscriptSnapshot = Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
}>;

/**
 * Persist one session's transcript at eviction time. Returns whether a copy was written;
 * `false` covers every best-effort skip (no scope, empty transcript, quota failure) — callers
 * must treat that as "evict anyway".
 */
export function persistEvictedSessionTranscript(
    scope: ServerAccountScope | null,
    sessionId: string,
    transcript: EvictedSessionTranscriptSnapshot,
): boolean {
    if (isWebRuntime()) {
        // See the placement note above: the web origin's quota cannot host MB-scale transcript
        // records. First use also retires whatever the pre-gate build managed to write.
        pruneWebSessionTranscriptDiskCacheOnce();
        return false;
    }
    const key = buildSessionTranscriptDiskCacheKey(scope, sessionId);
    if (!key) return false;

    const messages: Message[] = [];
    for (const messageId of transcript.messageIdsOldestFirst) {
        const message = transcript.messagesById[messageId];
        if (message) messages.push(message as Message);
    }
    if (messages.length === 0) {
        // An empty transcript has no first-paint value; also retire any stale copy so a
        // re-open cannot paint content the store just deliberately dropped.
        saveScopedRecord(key, {});
        return false;
    }

    saveScopedRecord(key, { v: 1 as const, messages });
    return true;
}

/**
 * Read a persisted transcript back, oldest-first. Returns `null` when no copy exists, the
 * record fails envelope validation (the key is then deleted, like every corrupt scoped record),
 * or the scope cannot key it.
 */
export function readEvictedSessionTranscript(
    scope: ServerAccountScope | null,
    sessionId: string,
): readonly Message[] | null {
    if (isWebRuntime()) {
        // Nothing new is written on web; stale pre-gate records are retired on first use.
        pruneWebSessionTranscriptDiskCacheOnce();
        return null;
    }
    const key = buildSessionTranscriptDiskCacheKey(scope, sessionId);
    if (!key) return null;
    const record = loadScopedRecord(key, SessionTranscriptDiskCacheRecordSchema);
    if (!record) return null;
    return record.messages as unknown as readonly Message[];
}

/** Drop the persisted copy (session deleted, or content intentionally emptied). */
export function deleteEvictedSessionTranscript(
    scope: ServerAccountScope | null,
    sessionId: string,
): void {
    const key = buildSessionTranscriptDiskCacheKey(scope, sessionId);
    if (!key) return;
    saveScopedRecord(key, {});
}

/**
 * Hydrate a reopened session from its persisted copy. Only acts when the store has no
 * materialized messages for the session (the post-eviction / first-open state), and only
 * applies through the caller's canonical ingest — it never marks the session loaded and
 * never overrides live content.
 *
 * Returns whether a baseline was applied.
 */
export function hydrateEvictedSessionTranscript(params: Readonly<{
    scope: ServerAccountScope | null;
    sessionId: string;
    hasMaterializedMessages: boolean;
    applyMessages: (sessionId: string, messages: readonly Message[]) => void;
}>): boolean {
    if (params.hasMaterializedMessages) return false;
    if (!params.scope) return false;
    const messages = readEvictedSessionTranscript(params.scope, params.sessionId);
    if (!messages || messages.length === 0) return false;
    params.applyMessages(params.sessionId, messages);
    return true;
}
