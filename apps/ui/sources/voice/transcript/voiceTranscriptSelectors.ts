import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { hasVoiceTranscriptNoteMeta } from './voiceTranscriptNoteMeta';

export type VoiceTranscriptEntry = Readonly<{
    id: string;
    createdAt: number;
    kind: 'user' | 'assistant' | 'note';
    text: string;
}>;

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
): ReadonlyArray<VoiceTranscriptEntry> {
    const resolvedConversationSessionId = normalizeNonEmptyString(conversationSessionId);
    if (!resolvedConversationSessionId) return [];

    const messages = readStoredSessionMessages(state as any, resolvedConversationSessionId);
    const entries: VoiceTranscriptEntry[] = [];
    for (const message of messages) {
        const record = readRecord(message);
        const entryId = resolveTranscriptEntryId(message);
        if (!record || !entryId) continue;
        const text = extractMessageText(message);
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
    return entries;
}
