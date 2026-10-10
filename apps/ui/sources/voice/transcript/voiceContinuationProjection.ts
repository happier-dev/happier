import type { Message } from '@happier-dev/session-core/messages';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { VoiceSessionBinding } from '@/voice/binding/voiceConversationBindingTypes';
import type { VoiceSessionSnapshot } from '@/voice/session/types';
import { readVoiceContinuationProvenance, type VoiceContinuationProvenance } from './voiceTranscriptNoteMeta';
import { areSessionAddressesEqual } from '@/sync/domains/session/sessionAddress';
import { createVoiceContinuationObservation } from './voiceContinuationObservation';

/**
 * Whether a connecting attempt continues a conversation last voiced on another device: the newest
 * synced continuation note of that exact conversation names a different device. Read once, when this
 * device publishes its own note; unknown or unloaded history is not an arrival.
 */
export function readVoiceContinuationArrival(messages: readonly Message[], conversation: SessionAddress, deviceId: string): boolean {
    if (!deviceId.trim()) return false;
    let latest: Readonly<{ seq: number; deviceId: string }> | null = null;
    for (const message of messages) {
        if (typeof message.seq !== 'number' || (latest && message.seq <= latest.seq)) continue;
        const continuation = readVoiceContinuationProvenance(message.meta);
        if (!continuation || !areSessionAddressesEqual(continuation.conversation, conversation)) continue;
        latest = { seq: message.seq, deviceId: continuation.deviceId };
    }
    return latest !== null && latest.deviceId !== deviceId;
}

/** Attempt-local presentation memory only; sync remains the conversation authority. */
export function createVoiceContinuationProjection() {
    let attempt: Readonly<{ adapterId: string; controlSessionId: string; conversation: SessionAddress; deviceId: string;
        observation: ReturnType<typeof createVoiceContinuationObservation> }> | null = null;
    let published = false;
    return {
        update(input: Readonly<{ snapshot: VoiceSessionSnapshot; binding: VoiceSessionBinding | null; deviceId: string | null; deviceDisplayName?: string | null; sessionSeq: number | null }>): VoiceContinuationProvenance | null {
            const { snapshot, binding, deviceId } = input;
            if (!snapshot.canStop || !snapshot.sessionId || !binding || !deviceId?.trim()
                || binding.adapterId !== snapshot.adapterId || binding.controlSessionId !== snapshot.sessionId) {
                attempt = null;
                published = false;
                return null;
            }
            if (!attempt || attempt.adapterId !== snapshot.adapterId || attempt.controlSessionId !== snapshot.sessionId
                || attempt.deviceId !== deviceId || !areSessionAddressesEqual(attempt.conversation, binding.conversationSessionAddress)) {
                const conversation = binding.conversationSessionAddress;
                attempt = { adapterId: binding.adapterId, controlSessionId: binding.controlSessionId, conversation, deviceId,
                    observation: createVoiceContinuationObservation({ conversation, deviceId, afterSeq: input.sessionSeq }) };
                published = false;
            }
            if (snapshot.status !== 'connected' || published) return null;
            published = true;
            return { v: 1, deviceId, conversation: attempt.conversation,
                ...(input.deviceDisplayName !== undefined ? { deviceDisplayName: input.deviceDisplayName } : {}) };
        },
        observe(address: SessionAddress, messages: readonly Message[]): Readonly<{ controlSessionId: string; continuation: VoiceContinuationProvenance }> | null {
            const current = attempt;
            if (!current || !areSessionAddressesEqual(address, current.conversation)) return null;
            const message = messages.find((candidate) => current.observation.observe(candidate));
            const continuation = message ? readVoiceContinuationProvenance(message.meta) : null;
            return continuation ? { controlSessionId: current.controlSessionId, continuation } : null;
        },
    };
}
