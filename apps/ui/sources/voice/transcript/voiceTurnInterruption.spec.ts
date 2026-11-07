import { beforeEach, describe, expect, it } from 'vitest';
import { storage } from '@/sync/domains/state/storage';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';

import { selectVoiceTranscriptEntriesForConversationSession } from './voiceTranscriptSelectors';
import {
    __resetVoiceTurnInterruptions,
    isVoiceTurnInterrupted,
    markVoiceConversationAssistantTurnInterrupted,
} from './voiceTurnInterruption';

function assistantMessage(id: string, text: string, createdAt: number) {
    const message = normalizeRawMessage(id, id, createdAt, { role: 'agent',
        content: { type: 'output', data: { type: 'assistant', uuid: id,
            message: { role: 'assistant', content: [{ type: 'text', text }] } } } });
    if (!message) throw new Error('Invalid assistant fixture');
    return message;
}

function userMessage(id: string, text: string, createdAt: number) {
    const message = normalizeRawMessage(id, id, createdAt, { role: 'user', content: { type: 'text', text } });
    if (!message) throw new Error('Invalid user fixture');
    return message;
}

const ASSISTANT_TEXT = 'one two three four';

function stateWithAssistantTurns(conversationSessionId: string) {
    storage.getState().applyMessages(conversationSessionId, [
        userMessage('u1', 'tell me a story', 100),
        assistantMessage('a1', 'previous response', 200),
        assistantMessage('a2', ASSISTANT_TEXT, 300),
    ]);
    return storage.getState();
}

describe('markVoiceConversationAssistantTurnInterrupted', () => {
    it('publishes a late interruption through the subscribed conversation slice once', () => {
        storage.setState({ sessionMessages: {} });
        const message = normalizeRawMessage('late-final', 'late-final', 100, {
            role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: 'late-final',
                message: { role: 'assistant', content: [{ type: 'text', text: ASSISTANT_TEXT }] } } },
        });
        if (!message) throw new Error('Invalid assistant fixture');
        storage.getState().applyMessages('late-conversation', [message]);
        storage.getState().applyMessages('other-conversation', [{ ...message, id: 'other-final' }]);
        const other = storage.getState().sessionMessages['other-conversation'];
        const observed: Array<ReturnType<typeof selectVoiceTranscriptEntriesForConversationSession>> = [];
        const unsubscribe = storage.subscribe(state => {
            observed.push(selectVoiceTranscriptEntriesForConversationSession(state, 'late-conversation'));
        }, { sessionMessages: ['late-conversation'] });
        try {
            markVoiceConversationAssistantTurnInterrupted({ conversationSessionId: 'late-conversation', assistantEntryId: 'late-final' });
            expect(observed).toEqual([[expect.objectContaining({ id: 'late-final', text: ASSISTANT_TEXT, interrupted: true })]]);
            markVoiceConversationAssistantTurnInterrupted({ conversationSessionId: 'late-conversation', assistantEntryId: 'late-final' });
            expect(observed).toHaveLength(1);
            expect(storage.getState().sessionMessages['other-conversation']).toBe(other);
        } finally {
            unsubscribe();
        }
    });

    beforeEach(() => {
        __resetVoiceTurnInterruptions();
        storage.setState({ sessionMessages: {} });
    });

    it('marks the exact authoritative assistant final without rewriting its generated text', () => {
        const conversationSessionId = 'conv-interrupt-1';
        stateWithAssistantTurns(conversationSessionId);

        markVoiceConversationAssistantTurnInterrupted({
            conversationSessionId,
            assistantEntryId: 'a2',
        });

        expect(isVoiceTurnInterrupted('a1', conversationSessionId)).toBe(false);
        expect(isVoiceTurnInterrupted('a2', conversationSessionId)).toBe(true);

        const entries = selectVoiceTranscriptEntriesForConversationSession(storage.getState(), conversationSessionId);
        expect(entries.find((entry) => entry.id === 'a2')).toMatchObject({
            text: ASSISTANT_TEXT,
            interrupted: true,
        });
        expect(entries.find((entry) => entry.id === 'u1')).toMatchObject({
            text: 'tell me a story',
        });
        expect(entries.find((entry) => entry.id === 'u1')).not.toHaveProperty('interrupted');
    });

    it('records a persisted row under the identity the transcript projects it with', () => {
        const conversationSessionId = 'conv-interrupt-persisted-identity';
        const persisted = {
            ...assistantMessage('server-assistant-1', ASSISTANT_TEXT, 300),
            realID: 'server-assistant-1',
            localId: 'voice-realtime:attempt-1:assistant:assistant-1',
        };
        storage.getState().applyMessages(conversationSessionId, [persisted]);

        markVoiceConversationAssistantTurnInterrupted({
            conversationSessionId,
            assistantEntryId: persisted.localId,
        });

        // The canonical local id is what the transcript renders this row under,
        // so the interruption mark must be keyed there rather than under the
        // later-arriving server id, which no projected entry carries.
        expect(isVoiceTurnInterrupted(persisted.realID, conversationSessionId)).toBe(false);
        expect(isVoiceTurnInterrupted(persisted.localId, conversationSessionId)).toBe(true);
        expect(selectVoiceTranscriptEntriesForConversationSession(
            storage.getState(),
            conversationSessionId,
        )).toEqual([
            expect.objectContaining({
                id: persisted.localId,
                interrupted: true,
            }),
        ]);
    });

    it('does not misattribute interruption to N-1 when the current output has no authoritative final', () => {
        const conversationSessionId = 'conv-interrupt-no-final';
        storage.getState().applyMessages(conversationSessionId, [assistantMessage('a1', 'previous response', 200)]);
        const before = storage.getState();

        markVoiceConversationAssistantTurnInterrupted({
            conversationSessionId,
            assistantEntryId: null,
        });

        expect(isVoiceTurnInterrupted('a1', conversationSessionId)).toBe(false);
        expect(storage.getState()).toBe(before);
    });

    it('no-ops when the exact identity is absent from the conversation or belongs to a user turn', () => {
        const conversationSessionId = 'conv-interrupt-missing-identity';
        const before = stateWithAssistantTurns(conversationSessionId);

        markVoiceConversationAssistantTurnInterrupted({
            conversationSessionId,
            assistantEntryId: 'missing',
        });
        markVoiceConversationAssistantTurnInterrupted({
            conversationSessionId,
            assistantEntryId: 'u1',
        });

        expect(storage.getState()).toBe(before);
    });
});
