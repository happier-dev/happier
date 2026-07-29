import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { storage } from '@/sync/domains/state/storage';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { VOICE_TRANSCRIPT_SELECTOR_CACHE_MAX } from './voiceTranscriptBounds';
import { hasVoiceTranscriptNoteMeta } from './voiceTranscriptNoteMeta';

/**
 * Bounded projection state for assistant turns whose playback was interrupted.
 *
 * A client-side playback cursor cannot authoritatively identify the generated
 * text prefix a person heard. Keep the canonical generated text intact and
 * project the truthful fact we do know: playback of this turn was interrupted.
 */
const interruptedEntryIds = new Map<string, true>();
let interruptionVersion = 0;

function recordInterruptedEntry(entryId: string): void {
    if (interruptedEntryIds.has(entryId)) return;
    if (interruptedEntryIds.size >= VOICE_TRANSCRIPT_SELECTOR_CACHE_MAX) {
        const oldestKey = interruptedEntryIds.keys().next().value;
        if (oldestKey !== undefined) interruptedEntryIds.delete(oldestKey);
    }
    interruptedEntryIds.set(entryId, true);
    interruptionVersion += 1;
}

export function isVoiceTurnInterrupted(entryId: string): boolean {
    return interruptedEntryIds.has(entryId);
}

export function voiceTurnInterruptionVersion(): number {
    return interruptionVersion;
}

export function __resetVoiceTurnInterruptions(): void {
    interruptedEntryIds.clear();
    interruptionVersion += 1;
}

type StoreLike = Readonly<{ sessionMessages?: Record<string, unknown> }>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Readonly<Record<string, unknown>>;
}

function resolveEntryId(record: Readonly<Record<string, unknown>>): string | null {
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

function isAssistantTranscriptTurn(record: Readonly<Record<string, unknown>>): boolean {
    if (record.kind === 'user-text' || record.role === 'user') return false;
    if (hasVoiceTranscriptNoteMeta(record.meta)) return false;
    if (record.kind === 'agent-text') {
        return typeof record.text === 'string' && normalizeNonEmptyString(record.text) !== null;
    }
    if (record.role !== 'agent' || !Array.isArray(record.content)) return false;
    return record.content.some((entry) => {
        const textEntry = readRecord(entry);
        return textEntry?.type === 'text'
            && typeof textEntry.text === 'string'
            && normalizeNonEmptyString(textEntry.text) !== null;
    });
}

function hasExactAssistantEntry(
    state: StoreLike,
    conversationSessionId: string,
    assistantEntryId: string,
): boolean {
    const messages = readStoredSessionMessages(state as any, conversationSessionId);
    for (const message of messages) {
        const record = readRecord(message);
        if (!record || !isAssistantTranscriptTurn(record)) continue;
        const entryId = resolveEntryId(record);
        if (entryId === assistantEntryId) return true;
    }
    return false;
}

export function markVoiceConversationAssistantTurnInterrupted(params: Readonly<{
    conversationSessionId: string;
    assistantEntryId: string | null;
    getState?: () => StoreLike;
}>): void {
    const conversationSessionId = normalizeNonEmptyString(params.conversationSessionId);
    const assistantEntryId = normalizeNonEmptyString(params.assistantEntryId);
    if (!conversationSessionId || !assistantEntryId) return;
    const state = (params.getState ?? (() => storage.getState() as StoreLike))();
    if (hasExactAssistantEntry(state, conversationSessionId, assistantEntryId)) {
        recordInterruptedEntry(assistantEntryId);
    }
}
