import { storage } from '@/sync/domains/state/storage';
import { voiceActivityController } from '@/voice/activity/voiceActivityController';
import { findVoiceCarrierSessionId } from '@/voice/agent/voiceCarrierSession';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceAgentSessions } from '@/voice/agent/voiceAgentSessions';
import { clearVoiceAgentRunMetadataFromCarrierSession } from '@/voice/persistence/voiceAgentRunMetadata';

export async function resetGlobalVoiceAgentPersistence(): Promise<void> {
  await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
  voiceActivityController.clearSession(VOICE_AGENT_GLOBAL_SESSION_ID);

  const carrierSessionId = findVoiceCarrierSessionId(storage.getState() as any);
  if (carrierSessionId) {
    await clearVoiceAgentRunMetadataFromCarrierSession({ carrierSessionId }).catch(() => {});
  }
}

