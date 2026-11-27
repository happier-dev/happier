import { describe, expect, it } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import type { VoiceRoleReadiness } from '@/voice/registry/readiness';
import { deriveVoiceSetupFacts, readVoiceSetupTryTurn } from './voiceSetupFacts';
import { VoiceAgentTurnV1Schema } from '@happier-dev/protocol/messages/structured/voiceAgentTurnV1';

const ready: VoiceRoleReadiness = {
    role: 'realtime_conversation', providerId: 'test.service', status: 'ready', code: 'ready',
    reasonKey: 'voice.readiness.ready', recoveryAction: 'none',
};
const meta = { happier: { kind: 'conversation_turn.v1', payload: { v: 1 },
    conversationTurnOriginV1: { v: 1, channel: 'realtime_conversation', modality: 'voice' } } } as const;
const user: Message = { kind: 'user-text', id: 'input', localId: null, seq: 1, createdAt: 10, text: 'hello', meta };
const reply: Message = { kind: 'agent-text', id: 'reply', localId: null, seq: 2, createdAt: 20, text: 'Hi', meta };

describe('Voice setup facts', () => {
    it('pairs the retained local capture input with its daemon Voice Agent reply', () => {
        // Real producer shapes from voice-ship-journey/ordinary-marked-transcript-and-setup.json:
        // capture commits conversation_turn.v1; the daemon commits voice_agent_turn.v1.
        const input = { ...user, localId: 'dcd23cfe-a312-4d10-be68-483d19851b1d', seq: 87 };
        const output = { ...reply, localId: 'stream-reply:assistant', seq: 89, meta: { happier: {
            kind: 'voice_agent_turn.v1', payload: VoiceAgentTurnV1Schema.parse({
                v: 1, epoch: 0, role: 'assistant', voiceAgentId: 'run-reply', runId: 'run-reply',
                streamId: 'stream-reply', ts: 1792196469106,
            }),
        } } };
        const facts = (messages: Message[]) => deriveVoiceSetupFacts({ providerId: 'test.service', readiness: ready,
            microphonePermission: 'granted', messages }).firstTurnComplete;
        expect(facts([input, output])).toBe(true);
        expect(facts([output, input])).toBe(true); // Storage iteration order is not acknowledgement order.
        // Pending settlement can commit the input after the daemon reply. The
        // Session sequence orders writes; it does not order the spoken turn.
        expect(facts([input, { ...output, seq: 86 }])).toBe(true);
        expect(facts([{ ...input, localId: 'voice-realtime:other:user:input' }, output])).toBe(false);
        expect(facts([{ ...input, meta: undefined }, output])).toBe(false);
    });
    it('completes step four from an admitted direct-Session spoken row and its later ordinary reply', () => {
        const spoken: Message = { ...user, meta: { happierProvenanceV1: { v: 1, kind: 'voice' } } };
        const ordinaryReply: Message = { ...reply, meta: undefined };
        const facts = (messages: Message[]) => deriveVoiceSetupFacts({
            providerId: 'test.service', readiness: ready, microphonePermission: 'granted', messages,
        });
        expect(facts([ordinaryReply, spoken])).toMatchObject({ doneCount: 4, firstTurnComplete: true });
        expect(facts([spoken])).toMatchObject({ doneCount: 3, firstTurnComplete: false });
        expect(facts([spoken, { ...ordinaryReply, seq: 0 }]).firstTurnComplete).toBe(false);
        expect(facts([spoken, { ...ordinaryReply, isThinking: true }]).firstTurnComplete).toBe(false);
        expect(facts([spoken, { ...user, seq: 2, meta: undefined }, { ...ordinaryReply, seq: 3 }]).firstTurnComplete).toBe(false);
    });

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

describe('Voice setup try turn', () => {
    // The input owner's recorded shape for a direct-Session spoken turn (live QA 2026-11-23, Account F).
    const spokenMeta = { happierProvenanceV1: { v: 1, kind: 'voice' } };
    const typedMeta = { sentFrom: 'web' };

    it('orders live and written turns together so a new queued utterance clears the previous live reply', () => {
        const transcriptEntries = [
            { kind: 'user', text: 'First question', createdAt: 100 },
            { kind: 'assistant', text: 'First answer', createdAt: 110 },
        ];
        expect(readVoiceSetupTryTurn({ messages: [], pending: [], since: 50, transcriptEntries }))
            .toEqual({ said: 'First question', reply: 'First answer' });
        const pending = [{ text: 'Next question', createdAt: 120, rawRecord: { meta: spokenMeta } }];
        expect(readVoiceSetupTryTurn({ messages: [], pending, since: 50, transcriptEntries }))
            .toEqual({ said: 'Next question', reply: null });
    });

    it('shows the words said in this call as soon as they are queued, then the newest answer after them', () => {
        const queued = { text: 'WHAT ARE MY SESSIONS DOING', createdAt: 100, rawRecord: { meta: spokenMeta } };
        expect(readVoiceSetupTryTurn({ messages: [], pending: [queued], since: 50 })).toEqual({ said: queued.text, reply: null });

        const said: Message = { ...user, id: 'said', createdAt: 100, text: queued.text, meta: spokenMeta } as Message;
        const first: Message = { ...reply, id: 'first', createdAt: 110, text: 'Pulling the rundown now.', meta: undefined } as Message;
        const answer: Message = { ...reply, id: 'answer', createdAt: 130, text: 'You have one live session.', meta: undefined } as Message;
        expect(readVoiceSetupTryTurn({ messages: [answer, said, first], pending: [], since: 50 })).toEqual({ said: queued.text, reply: answer.text });
    });

    it('never lights the phrase from typed input or from an earlier call', () => {
        const typed: Message = { ...user, id: 'typed', createdAt: 100, text: 'what are my sessions doing', meta: typedMeta } as Message;
        const earlier: Message = { ...user, id: 'earlier', createdAt: 10, meta: spokenMeta } as Message;
        expect(readVoiceSetupTryTurn({ messages: [typed, earlier], pending: [], since: 50 })).toEqual({ said: null, reply: null });
    });
});
