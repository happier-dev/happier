import { describe, expect, it } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import { buildVoiceTranscriptNoteMeta } from './voiceTranscriptNoteMeta';
import { createVoiceContinuationObservation } from './voiceContinuationObservation';

const conversation = { serverId: 'home-a', sessionId: 'voice-a' };
function note(seq: number | undefined, deviceId = 'device-b', address = conversation): Extract<Message, { kind: 'agent-text' }> {
    return { kind: 'agent-text', id: `note-${seq}`, seq, localId: 'note', createdAt: 100, text: 'Continued here',
        meta: buildVoiceTranscriptNoteMeta({ continuation: { v: 1, deviceId, conversation: address } }) };
}

describe('local Voice continuation observation', () => {
    it('ends only the old observer for a newer acknowledged other-device continuation, once', () => {
        const a = createVoiceContinuationObservation({ deviceId: 'device-a', conversation, afterSeq: 10 });
        const b = createVoiceContinuationObservation({ deviceId: 'device-b', conversation, afterSeq: 10 });
        expect(a.observe(note(11))).toBe(true);
        expect(a.observe(note(11))).toBe(false);
        expect(b.observe(note(11))).toBe(false);
    });

    it('rejects hydration, unacknowledged/unknown provenance, different Homes/conversations and assistant echo', () => {
        const observation = createVoiceContinuationObservation({ deviceId: 'device-a', conversation, afterSeq: 10 });
        expect(observation.observe(note(10))).toBe(false);
        expect(observation.observe(note(9))).toBe(false);
        expect(observation.observe(note(undefined))).toBe(false);
        expect(observation.observe(note(11, 'device-b', { ...conversation, serverId: 'home-b' }))).toBe(false);
        expect(observation.observe(note(11, 'device-b', { ...conversation, sessionId: 'other' }))).toBe(false);
        expect(observation.observe({ ...note(11), meta: undefined })).toBe(false);
        expect(observation.observe({ ...note(11), kind: 'user-text' })).toBe(false);
        expect(observation.observe({ ...note(11), transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' } })).toBe(false);
        expect(observation.observe({ ...note(11), meta: { happier: { kind: 'voice_note.v1', payload: { v: 1, continuation: { v: 99, deviceId: 'device-b', conversation } } } } })).toBe(false);
        expect(observation.observe(note(12))).toBe(true);
    });

    it('cannot retire a microphone without a known start boundary', () => {
        const observation = createVoiceContinuationObservation({ deviceId: 'device-a', conversation, afterSeq: null });
        expect(observation.observe(note(11))).toBe(false);
    });
});
