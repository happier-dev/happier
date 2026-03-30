import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

const voiceAgentRecoveryReplaySourceBySessionId = new Map<string, string>();

export function readVoiceAgentRecoveryReplaySource(sessionId: string): string | null {
    return normalizeNonEmptyString(voiceAgentRecoveryReplaySourceBySessionId.get(sessionId) ?? null);
}

export function setVoiceAgentRecoveryReplaySource(sessionId: string, replaySourceConversationSessionId: string): void {
    const normalizedSessionId = normalizeNonEmptyString(sessionId);
    const normalizedReplaySourceConversationSessionId = normalizeNonEmptyString(replaySourceConversationSessionId);
    if (!normalizedSessionId || !normalizedReplaySourceConversationSessionId) return;
    voiceAgentRecoveryReplaySourceBySessionId.set(normalizedSessionId, normalizedReplaySourceConversationSessionId);
}

export function clearVoiceAgentRecoveryReplaySource(sessionId: string): void {
    const normalizedSessionId = normalizeNonEmptyString(sessionId);
    if (!normalizedSessionId) return;
    voiceAgentRecoveryReplaySourceBySessionId.delete(normalizedSessionId);
}
