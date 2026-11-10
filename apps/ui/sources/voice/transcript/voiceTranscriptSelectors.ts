import { readStoredSessionMessages } from "@happier-dev/session-core/messages";
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { hasVoiceTranscriptNoteMeta } from './voiceTranscriptNoteMeta';
import { resolveVoiceTranscriptEntryId } from './voiceTranscriptEntryIdentity';
import { resolveVoiceContinuationNoteText } from './voiceTranscriptNotePresentation';
import { getDeviceAnalyticsId } from '@/track/settingsAnalytics/deviceAnalyticsIdentity';
import { getPreferredLanguage } from '@/text';
import { readVoiceTranscriptMessageText } from './voiceTranscriptMessageText';
import { compareVoiceTranscriptOrder } from './voiceTranscriptOrder';

export type VoiceTranscriptEntry = Readonly<{
    id: string;
    createdAt: number;
    kind: 'user' | 'assistant' | 'note';
    text: string;
    interrupted?: boolean;
}>;

const EMPTY_ENTRIES: ReadonlyArray<VoiceTranscriptEntry> = Object.freeze([]);

type TranscriptSelectorCacheEntry = Readonly<{
    limit: number;
    viewerDeviceId: string | null;
    language: string;
    result: ReadonlyArray<VoiceTranscriptEntry>;
}>;

// A memo lives only as long as its canonical message slice, so unrelated
// conversations cannot evict a demanded slice or keep retired slices alive.
const transcriptSelectorCache = new WeakMap<object, Map<number, TranscriptSelectorCacheEntry>>();

function writeTranscriptSelectorCache(slice: object, entry: TranscriptSelectorCacheEntry): void {
    let windows = transcriptSelectorCache.get(slice);
    if (!windows) {
        windows = new Map();
        transcriptSelectorCache.set(slice, windows);
    }
    windows.set(entry.limit, entry);
}

type TranscriptOrderKey = Readonly<{
    record: Readonly<Record<string, unknown>>;
    createdAt: number;
    id: string;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    if (!value || typeof value !== 'object') return null;
    return value as Readonly<Record<string, unknown>>;
}

function projectTranscriptEntry(message: unknown, viewerDeviceId: string | null, interruptedEntryIds: ReadonlySet<unknown> | undefined, entryId?: string): VoiceTranscriptEntry | null {
    const record = readRecord(message);
    if (!record) return null;
    const id = entryId ?? resolveVoiceTranscriptEntryId(message);
    if (!id) return null;
    const text = readVoiceTranscriptMessageText(record);
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
        text: kind === 'note' ? resolveVoiceContinuationNoteText(record.meta, viewerDeviceId) ?? text : text,
        ...(kind === 'assistant' && interruptedEntryIds?.has(id)
            ? { interrupted: true }
            : {}),
    };
}

export function selectVoiceTranscriptEntriesForConversationSession(
    state: Readonly<{ sessionMessages?: Record<string, unknown> }> | null | undefined,
    conversationSessionId: string | null | undefined,
    options?: Readonly<{ limit?: number; viewerDeviceId?: string | null }>,
): ReadonlyArray<VoiceTranscriptEntry> {
    const resolvedConversationSessionId = normalizeNonEmptyString(conversationSessionId);
    if (!resolvedConversationSessionId) return EMPTY_ENTRIES;

    const requestedLimit = options?.limit;
    const limit = typeof requestedLimit === 'number' && Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.max(1, Math.trunc(requestedLimit)) : Number.POSITIVE_INFINITY;
    const viewerDeviceId = options?.viewerDeviceId === undefined ? getDeviceAnalyticsId() : options.viewerDeviceId;
    const language = getPreferredLanguage();
    const slice = state?.sessionMessages?.[resolvedConversationSessionId];
    if (!slice || typeof slice !== 'object') return EMPTY_ENTRIES;
    const cached = transcriptSelectorCache.get(slice)?.get(limit);
    if (cached
        && cached.viewerDeviceId === viewerDeviceId && cached.language === language) {
        return cached.result;
    }

    const sessionSlice = state?.sessionMessages?.[resolvedConversationSessionId];
    const sessionRecord = readRecord(sessionSlice);
    const interruptedEntryIds: ReadonlySet<unknown> | undefined = sessionRecord?.voiceInterruptedEntryIds instanceof Set
        ? sessionRecord.voiceInterruptedEntryIds : undefined;
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
        if (previous && compareVoiceTranscriptOrder(previous, key) > 0) alreadyOrdered = false;
        orderKeys.push(key);
    }
    // Session sequence records arrival order. A local note or delayed durable
    // row can arrive after newer speech, so both stored shapes establish event
    // order before selecting a window. Only ordering metadata is read here.
    if (!alreadyOrdered) orderKeys.sort(compareVoiceTranscriptOrder);

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
        const entry = projectTranscriptEntry(record, viewerDeviceId, interruptedEntryIds, id);
        if (entry) newestFirst.push(entry);
    }

    const result: ReadonlyArray<VoiceTranscriptEntry> = newestFirst.length === 0
        ? EMPTY_ENTRIES
        : Object.freeze(newestFirst.reverse());
    writeTranscriptSelectorCache(slice, { limit, viewerDeviceId, language, result });
    return result;
}
