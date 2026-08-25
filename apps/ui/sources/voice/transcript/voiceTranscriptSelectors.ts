import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { hasVoiceTranscriptNoteMeta } from './voiceTranscriptNoteMeta';
import { resolveVoiceTranscriptEntryId } from './voiceTranscriptEntryIdentity';
import { resolveVoiceTranscriptRenderWindow, VOICE_TRANSCRIPT_SELECTOR_CACHE_MAX } from './voiceTranscriptBounds';
import { isVoiceTurnInterrupted, voiceTurnInterruptionVersion } from './voiceTurnInterruption';

export type VoiceTranscriptEntry = Readonly<{
    id: string;
    createdAt: number;
    kind: 'user' | 'assistant' | 'note';
    text: string;
    interrupted?: boolean;
}>;

const EMPTY_ENTRIES: ReadonlyArray<VoiceTranscriptEntry> = Object.freeze([]);

type TranscriptSelectorCacheEntry = Readonly<{
    slice: unknown;
    limit: number;
    interruptionVersion: number;
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

type TranscriptOrderKey = Readonly<{
    record: Readonly<Record<string, unknown>>;
    createdAt: number;
    id: string;
}>;

/** The projection's one ordering rule, shared by the order check and the sort. */
function compareTranscriptOrderKeys(left: TranscriptOrderKey, right: TranscriptOrderKey): number {
    return left.createdAt === right.createdAt
        ? left.id.localeCompare(right.id)
        : left.createdAt - right.createdAt;
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

function projectTranscriptEntry(message: unknown, entryId?: string): VoiceTranscriptEntry | null {
    const record = readRecord(message);
    if (!record) return null;
    const id = entryId ?? resolveVoiceTranscriptEntryId(message);
    if (!id) return null;
    const text = extractMessageText(record);
    if (!text) return null;
    const kind =
        record.kind === 'user-text' || record.role === 'user'
            ? 'user'
            : hasVoiceTranscriptNoteMeta(record.meta)
                ? 'note'
                : 'assistant';
    return {
        id,
        createdAt: typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : 0,
        kind,
        text,
        ...(kind === 'assistant' && isVoiceTurnInterrupted(id)
            ? { interrupted: true }
            : {}),
    };
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
    // Interruption state changes without rewriting the message slice, so its
    // version participates in the memo key.
    const interruptionVersion = voiceTurnInterruptionVersion();
    const cached = readTranscriptSelectorCache(resolvedConversationSessionId);
    if (cached && cached.slice === slice && cached.limit === limit && cached.interruptionVersion === interruptionVersion) {
        return cached.result;
    }

    const sessionSlice = state?.sessionMessages?.[resolvedConversationSessionId];
    const sessionRecord = readRecord(sessionSlice);
    const canonicalIds = sessionRecord?.messageIdsOldestFirst;
    const canonicalMessagesById = readRecord(sessionRecord?.messagesById ?? sessionRecord?.messagesMap);

    if (Array.isArray(canonicalIds) && canonicalMessagesById) {
        const newestFirst: VoiceTranscriptEntry[] = [];
        for (let cursor = canonicalIds.length - 1; cursor >= 0 && newestFirst.length < limit; cursor -= 1) {
            const messageId = canonicalIds[cursor];
            const message = typeof messageId === 'string' ? canonicalMessagesById[messageId] : undefined;
            const entry = projectTranscriptEntry(message);
            if (entry) newestFirst.push(entry);
        }
        const result: ReadonlyArray<VoiceTranscriptEntry> = newestFirst.length === 0
            ? EMPTY_ENTRIES
            : Object.freeze(newestFirst.reverse());
        writeTranscriptSelectorCache(resolvedConversationSessionId, { slice, limit, interruptionVersion, result });
        return result;
    }

    const messages = readStoredSessionMessages<unknown, unknown>(state, resolvedConversationSessionId);

    /*
     * Pass 1 reads ordering keys only — no text extraction, note-meta parse or
     * interruption lookup. Those are the expensive per-message steps, and a long
     * conversation re-projects on every append, so the old shape paid them for
     * every message and then threw all but the newest `limit` away.
     */
    const orderKeys: TranscriptOrderKey[] = [];
    let alreadyOrdered = true;
    for (const message of messages) {
        const record = readRecord(message);
        const entryId = resolveVoiceTranscriptEntryId(message);
        if (!record || !entryId) continue;
        const key: TranscriptOrderKey = {
            record,
            id: entryId,
            createdAt: typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : 0,
        };
        const previous = orderKeys[orderKeys.length - 1];
        if (previous && compareTranscriptOrderKeys(previous, key) > 0) alreadyOrdered = false;
        orderKeys.push(key);
    }
    // The canonical store hands back `messageIdsOldestFirst` order, which already
    // satisfies this comparator. Legacy slices persisted as a raw array carry no
    // such guarantee, so the tail is only exact once they are ordered.
    if (!alreadyOrdered) orderKeys.sort(compareTranscriptOrderKeys);

    /*
     * Pass 2 walks newest-first and stops at the window. The window counts
     * *projected* entries, so a message with no renderable text is skipped and
     * the walk reaches one further back — the same set the unbounded projection
     * produced, without projecting the messages behind it. Older items remain in
     * the message store and page in via existing session-message pagination;
     * they are not dropped from persistence.
     */
    const newestFirst: VoiceTranscriptEntry[] = [];
    for (let cursor = orderKeys.length - 1; cursor >= 0 && newestFirst.length < limit; cursor -= 1) {
        const { record, id } = orderKeys[cursor]!;
        const entry = projectTranscriptEntry(record, id);
        if (entry) newestFirst.push(entry);
    }

    const result: ReadonlyArray<VoiceTranscriptEntry> = newestFirst.length === 0
        ? EMPTY_ENTRIES
        : Object.freeze(newestFirst.reverse());
    writeTranscriptSelectorCache(resolvedConversationSessionId, { slice, limit, interruptionVersion, result });
    return result;
}
