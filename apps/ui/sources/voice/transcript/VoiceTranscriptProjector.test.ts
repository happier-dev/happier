import { describe, expect, it } from 'vitest';

import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';

describe('VoiceTranscriptProjector', () => {
    it('uses deterministic ids when stable turn metadata is provided', async () => {
        const { createVoiceTranscriptProjector } = await import('./VoiceTranscriptProjector');

        const applyMessagesLoaded = (_sessionId: string) => {};
        const state = {
            applyMessagesLoaded,
            applyMessages: (_sessionId: string, _messages: unknown[]) => {},
        };
        const projector = createVoiceTranscriptProjector({
            getState: () => state,
            nowMs: () => 100,
        });

        const first = projector.projectUserText({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            turn: {
                epoch: 7,
                role: 'user',
                ts: 123,
                voiceAgentId: 'va_1',
            },
        });
        const second = projector.projectUserText({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            turn: {
                epoch: 7,
                role: 'user',
                ts: 123,
                voiceAgentId: 'va_1',
            },
        });

        expect(first?.id).toBe(second?.id);
        expect(first?.meta).toEqual({
            happier: {
                kind: 'voice_agent_turn.v1',
                payload: {
                    v: 1,
                    epoch: 7,
                    role: 'user',
                    ts: 123,
                    voiceAgentId: 'va_1',
                },
            },
        });
    });

    it('upserts an existing deterministic optimistic turn instead of appending a duplicate', async () => {
        const { createVoiceTranscriptProjector } = await import('./VoiceTranscriptProjector');

        let sessionMessagesState: Record<string, { messages: unknown[] }> = {
            'carrier-s1': {
                messages: [],
            },
        };
        const applyMessages = (sessionId: string, messages: unknown[]) => {
            sessionMessagesState = {
                ...sessionMessagesState,
                [sessionId]: {
                    messages: [
                        ...(sessionMessagesState[sessionId]?.messages ?? []),
                        ...messages,
                    ],
                },
            };
        };
        const projector = createVoiceTranscriptProjector({
            getState: () => ({
                sessionMessages: sessionMessagesState,
                applyMessagesLoaded: (_sessionId: string) => {},
                applyMessages,
            }),
            nowMs: () => 100,
        });

        projector.projectAssistantText({
            conversationSessionId: 'carrier-s1',
            text: 'First answer',
            turn: {
                epoch: 4,
                role: 'assistant',
                ts: 200,
                voiceAgentId: 'va_2',
            },
        });
        projector.projectAssistantText({
            conversationSessionId: 'carrier-s1',
            text: 'First answer',
            turn: {
                epoch: 4,
                role: 'assistant',
                ts: 200,
                voiceAgentId: 'va_2',
            },
        });

        const stored = readStoredSessionMessages({ sessionMessages: sessionMessagesState as any }, 'carrier-s1');
        expect(stored).toHaveLength(1);
    });

    it('appends repeated identical user utterances when no stable turn metadata exists', async () => {
        const { createVoiceTranscriptProjector } = await import('./VoiceTranscriptProjector');

        let sessionMessagesState: Record<string, { messages: unknown[] }> = {
            'carrier-s1': {
                messages: [],
            },
        };
        const applyMessages = (sessionId: string, messages: unknown[]) => {
            sessionMessagesState = {
                ...sessionMessagesState,
                [sessionId]: {
                    messages: [
                        ...(sessionMessagesState[sessionId]?.messages ?? []),
                        ...messages,
                    ],
                },
            };
        };
        const projector = createVoiceTranscriptProjector({
            getState: () => ({
                sessionMessages: sessionMessagesState,
                applyMessagesLoaded: (_sessionId: string) => {},
                applyMessages,
            }),
            nowMs: () => 100,
        });

        const first = projector.projectUserText({
            conversationSessionId: 'carrier-s1',
            text: 'repeat me',
        });
        const second = projector.projectUserText({
            conversationSessionId: 'carrier-s1',
            text: 'repeat me',
        });

        const stored = readStoredSessionMessages({ sessionMessages: sessionMessagesState as any }, 'carrier-s1');
        expect(stored).toHaveLength(2);
        expect(first?.id).not.toBe(second?.id);
    });

    it('reconciles a no-turn optimistic user projection into a later canonical turn without duplicating the row', async () => {
        const { createVoiceTranscriptProjector } = await import('./VoiceTranscriptProjector');

        let sessionMessagesState: Record<string, { messages: unknown[] }> = {
            'carrier-s1': {
                messages: [],
            },
        };
        const applyMessages = (sessionId: string, messages: unknown[]) => {
            sessionMessagesState = {
                ...sessionMessagesState,
                [sessionId]: {
                    messages: [
                        ...(sessionMessagesState[sessionId]?.messages ?? []),
                        ...messages,
                    ],
                },
            };
        };
        const projector = createVoiceTranscriptProjector({
            getState: () => ({
                sessionMessages: sessionMessagesState,
                applyMessagesLoaded: (_sessionId: string) => {},
                applyMessages,
            }),
            nowMs: () => 100,
        });

        const optimistic = projector.projectUserText({
            conversationSessionId: 'carrier-s1',
            text: 'open the session',
        });
        projector.projectUserText({
            conversationSessionId: 'carrier-s1',
            text: 'open the session',
            turn: {
                epoch: 7,
                role: 'user',
                ts: 123,
                voiceAgentId: 'voice-agent-1',
                runId: 'run_1',
                streamId: 'stream_1',
            },
        });

        const stored = readStoredSessionMessages({ sessionMessages: sessionMessagesState as any }, 'carrier-s1');
        expect(optimistic?.id).toBe('voice-turn-provisional:carrier-s1:user:1');
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({
            realID: 'voice-turn:voice-agent-1:run_1:stream_1:7:user:123',
            meta: {
                happier: {
                    kind: 'voice_agent_turn.v1',
                    payload: {
                        v: 1,
                        epoch: 7,
                        role: 'user',
                        ts: 123,
                        voiceAgentId: 'voice-agent-1',
                        runId: 'run_1',
                        streamId: 'stream_1',
                    },
                },
            },
        });
    });

    it('appends repeated identical note entries when no stable turn metadata exists', async () => {
        const { createVoiceTranscriptProjector } = await import('./VoiceTranscriptProjector');

        let sessionMessagesState: Record<string, { messages: unknown[] }> = {
            'carrier-s1': {
                messages: [],
            },
        };
        const applyMessages = (sessionId: string, messages: unknown[]) => {
            sessionMessagesState = {
                ...sessionMessagesState,
                [sessionId]: {
                    messages: [
                        ...(sessionMessagesState[sessionId]?.messages ?? []),
                        ...messages,
                    ],
                },
            };
        };
        const projector = createVoiceTranscriptProjector({
            getState: () => ({
                sessionMessages: sessionMessagesState,
                applyMessagesLoaded: (_sessionId: string) => {},
                applyMessages,
            }),
            nowMs: () => 100,
        });

        const first = projector.projectNoteText({
            conversationSessionId: 'carrier-s1',
            text: 'Tool result: sendSessionMessage succeeded',
        });
        const second = projector.projectNoteText({
            conversationSessionId: 'carrier-s1',
            text: 'Tool result: sendSessionMessage succeeded',
        });

        const stored = readStoredSessionMessages({ sessionMessages: sessionMessagesState as any }, 'carrier-s1');
        expect(stored).toHaveLength(2);
        expect(first?.id).not.toBe(second?.id);
    });

    it('bounds the in-memory unreconciled projection ring and retires reconciled ephemerals', async () => {
        const { createVoiceTranscriptProjector } = await import('./VoiceTranscriptProjector');
        const { VOICE_TRANSCRIPT_UNRECONCILED_EVENT_RING_MAX } = await import('./voiceTranscriptBounds');

        let sessionMessagesState: Record<string, { messages: unknown[] }> = { 'carrier-s1': { messages: [] } };
        const applyMessages = (sessionId: string, messages: unknown[]) => {
            sessionMessagesState = {
                ...sessionMessagesState,
                [sessionId]: { messages: [...(sessionMessagesState[sessionId]?.messages ?? []), ...messages] },
            };
        };
        const projector = createVoiceTranscriptProjector({
            getState: () => ({
                sessionMessages: sessionMessagesState,
                applyMessagesLoaded: (_sessionId: string) => {},
                applyMessages,
            }),
            nowMs: () => 100,
        });

        // Push more distinct no-turn (unreconciled) projections than the ring cap.
        const overflow = VOICE_TRANSCRIPT_UNRECONCILED_EVENT_RING_MAX + 25;
        for (let index = 0; index < overflow; index += 1) {
            projector.projectUserText({ conversationSessionId: 'carrier-s1', text: `pending-${index}` });
        }
        expect(projector.unreconciledProjectionCount()).toBe(VOICE_TRANSCRIPT_UNRECONCILED_EVENT_RING_MAX);

        // Reconciling an ephemeral into its canonical turn retires it from the ring.
        const before = projector.unreconciledProjectionCount();
        projector.projectUserText({
            conversationSessionId: 'carrier-s1',
            text: `pending-${overflow - 1}`,
            turn: { epoch: 1, role: 'user', ts: 1, voiceAgentId: 'va_1' },
        });
        expect(projector.unreconciledProjectionCount()).toBe(before - 1);
    });

    it('truncates assistant text to the played boundary, snapping back to a word boundary', async () => {
        const { createVoiceTranscriptProjector } = await import('./VoiceTranscriptProjector');
        const projector = createVoiceTranscriptProjector({
            getState: () => ({ applyMessages: () => {}, applyMessagesLoaded: () => {} }),
            nowMs: () => 100,
        });

        // Heard half of a 2000ms utterance -> keep the leading words, drop the tail.
        expect(
            projector.truncateToPlayedBoundary({ fullText: 'one two three four', playedMs: 1000, spokenDurationMs: 2000 }),
        ).toBe('one two');
        // Fully played -> full text.
        expect(
            projector.truncateToPlayedBoundary({ fullText: 'one two three four', playedMs: 2000, spokenDurationMs: 2000 }),
        ).toBe('one two three four');
        // Nothing played -> empty.
        expect(
            projector.truncateToPlayedBoundary({ fullText: 'one two three four', playedMs: 0, spokenDurationMs: 2000 }),
        ).toBe('');
    });

    it('selects transcript entries from projected session messages in created order', async () => {
        const { selectVoiceTranscriptEntriesForConversationSession } = await import('./voiceTranscriptSelectors');

        const entries = selectVoiceTranscriptEntriesForConversationSession(
            {
                sessionMessages: {
                    'carrier-s1': {
                        messages: [
                            {
                                id: 'm-user',
                                localId: 'm-user',
                                createdAt: 100,
                                isSidechain: false,
                                role: 'user',
                                content: { type: 'text', text: 'hello' },
                            },
                            {
                                id: 'm-note',
                                localId: 'm-note',
                                createdAt: 150,
                                isSidechain: false,
                                role: 'agent',
                                meta: {
                                    happier: {
                                        kind: 'voice_note.v1',
                                        payload: { v: 1 },
                                    },
                                },
                                content: [{ type: 'text', text: 'Tool result: sendSessionMessage succeeded', uuid: 'u1', parentUUID: null }],
                            },
                            {
                                id: 'm-assistant',
                                localId: 'm-assistant',
                                createdAt: 200,
                                isSidechain: false,
                                role: 'agent',
                                content: [{ type: 'text', text: 'Done.', uuid: 'u2', parentUUID: null }],
                            },
                        ],
                    },
                },
            },
            'carrier-s1',
        );

    expect(entries).toEqual([
        { createdAt: 100, id: 'm-user', kind: 'user', text: 'hello' },
        { createdAt: 150, id: 'm-note', kind: 'note', text: 'Tool result: sendSessionMessage succeeded' },
        { createdAt: 200, id: 'm-assistant', kind: 'assistant', text: 'Done.' },
    ]);
    });

    it('prefers stable real ids when selecting transcript entries from reducer-backed stored message records', async () => {
        const { selectVoiceTranscriptEntriesForConversationSession } = await import('./voiceTranscriptSelectors');

        const entries = selectVoiceTranscriptEntriesForConversationSession(
            {
                sessionMessages: {
                    'carrier-s1': {
                        messageIdsOldestFirst: ['internal-user', 'internal-note', 'internal-assistant'],
                        messagesById: {
                            'internal-user': {
                                kind: 'user-text',
                                id: 'internal-user',
                                realID: 'm-user',
                                localId: 'm-user',
                                createdAt: 100,
                                text: 'hello',
                            },
                            'internal-note': {
                                kind: 'agent-text',
                                id: 'internal-note',
                                realID: 'm-note',
                                localId: 'm-note',
                                createdAt: 150,
                                text: 'Tool result: sendSessionMessage succeeded',
                                meta: {
                                    happier: {
                                        kind: 'voice_note.v1',
                                        payload: { v: 1 },
                                    },
                                },
                            },
                            'internal-assistant': {
                                kind: 'agent-text',
                                id: 'internal-assistant',
                                realID: 'm-assistant',
                                localId: 'm-assistant',
                                createdAt: 200,
                                text: 'Done.',
                            },
                        },
                    },
                },
            },
            'carrier-s1',
        );

        expect(entries).toEqual([
            { createdAt: 100, id: 'm-user', kind: 'user', text: 'hello' },
            { createdAt: 150, id: 'm-note', kind: 'note', text: 'Tool result: sendSessionMessage succeeded' },
            { createdAt: 200, id: 'm-assistant', kind: 'assistant', text: 'Done.' },
        ]);
    });

});
