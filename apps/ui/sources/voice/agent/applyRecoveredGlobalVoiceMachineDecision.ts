import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import { clearVoiceAgentRecoveryReplaySource, setVoiceAgentRecoveryReplaySource } from './voiceAgentRecoveryReplayState';
import type { recoverUnavailableGlobalVoiceAutoMachine } from './recoverUnavailableGlobalVoiceAutoMachine';

export function applyRecoveredGlobalVoiceMachineDecision(
    decision: Awaited<ReturnType<typeof recoverUnavailableGlobalVoiceAutoMachine>>,
): void {
    clearVoiceAgentRecoveryReplaySource(VOICE_AGENT_GLOBAL_SESSION_ID);
    if (decision.kind !== 'switch') return;
    const replaySourceConversationSessionId = normalizeNonEmptyString(decision.replaySourceConversationSessionId);
    if (decision.replayConversation && replaySourceConversationSessionId) {
        setVoiceAgentRecoveryReplaySource(VOICE_AGENT_GLOBAL_SESSION_ID, replaySourceConversationSessionId);
    }
}
