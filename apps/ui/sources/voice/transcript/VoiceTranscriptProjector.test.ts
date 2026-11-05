import { beforeEach, describe, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { buildVoiceTranscriptNoteMeta } from './voiceTranscriptNoteMeta';
import { readConversationTurnOriginV1FromMessageMeta } from '@happier-dev/protocol/messages/structured/conversationTurnOriginV1';
import { resolveTranscriptMessageDisplayText } from '@/components/sessions/transcript/messageDisplayText';

import { persistSessionTranscriptMessage, readStoredSessionMessages, type PersistedSessionTranscriptMessage } from "@happier-dev/session-core/messages";
import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { createVoiceTranscriptProjector } from './VoiceTranscriptProjector';
import { createVoiceContinuationProjection } from './voiceContinuationProjection';
import { selectVoiceTranscriptEntriesForConversationSession } from './voiceTranscriptSelectors';
import type { VoiceSessionBinding } from '@/voice/binding/voiceConversationBindingTypes';
import type { VoiceSessionSnapshot } from '@/voice/session/types';

beforeEach(() => {
    storage.setState({ sessions: Object.fromEntries(['carrier-s1', 'conversation'].map(id => [id, createSessionFixture({ id })])), sessionMessages: {} });
});

function seedOrderedTranscript() {
    const normalized = [
        normalizeRawMessage('m-user', 'm-user', 100, { role: 'user', content: { type: 'text', text: 'hello' } }),
        ...[
            ['m-note', 'Tool result: sendSessionMessage succeeded', 150, buildVoiceTranscriptNoteMeta()],
            ['m-assistant', 'Done.', 200, undefined],
        ].map(([id, text, createdAt, meta]) => normalizeRawMessage(String(id), String(id), Number(createdAt), {
            role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: String(id),
                message: { role: 'assistant', content: [{ type: 'text', text: String(text) }] } } },
            ...(meta ? { meta } : {}),
        })),
    ];
    const messages = normalized.filter(message => message !== null);
    if (messages.length !== 3) throw new Error('Invalid canonical transcript wire fixtures');
    storage.getState().applyMessagesLoaded('carrier-s1');
    storage.getState().applyMessages('carrier-s1', messages);
}

describe('VoiceTranscriptProjector', () => {
    it.each(['user', 'assistant'] as const)('retains Voice origin and provider casing for a synthetic %s STT conversation turn', role => {
        const projector = createVoiceTranscriptProjector({ getState: storage.getState, nowMs: () => 100 });
        const input = { conversationSessionId: 'carrier-s1', text: 'HULLO PLEASE keep API and iOS' };
        const projected = role === 'user' ? projector.projectUserText(input) : projector.projectAssistantText(input);
        expect(projected).not.toBeNull();
        if (!projected) throw new Error('Voice turn must project');
        expect(readConversationTurnOriginV1FromMessageMeta(projected.meta)).toMatchObject({
            channel: 'realtime_conversation', modality: 'voice',
        });
        const received = reducer(createReducer(), [projected]).messages;
        expect(received).toHaveLength(1);
        const message = received[0]!;
        if (message.kind !== 'user-text' && message.kind !== 'agent-text') throw new Error('Voice turn must remain text');
        expect(resolveTranscriptMessageDisplayText(message)).toMatchObject({ text: input.text, isVoiceAgentTurn: true });
    });

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
            deviceId: 'newer-device', sessionSeq: 10 })?.continuation;
        expect(provenance).not.toBeNull();
        if (!provenance) throw new Error('Expected a connected continuation');
        let persisted: Promise<PersistedSessionTranscriptMessage> | undefined;
        const requests: unknown[] = [];
        const projector = createVoiceTranscriptProjector({ getState: storage.getState, nowMs: () => 100,
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
        const acknowledgement = createDeferred<Response>();
        const requests: unknown[] = [];
        let persisted: Promise<PersistedSessionTranscriptMessage> | undefined;
        const projector = createVoiceTranscriptProjector({ getState: storage.getState,
            nowMs: () => 100, persistFinal: input => {
                persisted = persistSessionTranscriptMessage({ sessionEncryptionMode: 'plain', request: async (_path, init) => {
                    requests.push(JSON.parse(String(init?.body)));
                    return acknowledgement.promise;
                } }, input).then(result => {
                    storage.getState().applyMessages(input.sessionId, [result.message]);
                    return result;
                });
                return persisted;
            } });
        const input = { conversationSessionId: 'conversation', text: 'Continued on this device', localId: 'voice-note:retryable', createdAt: 100,
            continuation: { v: 1 as const, deviceId: 'device', conversation: { serverId: 'home', sessionId: 'conversation' } } };
        const settlement = projector.projectNoteText(input);
        expect(settlement).toBeInstanceOf(Promise);
        let settled = false;
        void Promise.resolve(settlement).then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        const meta = buildVoiceTranscriptNoteMeta({ continuation: input.continuation });
        expect(requests).toEqual([expect.objectContaining({ messageRole: 'agent', content: { t: 'plain', v: {
            role: 'agent', meta, content: { type: 'output', data: { type: 'assistant',
                uuid: expect.any(String), message: { role: 'assistant', content: [{ type: 'text', text: 'Voice continued.' }] },
            } },
        } } })]);
        expect(readStoredSessionMessages(storage.getState(), 'conversation')).toEqual([]);
        acknowledgement.resolve(Response.json({ didWrite: true, message: { id: 'ack-note', localId: input.localId, seq: 1, createdAt: 100 } }));
        const note = await settlement;
        await persisted;
        expect(selectVoiceTranscriptEntriesForConversationSession(storage.getState(), 'conversation')).toEqual([
            expect.objectContaining({ id: note?.localId, kind: 'note' }),
        ]);
        expect(readStoredSessionMessages(storage.getState(), 'conversation')).toEqual([
            expect.objectContaining({ realID: 'ack-note', localId: note?.localId, text: 'Voice continued.', meta: note?.meta }),
        ]);
    });
    it('keeps the exact realtime provider source on the canonical turn origin', async () => {
        const { buildRealtimeConversationTurnMeta } = await import('./VoiceTranscriptProjector');

        const produced = buildRealtimeConversationTurnMeta({
            pluginId: 'happier.agent.codex',
            contributionId: 'realtime-codex',
        });
        expect(readConversationTurnOriginV1FromMessageMeta(JSON.parse(JSON.stringify(produced)), 'input'))
            .toEqual({ v: 1, channel: 'realtime_conversation', modality: 'voice',
                source: { pluginId: 'happier.agent.codex', contributionId: 'realtime-codex' } });
        expect(produced).toEqual({
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

        const projector = createVoiceTranscriptProjector({ getState: storage.getState, nowMs: () => 100 });

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

        const projector = createVoiceTranscriptProjector({ getState: storage.getState, nowMs: () => 100 });

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

        const stored = readStoredSessionMessages(storage.getState(), 'carrier-s1');
        expect(stored).toHaveLength(1);
    });

    it('appends repeated identical user utterances when no stable turn metadata exists', async () => {
        const { createVoiceTranscriptProjector } = await import('./VoiceTranscriptProjector');

        const projector = createVoiceTranscriptProjector({ getState: storage.getState, nowMs: () => 100 });

        const first = projector.projectUserText({
            conversationSessionId: 'carrier-s1',
            text: 'repeat me',
        });
        const second = projector.projectUserText({
            conversationSessionId: 'carrier-s1',
            text: 'repeat me',
        });

        const stored = readStoredSessionMessages(storage.getState(), 'carrier-s1');
        expect(stored).toHaveLength(2);
        expect(first?.id).not.toBe(second?.id);
    });

    it.each(['user', 'assistant'] as const)('reconciles a no-turn optimistic %s projection into a later canonical turn without duplicating the row', async (role) => {
        const { createVoiceTranscriptProjector } = await import('./VoiceTranscriptProjector');

        const projector = createVoiceTranscriptProjector({ getState: storage.getState, nowMs: () => 100 });

        const projectText = role === 'user' ? projector.projectUserText : projector.projectAssistantText;
        const optimistic = projectText({
            conversationSessionId: 'carrier-s1',
            text: 'open the session',
        });
        projectText({
            conversationSessionId: 'carrier-s1',
            text: 'open the session',
            turn: {
                epoch: 7,
                role,
                ts: 123,
                voiceAgentId: 'voice-agent-1',
                runId: 'run_1',
                streamId: 'stream_1',
            },
        });

        const stored = readStoredSessionMessages(storage.getState(), 'carrier-s1');
        expect(optimistic?.id).toBe(`voice-turn-provisional:carrier-s1:${role}:1`);
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({
            realID: `voice-turn:voice-agent-1:run_1:stream_1:7:${role}:123`,
            meta: {
                happier: {
                    kind: 'voice_agent_turn.v1',
                    payload: {
                        v: 1,
                        epoch: 7,
                        role,
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

        const projector = createVoiceTranscriptProjector({ getState: storage.getState, nowMs: () => 100 });

        const first = projector.projectNoteText({
            conversationSessionId: 'carrier-s1',
            text: 'Tool result: sendSessionMessage succeeded',
        });
        const second = projector.projectNoteText({
            conversationSessionId: 'carrier-s1',
            text: 'Tool result: sendSessionMessage succeeded',
        });

        const stored = readStoredSessionMessages(storage.getState(), 'carrier-s1');
        expect(stored).toHaveLength(2);
        expect(first?.id).not.toBe(second?.id);
    });

    it('assigns monotonic timestamps to local projections created in the same millisecond', async () => {
        const { createVoiceTranscriptProjector } = await import('./VoiceTranscriptProjector');
        const projector = createVoiceTranscriptProjector({
            getState: storage.getState,
            nowMs: () => 100,
        });

        const first = projector.projectNoteText({ conversationSessionId: 'carrier-s1', text: 'first' });
        const second = projector.projectNoteText({ conversationSessionId: 'carrier-s1', text: 'second' });

        expect(first?.createdAt).toBe(100);
        expect(second?.createdAt).toBe(101);
    });

    it('selects transcript entries from projected session messages in created order', async () => {
        const { selectVoiceTranscriptEntriesForConversationSession } = await import('./voiceTranscriptSelectors');

        seedOrderedTranscript();
        const entries = selectVoiceTranscriptEntriesForConversationSession(storage.getState(), 'carrier-s1');

    expect(entries).toEqual([
        { createdAt: 100, id: 'm-user', kind: 'user', text: 'hello' },
        { createdAt: 150, id: 'm-note', kind: 'note', text: 'Tool result: sendSessionMessage succeeded' },
        { createdAt: 200, id: 'm-assistant', kind: 'assistant', text: 'Done.' },
    ]);
    });

    it('prefers stable real ids when selecting transcript entries from reducer-backed stored message records', async () => {
        const { selectVoiceTranscriptEntriesForConversationSession } = await import('./voiceTranscriptSelectors');

        seedOrderedTranscript();
        const entries = selectVoiceTranscriptEntriesForConversationSession(storage.getState(), 'carrier-s1');

        expect(entries).toEqual([
            { createdAt: 100, id: 'm-user', kind: 'user', text: 'hello' },
            { createdAt: 150, id: 'm-note', kind: 'note', text: 'Tool result: sendSessionMessage succeeded' },
            { createdAt: 200, id: 'm-assistant', kind: 'assistant', text: 'Done.' },
        ]);
    });

});
