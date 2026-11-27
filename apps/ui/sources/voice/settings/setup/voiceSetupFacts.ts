import type { Message } from '@happier-dev/session-core/messages';
import { readConversationTurnOriginV1FromMessageMeta } from '@happier-dev/protocol/messages/structured/conversationTurnOriginV1';
import { readVoiceAgentTurnPayloadFromMeta } from '@happier-dev/protocol/messages/structured/voiceAgentTurnLocalId';
import { readSessionMessageProvenance } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { MicrophonePermissionState } from '@/utils/platform/microphonePermissions';
import type { VoiceRoleReadiness } from '@/voice/registry/readiness';
import { readCanonicalVoiceTranscriptAttemptKey } from '@/voice/transcript/canonicalProjector';

export type VoiceSetupInput = Readonly<{
    providerId: string | null;
    readiness: VoiceRoleReadiness | null;
    microphonePermission: MicrophonePermissionState;
    messages: readonly Message[];
}>;
export type VoiceSetupStepState = 'done' | 'current' | 'upcoming' | 'blocked' | 'working';

/** Facts only: no acquisition, provider calls, timers or persisted step state. */
export function deriveVoiceSetupFacts(input: VoiceSetupInput) {
    const serviceSelected = Boolean(input.providerId && input.providerId !== 'off');
    const infrastructureReady = serviceSelected && input.readiness?.status === 'ready'
        && input.readiness.providerId === input.providerId;
    const microphoneGranted = input.microphonePermission === 'granted';
    const firstTurnComplete = hasRetainedVoiceInputAndReply(input.messages);
    const observedSteps = [
        { id: 'service', done: serviceSelected },
        { id: 'readiness', done: infrastructureReady },
        { id: 'microphone', done: microphoneGranted },
        { id: 'first_turn', done: firstTurnComplete },
    ] as const;
    const currentIndex = observedSteps.findIndex((step) => !step.done);
    const steps = observedSteps.map((step, index) => {
        const state: VoiceSetupStepState = step.done ? 'done' : index !== currentIndex ? 'upcoming'
            : step.id === 'readiness' && input.readiness?.status === 'installing' ? 'working'
                : (step.id === 'readiness' && input.readiness && input.readiness.status !== 'ready')
                    || (step.id === 'microphone' && (input.microphonePermission === 'denied' || input.microphonePermission === 'unavailable'))
                    ? 'blocked' : 'current';
        return { ...step, state };
    });
    const doneCount = observedSteps.filter((step) => step.done).length;
    const complete = doneCount === observedSteps.length;
    return { steps, doneCount, total: observedSteps.length, selectedServiceId: input.providerId,
        readiness: input.readiness, canTry: infrastructureReady, firstTurnComplete, complete,
        // Which microphone fact blocks the step: a denial and a missing device recover differently.
        microphonePermission: input.microphonePermission };
}

/** Input the person said aloud: the input owner's Voice provenance, or a realtime Voice turn. */
function isSpokenInput(meta: unknown): boolean {
    if (readSessionMessageProvenance(meta, 'stored')?.kind === 'voice') return true;
    const origin = readConversationTurnOriginV1FromMessageMeta(meta);
    return origin?.channel === 'realtime_conversation' && origin.modality === 'voice';
}

/**
 * The try's latest turn as the conversation holds it: the last thing said aloud (queued or written)
 * and the newest answer written after it (a direct Session answers through its own agent). Only rows
 * from this call count, so words said in an earlier call never light the phrase.
 */
export function readVoiceSetupTryTurn(input: Readonly<{
    messages: readonly Message[];
    pending: readonly Readonly<{ text: string; createdAt: number; rawRecord?: unknown }>[];
    since: number | null;
    transcriptEntries?: readonly Readonly<{ kind: string; text: string; createdAt: number }>[];
}>): Readonly<{ said: string | null; reply: string | null }> {
    type Row = Readonly<{ at: number; said?: string; reply?: string }>;
    const rows: Row[] = [];
    for (const entry of input.transcriptEntries ?? []) {
        if (!entry.text.trim()) continue;
        if (entry.kind === 'user') rows.push({ at: entry.createdAt, said: entry.text });
        else if (entry.kind === 'assistant') rows.push({ at: entry.createdAt, reply: entry.text });
    }
    for (const message of input.messages) {
        if (message.kind === 'user-text' && message.text.trim() && isSpokenInput(message.meta)) rows.push({ at: message.createdAt, said: message.text });
        else if (message.kind === 'agent-text' && !message.isThinking && message.text.trim()) rows.push({ at: message.createdAt, reply: message.text });
    }
    for (const queued of input.pending) {
        const meta = queued.rawRecord && typeof queued.rawRecord === 'object' ? (queued.rawRecord as { meta?: unknown }).meta : undefined;
        if (queued.text.trim() && isSpokenInput(meta)) rows.push({ at: queued.createdAt, said: queued.text });
    }
    let said: string | null = null;
    let reply: string | null = null;
    for (const row of rows.sort((left, right) => left.at - right.at)) {
        if (input.since !== null && row.at < input.since) continue;
        if (row.said !== undefined) {
            said = row.said;
            reply = null;
        } else if (said !== null) {
            reply = row.reply ?? reply;
        }
    }
    return { said, reply };
}

export function hasRetainedVoiceInputAndReply(messages: readonly Message[]): boolean {
    const attempts = new Map<string, { inputSeq: number | null; replySeq: number | null }>();
    const directTurns: { seq: number; kind: 'spoken' | 'typed' | 'reply' }[] = [];
    let hasDirectInput = false;
    let hasLocalCaptureInput = false;
    let hasLocalAgentReply = false;
    for (const message of messages) {
        const seq = message.seq;
        if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) continue;
        if (message.kind !== 'user-text' && message.kind !== 'agent-text') continue;
        if (!message.text.trim() || (message.kind === 'agent-text' && message.isThinking)) continue;
        const origin = readConversationTurnOriginV1FromMessageMeta(message.meta);
        const agentTurn = readVoiceAgentTurnPayloadFromMeta(message.meta);
        const role = message.kind === 'user-text' ? 'user' : 'assistant';
        const id = message.localId ?? message.id;
        const retainedAttempt = readCanonicalVoiceTranscriptAttemptKey(id, role);
        if (id.startsWith('voice-realtime:') && !retainedAttempt) continue;
        if ((origin?.channel !== 'realtime_conversation' || origin.modality !== 'voice') && !agentTurn) {
            if (!retainedAttempt && origin?.channel === 'agent_thread') {
                if (role === 'user') {
                    const spoken = isSpokenInput(message.meta);
                    hasDirectInput ||= spoken;
                    directTurns.push({ seq, kind: spoken ? 'spoken' : 'typed' });
                } else {
                    directTurns.push({ seq, kind: 'reply' });
                }
            }
            continue;
        }
        // Local capture's ordinary Voice-marked user row and the daemon reply
        // have different envelopes. The reply carries voice_agent_turn.v1,
        // not a realtime attempt id. Pending settles that input after daemon
        // acceptance, so the reply can commit first: seq orders writes, not
        // spoken turns. Never bridge a different realtime attempt.
        if (!retainedAttempt && !agentTurn && role === 'user') {
            hasLocalCaptureInput = true;
        }
        if (!retainedAttempt && agentTurn?.role === 'assistant' && role === 'assistant') {
            hasLocalAgentReply = true;
        }
        const key = retainedAttempt ? `realtime:${retainedAttempt}` : agentTurn
            ? JSON.stringify(['agent', agentTurn.voiceAgentId, agentTurn.epoch])
            // Predecessor Voice rows have no canonical attempt local id. Their
            // genuine Voice provenance + acknowledged input-before-reply remain readable.
            : JSON.stringify(['predecessor', origin?.source ?? null]);
        const attempt = attempts.get(key) ?? { inputSeq: null, replySeq: null };
        if (role === 'user') attempt.inputSeq = Math.min(attempt.inputSeq ?? seq, seq);
        else attempt.replySeq = Math.max(attempt.replySeq ?? seq, seq);
        attempts.set(key, attempt);
    }
    if ((hasLocalCaptureInput && hasLocalAgentReply)
        || [...attempts.values()].some(({ inputSeq, replySeq }) => inputSeq !== null && replySeq !== null && replySeq > inputSeq)) {
        return true;
    }
    if (!hasDirectInput) return false;

    // A direct Session's regular coding agent answers through its ordinary
    // Session timeline. The next user input ends that input's reply window.
    let spokenSeq: number | null = null;
    for (const turn of directTurns.sort((left, right) => left.seq - right.seq)) {
        if (turn.kind === 'reply') {
            if (spokenSeq !== null && turn.seq > spokenSeq) return true;
        } else {
            spokenSeq = turn.kind === 'spoken' ? turn.seq : null;
        }
    }
    return false;
}

export type VoiceSetupFacts = ReturnType<typeof deriveVoiceSetupFacts>;
