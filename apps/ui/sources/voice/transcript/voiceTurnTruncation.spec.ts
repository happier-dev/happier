import { beforeEach, describe, expect, it } from 'vitest';

import { TTS_ESTIMATED_MS_PER_CHAR } from '@/voice/output/ttsPlaybackTiming';
import { selectVoiceTranscriptEntriesForConversationSession } from './voiceTranscriptSelectors';
import {
    __resetVoiceTurnTruncations,
    readVoiceTurnTruncatedText,
    truncateVoiceConversationAssistantTurnToPlayedBoundary,
    voiceTurnTruncationVersion,
} from './voiceTurnTruncation';

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

// 'one two three four' = 18 chars. At the average rate the full spoken duration
// is 18 * MS_PER_CHAR; playing half of that lands the cut at 9 chars ('one two
// t') which snaps back to the 'one two' word boundary.
const ASSISTANT_TEXT = 'one two three four';
const FULL_DURATION_MS = ASSISTANT_TEXT.length * TTS_ESTIMATED_MS_PER_CHAR;

function stateWithLatestAssistantTurn(conversationSessionId: string) {
    return {
        sessionMessages: {
            [conversationSessionId]: {
                messages: [
                    userMessage('u1', 'tell me a story', 100),
                    assistantMessage('a1', ASSISTANT_TEXT, 200),
                ],
            },
        },
    };
}

describe('truncateVoiceConversationAssistantTurnToPlayedBoundary', () => {
    beforeEach(() => {
        __resetVoiceTurnTruncations();
    });

    it('records a played-boundary override for the latest assistant turn and the selector surfaces it', () => {
        const conversationSessionId = 'conv-truncate-1';
        const state = stateWithLatestAssistantTurn(conversationSessionId);
        const versionBefore = voiceTurnTruncationVersion();

        truncateVoiceConversationAssistantTurnToPlayedBoundary({
            conversationSessionId,
            playedMs: FULL_DURATION_MS / 2,
            getState: () => state,
        });

        expect(readVoiceTurnTruncatedText('a1')).toBe('one two');
        expect(voiceTurnTruncationVersion()).toBeGreaterThan(versionBefore);

        const entries = selectVoiceTranscriptEntriesForConversationSession(state, conversationSessionId);
        const assistantEntry = entries.find((entry) => entry.id === 'a1');
        expect(assistantEntry?.text).toBe('one two');
        // The user turn is untouched.
        expect(entries.find((entry) => entry.id === 'u1')?.text).toBe('tell me a story');
    });

    it('does not truncate a fully-played (cleanly completed) turn', () => {
        const conversationSessionId = 'conv-truncate-2';
        const state = stateWithLatestAssistantTurn(conversationSessionId);

        truncateVoiceConversationAssistantTurnToPlayedBoundary({
            conversationSessionId,
            playedMs: FULL_DURATION_MS, // heard all of it
            getState: () => state,
        });

        expect(readVoiceTurnTruncatedText('a1')).toBeNull();
        const entries = selectVoiceTranscriptEntriesForConversationSession(state, conversationSessionId);
        expect(entries.find((entry) => entry.id === 'a1')?.text).toBe(ASSISTANT_TEXT);
    });

    it('treats an unknown played position (MAX_SAFE_INTEGER) as fully played', () => {
        const conversationSessionId = 'conv-truncate-3';
        const state = stateWithLatestAssistantTurn(conversationSessionId);

        truncateVoiceConversationAssistantTurnToPlayedBoundary({
            conversationSessionId,
            playedMs: Number.MAX_SAFE_INTEGER,
            getState: () => state,
        });

        expect(readVoiceTurnTruncatedText('a1')).toBeNull();
    });

    it('drops the heard text entirely when nothing was played (empty override)', () => {
        const conversationSessionId = 'conv-truncate-4';
        const state = stateWithLatestAssistantTurn(conversationSessionId);

        truncateVoiceConversationAssistantTurnToPlayedBoundary({
            conversationSessionId,
            playedMs: 0,
            getState: () => state,
        });

        expect(readVoiceTurnTruncatedText('a1')).toBe('');
        const entries = selectVoiceTranscriptEntriesForConversationSession(state, conversationSessionId);
        // An empty override hides the assistant turn; the user turn remains.
        expect(entries.map((entry) => entry.id)).toEqual(['u1']);
    });

    it('no-ops on an unknown conversation or empty store', () => {
        const versionBefore = voiceTurnTruncationVersion();
        truncateVoiceConversationAssistantTurnToPlayedBoundary({
            conversationSessionId: 'missing',
            playedMs: 100,
            getState: () => ({ sessionMessages: {} }),
        });
        expect(voiceTurnTruncationVersion()).toBe(versionBefore);
    });
});
