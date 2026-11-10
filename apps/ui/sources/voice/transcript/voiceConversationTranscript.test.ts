import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readStoredSessionMessages } from '@happier-dev/session-core/messages';
import { RawRecordSchema } from '@happier-dev/session-core/raw';
import { SessionMessageRoleSchema } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { UsageTimingBoundsV1Schema } from '@happier-dev/protocol/usage/usageTimingV1';
import { z } from 'zod/mini';
import { createSessionFixture, standardCleanup } from '@/dev/testkit';
import { createSessionMetadataHttpBoundary, type SessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { selectVoiceTranscriptEntriesForConversationSession } from './voiceTranscriptSelectors';
import {
    appendVoiceConversationNoteText, appendVoiceConversationUserText,
    beginCanonicalVoiceTranscriptAttempt, projectCanonicalVoiceTranscriptEvent,
    readCanonicalVoiceTranscriptSnapshot, releaseCanonicalVoiceTranscriptConversation,
    settleAdmittedCanonicalVoiceTranscriptPersistence,
    persistVoiceConversationSpokenAssistantText,
} from './voiceConversationTranscript';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

let account: Awaited<ReturnType<typeof import('@/voice/settings/panels/voiceSettingsAccountTestHarness').createVoiceSettingsAccountTestHarness>>;
const writes: Array<{ sessionId: string; localId: string; messageRole: string; rawRecord: ReturnType<typeof RawRecordSchema.parse> }> = [];
let failTranscriptWrites = false;
let sessionMetadata: SessionMetadataHttpBoundary;
const writeSchema = z.strictObject({ content: z.strictObject({ t: z.literal('plain'), v: RawRecordSchema }),
    localId: z.string().check(z.minLength(1)), messageRole: SessionMessageRoleSchema,
    usageTimingV1: z.optional(z.nullable(UsageTimingBoundsV1Schema)) });

beforeEach(async () => {
    const { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
    const { createVoiceSettingsAccountTestHarness } = await import('@/voice/settings/panels/voiceSettingsAccountTestHarness');
    account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
    writes.length = 0;
    failTranscriptWrites = false;
    sessionMetadata = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
    const fallback = account.request.getMockImplementation();
    if (!fallback) throw new Error('Expected Account HTTP boundary');
    account.request.mockImplementation(async (input, init) => {
        const metadataResponse = sessionMetadata.handle(input, init);
        if (metadataResponse) return metadataResponse;
        const match = /^\/v2\/sessions\/([^/]+)\/messages$/.exec(new URL(String(input)).pathname);
        if (!match) return fallback(input, init);
        if (init?.method !== 'POST') return Response.json({ messages: [], hasMore: false });
        const body = writeSchema.parse(JSON.parse(String(init.body)));
        if (failTranscriptWrites) return Response.json({ error: 'temporary_unavailable' }, { status: 503 });
        writes.push({ sessionId: decodeURIComponent(match[1]), localId: body.localId,
            messageRole: body.messageRole, rawRecord: body.content.v });
        // Only the Home acknowledgement is substituted; the real writer,
        // normalizer, reducer and stored-message projection consume it.
        return Response.json({ didWrite: true, message: {
            id: 'ack-' + writes.length, seq: writes.length, localId: body.localId, createdAt: 100 + writes.length,
        } });
    });
    storage.setState({ sessionMessages: {}, sessions: Object.fromEntries(
        ['carrier-s1', 'carrier-canonical', 'direct-agent-session'].map(id => [id, createSessionFixture({ id,
            serverId: account.scope.serverId })])) });
});
afterEach(async () => {
    await account?.dispose();
    await standardCleanup();
});
function entries(sessionId: string) {
    return selectVoiceTranscriptEntriesForConversationSession(storage.getState(), sessionId);
}

describe('voiceConversationTranscript', () => {
    it('rejects a failed host-spoken final write without claiming a saved or provisional row', async () => {
        failTranscriptWrites = true;
        await expect(persistVoiceConversationSpokenAssistantText({ conversationSessionId: 'carrier-s1',
            text: 'Should I allow it?' })).rejects.toThrow();
        expect(entries('carrier-s1')).toEqual([]);
        expect(writes).toEqual([]);
    });
    it('saves host-spoken finals in the ordinary acknowledged turn chronology and retains them after rehydration', async () => {
        const { normalizeRawMessage } = await import('@happier-dev/session-core/raw');
        const sessionId = 'carrier-canonical';
        const attempt = beginCanonicalVoiceTranscriptAttempt({ conversationSessionId: sessionId });
        if (!attempt) throw new Error('Expected transcript attempt');
        const final = (itemId: string, sequence: number, role: 'user' | 'assistant', text: string) =>
            projectCanonicalVoiceTranscriptEvent({ conversationSessionId: sessionId, event: {
                v: 1, type: 'voice.transcript.final', epoch: attempt.epoch, sequence, revision: 1,
                eventId: itemId, itemId, role, text, provenance: 'live',
            } });
        final('first-question', 1, 'user', 'MAKE THE FILE');
        await settleAdmittedCanonicalVoiceTranscriptPersistence({ conversationSessionId: sessionId, attemptIdentity: attempt.attemptIdentity });
        await vi.waitFor(() => expect(readSessionOwnerMetadataView(storage.getState().sessions[sessionId]!))
            .toMatchObject({ summary: { text: 'Make the file' } }));
        await persistVoiceConversationSpokenAssistantText({ conversationSessionId: sessionId, text: 'Should I allow it?' });
        final('second-question', 2, 'user', 'What is two plus three?');
        final('answer', 3, 'assistant', 'Five.');
        await settleAdmittedCanonicalVoiceTranscriptPersistence({ conversationSessionId: sessionId, attemptIdentity: attempt.attemptIdentity });
        const expected = ['MAKE THE FILE', 'Should I allow it?', 'What is two plus three?', 'Five.'];
        expect(entries(sessionId).map(entry => entry.text)).toEqual(expected);
        expect(writes).toHaveLength(4);
        expect(sessionMetadata.writes).toEqual([sessionId]);
        const loaded = writes.map((write, index) => {
            const normalized = normalizeRawMessage(`ack-${index + 1}`, write.localId, 101 + index, write.rawRecord);
            if (!normalized) throw new Error('Expected stored transcript');
            return { ...normalized, seq: index + 1 };
        });
        storage.setState({ sessionMessages: {} });
        storage.getState().applyMessagesLoaded(sessionId);
        storage.getState().applyMessages(sessionId, loaded);
        expect(entries(sessionId).map(entry => entry.text)).toEqual(expected);
        expect(readStoredSessionMessages(storage.getState(), sessionId).map(message => message.seq)).toEqual([1, 2, 3, 4]);
        await releaseCanonicalVoiceTranscriptConversation({ conversationSessionId: sessionId, attemptIdentity: attempt.attemptIdentity });
    });
    it('appends a user-text transcript message through the real store', () => {
        appendVoiceConversationUserText({ conversationSessionId: 'carrier-s1', text: 'hello from voice' });
        expect(entries('carrier-s1')).toEqual([expect.objectContaining({ kind: 'user', text: 'hello from voice' })]);
        // The reducer excludes sidechain rows from this ordinary transcript and
        // publishes a rendered Message without the raw isSidechain flag.
        expect(readStoredSessionMessages(storage.getState(), 'carrier-s1')).toEqual([
            expect.objectContaining({ kind: 'user-text', text: 'hello from voice' }),
        ]);
    });
    it('trims the conversation id without creating a second transcript', () => {
        appendVoiceConversationUserText({ conversationSessionId: '  carrier-s1  ', text: 'hello from voice' });
        expect(entries('carrier-s1')).toEqual([expect.objectContaining({ kind: 'user', text: 'hello from voice' })]);
        expect(storage.getState().sessionMessages).not.toHaveProperty('  carrier-s1  ');
    });
    it('saves assistant text and projects plain notes as distinct transcript kinds', async () => {
        await persistVoiceConversationSpokenAssistantText({ conversationSessionId: 'carrier-s1', text: 'I checked the workspace.' });
        appendVoiceConversationNoteText({ conversationSessionId: 'carrier-s1', text: 'Target session changed to s2' });
        expect(entries('carrier-s1')).toEqual([
            expect.objectContaining({ kind: 'assistant', text: 'I checked the workspace.' }),
            expect.objectContaining({ kind: 'note', text: 'Target session changed to s2' }),
        ]);
        expect(readStoredSessionMessages(storage.getState(), 'carrier-s1')[1]?.meta)
            .toEqual({ happier: { kind: 'voice_note.v1', payload: { v: 1 } } });
    });
    it('keeps partials ephemeral and stores one stable final across reconnect replay', async () => {
        const attempt = beginCanonicalVoiceTranscriptAttempt({ conversationSessionId: 'carrier-canonical' });
        if (!attempt) throw new Error('Expected transcript attempt');
        const base = { v: 1 as const, epoch: attempt.epoch, itemId: 'provider-item-1',
            role: 'assistant' as const, provenance: 'live' as const };
        projectCanonicalVoiceTranscriptEvent({ conversationSessionId: 'carrier-canonical',
            event: { ...base, type: 'voice.transcript.updated', sequence: 1, revision: 1, eventId: 'partial-1', text: 'partial' } });
        expect(entries('carrier-canonical')).toEqual([]);
        expect(writes).toEqual([]);
        projectCanonicalVoiceTranscriptEvent({ conversationSessionId: 'carrier-canonical',
            event: { ...base, type: 'voice.transcript.final', sequence: 2, revision: 2, eventId: 'final-live', text: 'final answer' } });
        projectCanonicalVoiceTranscriptEvent({ conversationSessionId: 'carrier-canonical',
            event: { ...base, type: 'voice.transcript.final', sequence: 2, revision: 2, eventId: 'final-replay',
                text: 'final answer', provenance: 'replay' } });
        await settleAdmittedCanonicalVoiceTranscriptPersistence({ conversationSessionId: 'carrier-canonical',
            attemptIdentity: attempt.attemptIdentity });
        expect(writes).toEqual([expect.objectContaining({ sessionId: 'carrier-canonical',
            localId: expect.stringMatching(/^voice-realtime:[^:]+:assistant:provider-item-1$/),
            messageRole: 'agent', rawRecord: expect.objectContaining({ role: 'agent',
                meta: { happier: expect.objectContaining({ conversationTurnOriginV1: {
                    v: 1, channel: 'realtime_conversation', modality: 'voice',
                } }) } }),
        })]);
        expect(entries('carrier-canonical')).toEqual([expect.objectContaining({ kind: 'assistant', text: 'final answer' })]);
        expect(readCanonicalVoiceTranscriptSnapshot('carrier-canonical')).toEqual([
            expect.objectContaining({ itemId: 'provider-item-1', final: true, text: 'final answer' }),
        ]);
        await releaseCanonicalVoiceTranscriptConversation({ conversationSessionId: 'carrier-canonical',
            attemptIdentity: attempt.attemptIdentity });
    });
    it('releases attempt projections while retaining canonical Voice and unrelated Agent rows', async () => {
        await persistVoiceConversationSpokenAssistantText({ conversationSessionId: 'direct-agent-session', text: 'canonical coding result' });
        const before = entries('direct-agent-session')[0];
        const attempt = beginCanonicalVoiceTranscriptAttempt({ conversationSessionId: 'direct-agent-session' });
        if (!attempt) throw new Error('Expected transcript attempt');
        projectCanonicalVoiceTranscriptEvent({ conversationSessionId: 'direct-agent-session', event: {
            v: 1, type: 'voice.transcript.final', epoch: attempt.epoch, sequence: 1, revision: 1,
            eventId: 'voice-final', itemId: 'voice-turn', role: 'assistant', text: 'spoken result', provenance: 'live',
        } });
        await releaseCanonicalVoiceTranscriptConversation({ conversationSessionId: 'direct-agent-session',
            attemptIdentity: attempt.attemptIdentity });
        expect(readCanonicalVoiceTranscriptSnapshot('direct-agent-session')).toEqual([]);
        expect(entries('direct-agent-session')).toHaveLength(2);
        expect(entries('direct-agent-session')).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'assistant', text: 'spoken result' }), before,
        ]));
    });
});
