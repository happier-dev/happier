import { storage } from '@/sync/domains/state/storage';
import { voiceAgentSessions } from '@/voice/agent/voiceAgentSessions';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { getVoiceAgentSessionTeleportAvailability } from '@/voice/agent/getVoiceAgentSessionTeleportAvailability';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { voiceSessionBindingManager } from '@/voice/sessionBinding/voiceSessionBindingRuntime';

export type VoiceTeleportResult =
  | Readonly<{ ok: true }>
  | Readonly<{
    ok: false;
    code: 'VOICE_TELEPORT_DISABLED' | 'VOICE_TELEPORT_BLOCKED_BY_HOME' | 'VOICE_TELEPORT_UNAVAILABLE';
  }>;

export async function teleportVoiceAgentToSessionRoot(params: Readonly<{ sessionId: string }>): Promise<VoiceTeleportResult> {
  const sessionId = normalizeNonEmptyString(params.sessionId);
  if (!sessionId) return { ok: false, code: 'VOICE_TELEPORT_UNAVAILABLE' };

  const state: any = storage.getState();
  const availability = getVoiceAgentSessionTeleportAvailability({ voice: state?.settings?.voice ?? null, sessionId });
  if (!availability.ok) return availability;

  const binding = await voiceSessionBindingManager.ensureBound({
    adapterId: 'local_conversation',
    controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    requestedTargetSessionId: sessionId,
  });
  if (!binding) return { ok: false, code: 'VOICE_TELEPORT_UNAVAILABLE' };
  await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID).catch(() => {});
  return { ok: true };
}
