import { describe, expect, it } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import type { VoiceRoleReadiness } from '@/voice/registry/readiness';
import { deriveVoiceSetupFacts } from './voiceSetupFacts';

const ready: VoiceRoleReadiness = {
    role: 'realtime_conversation', providerId: 'test.service', status: 'ready', code: 'ready',
    reasonKey: 'voice.readiness.ready', recoveryAction: 'none',
};
const meta = { happier: { kind: 'conversation_turn.v1', payload: { v: 1 },
    conversationTurnOriginV1: { v: 1, channel: 'realtime_conversation', modality: 'voice' } } } as const;
const user: Message = { kind: 'user-text', id: 'input', localId: null, seq: 1, createdAt: 10, text: 'hello', meta };
const reply: Message = { kind: 'agent-text', id: 'reply', localId: null, seq: 2, createdAt: 20, text: 'Hi', meta };

describe('Voice setup facts', () => {
    it('projects only observed step progress and the readiness owner’s blocked or installing state', () => {
        const base = { providerId: 'test.service', microphonePermission: 'unknown' as const, messages: [] };
        expect(deriveVoiceSetupFacts({ ...base, readiness: null }).steps.map((step) => step.state)).toEqual(['done', 'current', 'upcoming', 'upcoming']);
        expect(deriveVoiceSetupFacts({ ...base, readiness: { ...ready, status: 'installing' } }).steps[1]?.state).toBe('working');
        expect(deriveVoiceSetupFacts({ ...base, readiness: { ...ready, status: 'needs_setup' } }).steps[1]?.state).toBe('blocked');
        expect(deriveVoiceSetupFacts({ ...base, readiness: ready, microphonePermission: 'denied' }).steps[2]?.state).toBe('blocked');
    });
    it('does not turn a failed input and a later attempt greeting into first success', () => {
        const input = { ...user, localId: 'voice-realtime:old:user:input' };
        const greeting = { ...reply, localId: 'voice-realtime:new:assistant:greeting' };
        expect(deriveVoiceSetupFacts({ providerId: 'service', readiness: ready, microphonePermission: 'granted', messages: [input, greeting] }).firstTurnComplete).toBe(false);
        expect(deriveVoiceSetupFacts({ providerId: 'service', readiness: ready, microphonePermission: 'granted', messages: [input, { ...greeting, localId: 'voice-realtime:old:assistant:reply' }] }).firstTurnComplete).toBe(true);
    });
    it('keeps unknown or missing infrastructure incomplete and never permits Try from unknown readiness', () => {
        expect(deriveVoiceSetupFacts({ providerId: 'test.service', readiness: null, microphonePermission: 'unknown', messages: [] }))
            .toMatchObject({ canTry: false, complete: false, steps: [
                { id: 'service', done: true }, { id: 'readiness', done: false },
                { id: 'microphone', done: false }, { id: 'first_turn', done: false },
            ] });
        expect(deriveVoiceSetupFacts({ providerId: null, readiness: ready, microphonePermission: 'granted', messages: [] }).canTry).toBe(false);
    });

    it('permits explicit Try once infrastructure is ready but completes only after a retained real input/reply', () => {
        const input = { providerId: 'test.service', readiness: ready, microphonePermission: 'granted' as const };
        expect(deriveVoiceSetupFacts({ ...input, messages: [reply] })).toMatchObject({ canTry: true, firstTurnComplete: false });
        expect(deriveVoiceSetupFacts({ ...input, messages: [user, { ...reply, seq: undefined }] }).firstTurnComplete).toBe(false);
        expect(deriveVoiceSetupFacts({ ...input, messages: [user, reply] })).toMatchObject({ firstTurnComplete: true, complete: true });
    });

    it('retains genuine success when permission is revoked and does not count plain text or a note as a Voice reply', () => {
        const input = { providerId: 'test.service', readiness: ready, microphonePermission: 'denied' as const };
        expect(deriveVoiceSetupFacts({ ...input, messages: [user, reply] }))
            .toMatchObject({ firstTurnComplete: true, complete: false });
        expect(deriveVoiceSetupFacts({ ...input, messages: [user, { ...reply, meta: undefined }] }).firstTurnComplete).toBe(false);
        expect(deriveVoiceSetupFacts({ ...input, messages: [user, { ...reply, meta: { happier: { kind: 'voice_note.v1', payload: { v: 1 } } } }] }).firstTurnComplete).toBe(false);
    });
});
