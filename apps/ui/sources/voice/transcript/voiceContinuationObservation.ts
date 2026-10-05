import type { Message } from '@happier-dev/session-core/messages';
import { isRecoveredHistoryTranscriptObservation } from '@happier-dev/session-core/messages';
import { areSessionAddressesEqual, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { readVoiceContinuationProvenance } from './voiceTranscriptNoteMeta';

/** One local attempt's observed note boundary; this is neither microphone custody nor a remote command. */
export function createVoiceContinuationObservation(input: Readonly<{
    deviceId: string;
    conversation: SessionAddress;
    afterSeq: number | null;
}>) {
    let observed = false;
    return {
        observe(message: Message): boolean {
            if (!input.deviceId.trim() || input.afterSeq === null || !Number.isSafeInteger(input.afterSeq) || input.afterSeq < 0
                || message.kind !== 'agent-text' || message.isThinking === true || isRecoveredHistoryTranscriptObservation(message)
                || typeof message.seq !== 'number' || !Number.isSafeInteger(message.seq) || message.seq <= input.afterSeq) return false;
            const continuation = readVoiceContinuationProvenance(message.meta);
            if (observed || !continuation || continuation.deviceId === input.deviceId
                || !areSessionAddressesEqual(continuation.conversation, input.conversation)) return false;
            observed = true;
            return true;
        },
    };
}
