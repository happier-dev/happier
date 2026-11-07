import {
    readStoredSessionMessages,
    type SessionMessagesStateLike,
} from "@happier-dev/session-core/messages";
import { storage } from '@/sync/domains/state/storage';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { hasVoiceTranscriptNoteMeta } from './voiceTranscriptNoteMeta';
import { resolveVoiceTranscriptEntryId } from './voiceTranscriptEntryIdentity';

/**
 * Transient projection state for assistant turns whose playback was interrupted.
 *
 * A client-side playback cursor cannot authoritatively identify the generated
 * text prefix a person heard. Keep the canonical generated text intact and
 * project the truthful fact we do know: playback of this turn was interrupted.
 */
export function isVoiceTurnInterrupted(entryId: string, conversationSessionId: string): boolean {
    return storage.getState().sessionMessages[conversationSessionId]?.voiceInterruptedEntryIds?.has(entryId) === true;
}

export function __resetVoiceTurnInterruptions(): void {
    storage.setState(state => {
        let sessionMessages = state.sessionMessages;
        for (const [sessionId, slice] of Object.entries(state.sessionMessages)) {
            if (!slice.voiceInterruptedEntryIds?.size) continue;
            if (sessionMessages === state.sessionMessages) sessionMessages = { ...sessionMessages };
            sessionMessages[sessionId] = { ...slice, voiceInterruptedEntryIds: undefined };
        }
        return sessionMessages === state.sessionMessages ? state : { ...state, sessionMessages };
    });
}

type StoreLike = Readonly<{
    sessionMessages?: Record<string, SessionMessagesStateLike<unknown>>;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Readonly<Record<string, unknown>>;
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

function resolveExactAssistantEntryId(
    state: StoreLike,
    conversationSessionId: string,
    assistantEntryId: string,
): string | null {
    const messages = readStoredSessionMessages(state, conversationSessionId);
    for (const message of messages) {
        const record = readRecord(message);
        if (!record || !isAssistantTranscriptTurn(record)) continue;
        const matchesProjectedIdentity = (
            record.realID === assistantEntryId
            || record.localId === assistantEntryId
            || record.id === assistantEntryId
        );
        if (matchesProjectedIdentity) return resolveVoiceTranscriptEntryId(record);
    }
    return null;
}

export function markVoiceConversationAssistantTurnInterrupted(params: Readonly<{
    conversationSessionId: string;
    assistantEntryId: string | null;
}>): void {
    const conversationSessionId = normalizeNonEmptyString(params.conversationSessionId);
    const assistantEntryId = normalizeNonEmptyString(params.assistantEntryId);
    if (!conversationSessionId || !assistantEntryId) return;
    storage.setState(state => {
        const slice = state.sessionMessages[conversationSessionId];
        if (!slice) return state;
        const authoritativeEntryId = resolveExactAssistantEntryId(state, conversationSessionId, assistantEntryId);
        if (!authoritativeEntryId || slice.voiceInterruptedEntryIds?.has(authoritativeEntryId)) return state;
        return { ...state, sessionMessages: { ...state.sessionMessages, [conversationSessionId]: {
            ...slice, voiceInterruptedEntryIds: new Set([...(slice.voiceInterruptedEntryIds ?? []), authoritativeEntryId]),
        } } };
    });
}
