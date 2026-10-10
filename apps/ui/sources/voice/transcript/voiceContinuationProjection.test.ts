import { describe, expect, it } from 'vitest';
import { createVoiceContinuationProjection, readVoiceContinuationArrival } from './voiceContinuationProjection';
import { buildVoiceTranscriptNoteMeta } from './voiceTranscriptNoteMeta';
import type { VoiceSessionBinding } from '@/voice/binding/voiceConversationBindingTypes';
import type { VoiceSessionSnapshot } from '@/voice/session/types';

const conversation = { serverId: 'home-a', sessionId: 'conversation' };
const binding: VoiceSessionBinding = { adapterId: 'service', controlSessionId: 'control', conversationSessionId: 'conversation',
    conversationSessionAddress: conversation, transcriptMode: 'synthetic', targetSessionAddress: null, updatedAt: 1 };
const snapshot: VoiceSessionSnapshot = { adapterId: 'service', sessionId: 'control', status: 'connecting', mode: 'idle', canStop: true };

describe('Voice continuation attempt projection', () => {
    it('publishes only a connected bound attempt and retires only its own exact live control', () => {
        const projection = createVoiceContinuationProjection();
        expect(projection.update({ snapshot, binding: null, deviceId: 'a', sessionSeq: 10 })).toBeNull();
        expect(projection.update({ snapshot, binding, deviceId: 'a', sessionSeq: 10 })).toBeNull();
        expect(projection.update({ snapshot: { ...snapshot, status: 'connected' }, binding, deviceId: 'a', sessionSeq: 12 }))
            .toEqual({ v: 1, deviceId: 'a', conversation });
        expect(projection.update({ snapshot: { ...snapshot, status: 'connected' }, binding, deviceId: 'a', sessionSeq: 12 })).toBeNull();
        const note = { kind: 'agent-text' as const, id: 'note', localId: 'note', seq: 11, createdAt: 1, text: 'Continued',
            meta: buildVoiceTranscriptNoteMeta({ continuation: { v: 1, deviceId: 'b', conversation } }) };
        expect(projection.observe({ ...conversation, serverId: 'other' }, [note])).toBeNull();
        expect(projection.observe(conversation, [note])).toEqual({ controlSessionId: 'control', continuation: { v: 1, deviceId: 'b', conversation } });
        expect(projection.observe(conversation, [note])).toBeNull();
    });

    it('failed taps, terminal attempts and wrong bindings never publish or retain end authority', () => {
        const projection = createVoiceContinuationProjection();
        const failed = { ...snapshot, status: 'error' as const, canStop: false };
        expect(projection.update({ snapshot: failed, binding, deviceId: 'a', sessionSeq: 10 })).toBeNull();
        expect(projection.update({ snapshot: { ...snapshot, status: 'connected' }, binding: { ...binding, adapterId: 'other' }, deviceId: 'a', sessionSeq: 10 })).toBeNull();
        expect(projection.update({ snapshot: { ...snapshot, status: 'connected' }, binding, deviceId: 'a', sessionSeq: 10 })).not.toBeNull();
        projection.update({ snapshot: failed, binding, deviceId: 'a', sessionSeq: 10 });
        expect(projection.observe(conversation, [{ kind: 'agent-text', id: 'note', localId: null, seq: 11, createdAt: 1, text: 'Continued',
            meta: buildVoiceTranscriptNoteMeta({ continuation: { v: 1, deviceId: 'b', conversation } }) }])).toBeNull();
    });
});

describe('Voice continuation arrival', () => {
    const note = (seq: number, deviceId: string, address = conversation) => ({ kind: 'agent-text' as const, id: `note-${seq}`, localId: null,
        seq, createdAt: seq, text: 'Voice continued.', meta: buildVoiceTranscriptNoteMeta({ continuation: { v: 1, deviceId, conversation: address } }) });
    const turn = { kind: 'user-text' as const, id: 'turn', localId: null, seq: 9, createdAt: 9, text: 'hello' };

    it('is an arrival only when the conversation was last voiced on another device', () => {
        expect(readVoiceContinuationArrival([note(3, 'a'), note(7, 'b'), turn], conversation, 'a')).toBe(true);
        expect(readVoiceContinuationArrival([note(7, 'b'), note(3, 'a'), turn], conversation, 'b')).toBe(false);
        expect(readVoiceContinuationArrival([turn], conversation, 'a')).toBe(false);
        expect(readVoiceContinuationArrival([note(7, 'b', { ...conversation, sessionId: 'elsewhere' })], conversation, 'a')).toBe(false);
        expect(readVoiceContinuationArrival([note(7, 'b')], conversation, ' ')).toBe(false);
    });
});
