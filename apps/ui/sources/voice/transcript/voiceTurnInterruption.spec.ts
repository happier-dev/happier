import { beforeEach, describe, expect, it } from 'vitest';

import { selectVoiceTranscriptEntriesForConversationSession } from './voiceTranscriptSelectors';
import {
    __resetVoiceTurnInterruptions,
    isVoiceTurnInterrupted,
    markVoiceConversationAssistantTurnInterrupted,
    voiceTurnInterruptionVersion,
} from './voiceTurnInterruption';

function assistantMessage(id: string, text: string, createdAt: number) {
    return {
        id,
        localId: id,
        createdAt,
        isSidechain: false,
        role: 'agent',
        content: [{ type: 'text', text, uuid: id, parentUUID: null }],
    };
}

function userMessage(id: string, text: string, createdAt: number) {
    return {
        id,
        localId: id,
        createdAt,
        isSidechain: false,
        role: 'user',
        content: { type: 'text', text },
    };
}

const ASSISTANT_TEXT = 'one two three four';

function stateWithAssistantTurns(conversationSessionId: string) {
    return {
        sessionMessages: {
            [conversationSessionId]: {
                messages: [
                    userMessage('u1', 'tell me a story', 100),
                    assistantMessage('a1', 'previous response', 200),
                    assistantMessage('a2', ASSISTANT_TEXT, 300),
                ],
            },
        },
    };
}

describe('markVoiceConversationAssistantTurnInterrupted', () => {
    beforeEach(() => {
        __resetVoiceTurnInterruptions();
    });

    it('marks the exact authoritative assistant final without rewriting its generated text', () => {
        const conversationSessionId = 'conv-interrupt-1';
        const state = stateWithAssistantTurns(conversationSessionId);
        const versionBefore = voiceTurnInterruptionVersion();

        markVoiceConversationAssistantTurnInterrupted({
            conversationSessionId,
            assistantEntryId: 'a2',
            getState: () => state,
        });

        expect(isVoiceTurnInterrupted('a1')).toBe(false);
        expect(isVoiceTurnInterrupted('a2')).toBe(true);
        expect(voiceTurnInterruptionVersion()).toBeGreaterThan(versionBefore);

        const entries = selectVoiceTranscriptEntriesForConversationSession(state, conversationSessionId);
        expect(entries.find((entry) => entry.id === 'a2')).toMatchObject({
            text: ASSISTANT_TEXT,
            interrupted: true,
        });
        expect(entries.find((entry) => entry.id === 'u1')).toMatchObject({
            text: 'tell me a story',
        });
        expect(entries.find((entry) => entry.id === 'u1')).not.toHaveProperty('interrupted');
    });

    it('resolves a projected local identity to the authoritative persisted row identity', () => {
        const conversationSessionId = 'conv-interrupt-persisted-identity';
        const persisted = {
            ...assistantMessage('server-assistant-1', ASSISTANT_TEXT, 300),
            realID: 'server-assistant-1',
            localId: 'voice-realtime:attempt-1:assistant:assistant-1',
        };
        const state = {
            sessionMessages: {
                [conversationSessionId]: {
                    messages: [persisted],
                },
            },
        };

        markVoiceConversationAssistantTurnInterrupted({
            conversationSessionId,
            assistantEntryId: persisted.localId,
            getState: () => state,
        });

        expect(isVoiceTurnInterrupted(persisted.localId)).toBe(false);
        expect(isVoiceTurnInterrupted(persisted.realID)).toBe(true);
        expect(selectVoiceTranscriptEntriesForConversationSession(
            state,
            conversationSessionId,
        )).toEqual([
            expect.objectContaining({
                id: persisted.realID,
                interrupted: true,
            }),
        ]);
    });

    it('does not misattribute interruption to N-1 when the current output has no authoritative final', () => {
        const conversationSessionId = 'conv-interrupt-no-final';
        const state = {
            sessionMessages: {
                [conversationSessionId]: {
                    messages: [assistantMessage('a1', 'previous response', 200)],
                },
            },
        };
        const versionBefore = voiceTurnInterruptionVersion();

        markVoiceConversationAssistantTurnInterrupted({
            conversationSessionId,
            assistantEntryId: null,
            getState: () => state,
        });

        expect(isVoiceTurnInterrupted('a1')).toBe(false);
        expect(voiceTurnInterruptionVersion()).toBe(versionBefore);
    });

    it('no-ops when the exact identity is absent from the conversation or belongs to a user turn', () => {
        const conversationSessionId = 'conv-interrupt-missing-identity';
        const state = stateWithAssistantTurns(conversationSessionId);
        const versionBefore = voiceTurnInterruptionVersion();

        markVoiceConversationAssistantTurnInterrupted({
            conversationSessionId,
            assistantEntryId: 'missing',
            getState: () => state,
        });
        markVoiceConversationAssistantTurnInterrupted({
            conversationSessionId,
            assistantEntryId: 'u1',
            getState: () => state,
        });

        expect(voiceTurnInterruptionVersion()).toBe(versionBefore);
    });
});
