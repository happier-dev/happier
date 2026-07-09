import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { hasVoiceTranscriptNoteMeta } from './voiceTranscriptNoteMeta';
import { resolveVoiceTranscriptRenderWindow, VOICE_TRANSCRIPT_SELECTOR_CACHE_MAX } from './voiceTranscriptBounds';
import { readVoiceTurnTruncatedText, voiceTurnTruncationVersion } from './voiceTurnTruncation';

export type VoiceTranscriptEntry = Readonly<{
    id: string;
    createdAt: number;
    kind: 'user' | 'assistant' | 'note';
    text: string;
}>;

const EMPTY_ENTRIES: ReadonlyArray<VoiceTranscriptEntry> = Object.freeze([]);

type TranscriptSelectorCacheEntry = Readonly<{
    slice: unknown;
    limit: number;
    truncationVersion: number;
    result: ReadonlyArray<VoiceTranscriptEntry>;
}>;

/**
 * Per-conversation memo keyed on the active conversation's message-slice
 * reference. Recompute is scoped to the active conversation: a change to an
 * unrelated session swaps the whole `sessionMessages` map reference but leaves
 * the active slice reference intact, so the cached result is returned unchanged
 * (referential stability for unchanged rows). Only a change to the active
 * conversation's slice (or the requested window) recomputes.
 *
 * Bounded with LRU eviction (`VOICE_TRANSCRIPT_SELECTOR_CACHE_MAX`): the map
 * keeps the most-recently-projected conversations memoized and retires the
 * least-recently-used keys, so it cannot grow without bound over a long-lived
 * session. `Map` iteration order is insertion order, so the first key is the LRU
 * entry once hits re-insert touched keys at the tail.
 */
const transcriptSelectorCache = new Map<string, TranscriptSelectorCacheEntry>();

function readTranscriptSelectorCache(key: string): TranscriptSelectorCacheEntry | undefined {
    const entry = transcriptSelectorCache.get(key);
    if (entry !== undefined) {
        // Touch on hit: move the key to the tail so it is the most-recently-used.
        transcriptSelectorCache.delete(key);
        transcriptSelectorCache.set(key, entry);
    }
    return entry;
}

function writeTranscriptSelectorCache(key: string, entry: TranscriptSelectorCacheEntry): void {
    if (transcriptSelectorCache.has(key)) {
        transcriptSelectorCache.delete(key);
    } else if (transcriptSelectorCache.size >= VOICE_TRANSCRIPT_SELECTOR_CACHE_MAX) {
        const oldestKey = transcriptSelectorCache.keys().next().value;
        if (oldestKey !== undefined) {
            transcriptSelectorCache.delete(oldestKey);
        }
    }
    transcriptSelectorCache.set(key, entry);
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    if (!value || typeof value !== 'object') return null;
    return value as Readonly<Record<string, unknown>>;
}

function extractMessageText(message: unknown): string | null {
    const record = readRecord(message);
    if (!record) return null;
    if (record.kind === 'user-text' || record.kind === 'agent-text') {
        return typeof record.text === 'string'
            ? normalizeNonEmptyString(record.text)
            : null;
    }
    if (record.role === 'user') {
        const content = readRecord(record.content);
        return content?.type === 'text' && typeof content.text === 'string'
            ? normalizeNonEmptyString(content.text)
            : null;
    }
    if (record.role === 'agent') {
        if (!Array.isArray(record.content)) return null;
        for (const entry of record.content) {
            const textEntry = readRecord(entry);
            if (!textEntry || textEntry.type !== 'text' || typeof textEntry.text !== 'string') continue;
            return normalizeNonEmptyString(textEntry.text);
        }
    }
    return null;
}

function resolveTranscriptEntryId(message: unknown): string | null {
    const record = readRecord(message);
    if (!record) return null;
    return normalizeNonEmptyString(
        typeof record.realID === 'string'
            ? record.realID
            : typeof record.localId === 'string'
                ? record.localId
                : typeof record.id === 'string'
                    ? record.id
                    : null,
    );
}

export function selectVoiceTranscriptEntriesForConversationSession(
    state: Readonly<{ sessionMessages?: Record<string, unknown> }> | null | undefined,
    conversationSessionId: string | null | undefined,
    options?: Readonly<{ limit?: number }>,
): ReadonlyArray<VoiceTranscriptEntry> {
    const resolvedConversationSessionId = normalizeNonEmptyString(conversationSessionId);
    if (!resolvedConversationSessionId) return EMPTY_ENTRIES;

    const limit = resolveVoiceTranscriptRenderWindow(options?.limit);
    const slice = state?.sessionMessages?.[resolvedConversationSessionId];
    // The played-ms truncation registry can change "what was heard" without
    // changing the underlying message slice (a barge-in records an override but
    // does not rewrite the store), so its version participates in the memo key.
    const truncationVersion = voiceTurnTruncationVersion();
    const cached = readTranscriptSelectorCache(resolvedConversationSessionId);
    if (cached && cached.slice === slice && cached.limit === limit && cached.truncationVersion === truncationVersion) {
        return cached.result;
    }

    const messages = readStoredSessionMessages(state as any, resolvedConversationSessionId);
    const entries: VoiceTranscriptEntry[] = [];
    for (const message of messages) {
        const record = readRecord(message);
        const entryId = resolveTranscriptEntryId(message);
        if (!record || !entryId) continue;
        // A barge-in truncation override replaces the heard text for this turn;
        // an empty override means nothing meaningful was heard → drop the entry.
        const truncatedOverride = readVoiceTurnTruncatedText(entryId);
        const text = truncatedOverride !== null ? normalizeNonEmptyString(truncatedOverride) : extractMessageText(message);
        if (!text) continue;
        const kind =
            record.kind === 'user-text' || record.role === 'user'
                ? 'user'
                : hasVoiceTranscriptNoteMeta(record.meta)
                    ? 'note'
                    : 'assistant';
        entries.push({
            id: entryId,
            createdAt: typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : 0,
            kind,
            text,
        });
    }

    entries.sort((left, right) =>
        left.createdAt === right.createdAt
            ? left.id.localeCompare(right.id)
            : left.createdAt - right.createdAt,
    );

    // Enforce the active render window: keep the most recent `limit` items.
    // Older items remain in the message store and page in via existing
    // session-message pagination; they are not dropped from persistence.
    const windowed: ReadonlyArray<VoiceTranscriptEntry> = entries.length > limit
        ? Object.freeze(entries.slice(entries.length - limit))
        : Object.freeze(entries);
    const result = windowed.length === 0 ? EMPTY_ENTRIES : windowed;
    writeTranscriptSelectorCache(resolvedConversationSessionId, { slice, limit, truncationVersion, result });
    return result;
}
