import { describe, expect, it } from 'vitest';

import { persistSessionTranscriptMessage, readStoredSessionMessages, type PersistedSessionTranscriptMessage } from "@happier-dev/session-core/messages";
import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { createVoiceTranscriptProjector } from './VoiceTranscriptProjector';
import { createVoiceContinuationProjection } from './voiceContinuationProjection';
import { selectVoiceTranscriptEntriesForConversationSession } from './voiceTranscriptSelectors';
import type { VoiceSessionBinding } from '@/voice/binding/voiceConversationBindingTypes';
import type { VoiceSessionSnapshot } from '@/voice/session/types';

describe('VoiceTranscriptProjector', () => {
    it('delivers one acknowledged visible continuation through the real writer and two independent transcript consumers', async () => {
        const conversation = { serverId: 'home-a', sessionId: 'conversation' };
        const binding: VoiceSessionBinding = { adapterId: 'service', controlSessionId: 'control',
            conversationSessionId: conversation.sessionId, conversationSessionAddress: conversation,
            targetSessionAddress: null, transcriptMode: 'synthetic', updatedAt: 1 };
        const snapshot: VoiceSessionSnapshot = { adapterId: 'service', sessionId: 'control', status: 'connecting', mode: 'idle', canStop: true };
        const older = createVoiceContinuationProjection();
        const newer = createVoiceContinuationProjection();
        older.update({ snapshot, binding, deviceId: 'older-device', sessionSeq: 10 });
        newer.update({ snapshot, binding, deviceId: 'newer-device', sessionSeq: 10 });
        const provenance = newer.update({ snapshot: { ...snapshot, status: 'connected' }, binding,
            deviceId: 'newer-device', sessionSeq: 10 });
        expect(provenance).not.toBeNull();
        if (!provenance) throw new Error('Expected a connected continuation');
        let persisted: Promise<PersistedSessionTranscriptMessage> | undefined;
        const requests: unknown[] = [];
        const projector = createVoiceTranscriptProjector({ getState: () => ({}), nowMs: () => 100,
            persistFinal: (input) => {
                persisted = persistSessionTranscriptMessage({ sessionEncryptionMode: 'plain',
                    // Network acknowledgement is the only substituted boundary; schemas, normalization and reducers are real.
                    request: async (_path, init) => {
                        requests.push(JSON.parse(String(init?.body)));
                        return new Response(JSON.stringify({ didWrite: true, message: {
                            id: 'acknowledged-note', localId: input.localId, seq: 11, createdAt: 100,
                        } }), { status: 200 });
                    } }, input);
                return persisted;
            } });
        projector.projectNoteText({ conversationSessionId: conversation.sessionId, text: 'Continued here', continuation: provenance });
        expect(persisted).toBeDefined();
        const acknowledgement = await persisted;
        if (!acknowledgement) throw new Error('Expected transcript acknowledgement');
        expect(requests).toEqual([expect.objectContaining({ messageRole: 'agent', content: {
            t: 'plain', v: expect.objectContaining({ meta: expect.objectContaining({ happier: expect.objectContaining({ kind: 'voice_note.v1' }) }) }),
        } })]);

        for (const [projection, expectedEnd] of [[older, 'control'], [newer, null]] as const) {
            const consumer = createReducer();
            const received = reducer(consumer, [acknowledgement.message]).messages;
            expect(selectVoiceTranscriptEntriesForConversationSession({ sessionMessages: {
                [conversation.sessionId]: { messages: received },
            } }, conversation.sessionId)).toEqual([expect.objectContaining({ kind: 'note' })]);
            expect(projection.observe(conversation, received)).toEqual(expectedEnd ? { controlSessionId: expectedEnd, continuation: provenance } : null);
            expect(projection.observe(conversation, received)).toBeNull();
            expect(reducer(consumer, [acknowledgement.message]).messages).toEqual([]);
        }
        const hydrated = createVoiceContinuationProjection();
        hydrated.update({ snapshot, binding, deviceId: 'third-device', sessionSeq: 11 });
        expect(hydrated.observe(conversation, reducer(createReducer(), [acknowledgement.message]).messages)).toBeNull();
    });
    it('persists a continuation as an ordinary note, without exposing an unacknowledged control note', async () => {
        const persisted: import('@happier-dev/session-core/messages').PersistSessionTranscriptMessageInput[] = [];
        const applied: unknown[] = [];
        const projector = createVoiceTranscriptProjector({ getState: () => ({ applyMessages: (_id, messages) => { applied.push(...messages); } }),
            nowMs: () => 100, persistFinal: (input) => { persisted.push(input); } });
        const input = { conversationSessionId: 'conversation', text: 'Continued on this device',
            continuation: { v: 1 as const, deviceId: 'device', conversation: { serverId: 'home', sessionId: 'conversation' } } };
        const note = projector.projectNoteText(input);
        expect(note?.meta).toMatchObject({ happier: { kind: 'voice_note.v1', payload: { v: 1, continuation: input.continuation } } });
        expect(persisted).toHaveLength(1);
        expect(persisted[0]).toMatchObject({ sessionId: 'conversation', messageRole: 'agent', rawRecord: {
            role: 'agent', meta: note?.meta, content: { type: 'output', data: { type: 'assistant',
                message: { content: [{ type: 'text', text: 'Voice continued.' }] },
            } },
        } });
        expect(applied).toHaveLength(0);
    });
    it('keeps the exact realtime provider source on the canonical turn origin', async () => {
        const { buildRealtimeConversationTurnMeta } = await import('./VoiceTranscriptProjector');

        expect(buildRealtimeConversationTurnMeta({
            pluginId: 'happier.agent.codex',
            contributionId: 'realtime-codex',
        })).toEqual({
            happier: {
                kind: 'conversation_turn.v1',
                payload: { v: 1 },
                conversationTurnOriginV1: {
                    v: 1,
                    channel: 'realtime_conversation',
                    modality: 'voice',
                    source: {
                        pluginId: 'happier.agent.codex',
                        contributionId: 'realtime-codex',
                    },
                },
            },
        });
    });

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

        const stored = readStoredSessionMessages({ sessionMessages: sessionMessagesState }, 'carrier-s1');
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

        const stored = readStoredSessionMessages({ sessionMessages: sessionMessagesState }, 'carrier-s1');
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

        const stored = readStoredSessionMessages({ sessionMessages: sessionMessagesState }, 'carrier-s1');
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

        const stored = readStoredSessionMessages({ sessionMessages: sessionMessagesState }, 'carrier-s1');
        expect(stored).toHaveLength(2);
        expect(first?.id).not.toBe(second?.id);
    });

    it('assigns monotonic timestamps to local projections created in the same millisecond', async () => {
        const { createVoiceTranscriptProjector } = await import('./VoiceTranscriptProjector');
        const projector = createVoiceTranscriptProjector({
            getState: () => ({
                applyMessagesLoaded: () => undefined,
                applyMessages: () => undefined,
            }),
            nowMs: () => 100,
        });

        const first = projector.projectNoteText({ conversationSessionId: 'carrier-s1', text: 'first' });
        const second = projector.projectNoteText({ conversationSessionId: 'carrier-s1', text: 'second' });

        expect(first?.createdAt).toBe(100);
        expect(second?.createdAt).toBe(101);
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
