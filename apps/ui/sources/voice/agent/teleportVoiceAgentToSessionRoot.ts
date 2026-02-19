import { storage } from '@/sync/domains/state/storage';
import { ensureVoiceCarrierSessionForSessionRoot } from '@/voice/agent/voiceCarrierSession';
import { voiceAgentSessions } from '@/voice/agent/voiceAgentSessions';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

function normalizeNonEmptyString(value: unknown): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

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
  const voice = state?.settings?.voice ?? null;
  if (voice?.providerId !== 'local_conversation') return { ok: false, code: 'VOICE_TELEPORT_UNAVAILABLE' };

  const adapterCfg = voice?.adapters?.local_conversation ?? null;
  if (adapterCfg?.conversationMode !== 'agent') return { ok: false, code: 'VOICE_TELEPORT_UNAVAILABLE' };

  const agentCfg = adapterCfg?.agent ?? null;
  if (agentCfg?.stayInVoiceHome === true) return { ok: false, code: 'VOICE_TELEPORT_BLOCKED_BY_HOME' };
  if (agentCfg?.teleportEnabled === false) return { ok: false, code: 'VOICE_TELEPORT_DISABLED' };
  if ((agentCfg?.backend ?? 'daemon') !== 'daemon') return { ok: false, code: 'VOICE_TELEPORT_UNAVAILABLE' };

  await ensureVoiceCarrierSessionForSessionRoot({ sessionId });
  await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID).catch(() => {});
  return { ok: true };
}

