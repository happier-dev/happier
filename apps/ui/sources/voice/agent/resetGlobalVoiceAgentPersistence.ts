import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceAgentSessions } from '@/voice/agent/voiceAgentSessions';
import { resetVoiceAgentPersistenceState } from '@/voice/persistence/resetVoiceAgentPersistenceState';

export async function resetGlobalVoiceAgentPersistence(): Promise<void> {
  await resetVoiceAgentPersistenceState({
    stop: async () => await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID),
  });
}
