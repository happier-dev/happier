import { getCurrentAuth } from '@/auth/context/AuthContext';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { router } from 'expo-router';

export async function openSessionForVoiceTool(params: Readonly<{
  sessionId: string;
  resolveServerIdForSessionId?: (sessionId: string) => string | null;
}>): Promise<Readonly<{ ok: true; status: 'opened'; sessionId: string }>> {
  const sessionId = String(params.sessionId ?? '').trim();
  const targetServerId = params.resolveServerIdForSessionId ? params.resolveServerIdForSessionId(sessionId) : null;
  if (targetServerId) {
    const active = getActiveServerSnapshot();
    if (String(active.serverId ?? '').trim() !== targetServerId) {
      const auth = getCurrentAuth();
      try {
        await setActiveServerAndSwitch({
          serverId: targetServerId,
          scope: 'device',
          refreshAuth: auth?.refreshFromActiveServer ?? null,
        });
      } catch {
        // best-effort
      }
    }
  }

  useVoiceTargetStore.getState().setLastFocusedSessionId(sessionId);
  useVoiceTargetStore.getState().setPrimaryActionSessionId(sessionId);

  try {
    router.navigate(`/session/${sessionId}` as any, {
      dangerouslySingular() {
        return 'session';
      },
    } as any);
  } catch {
    // best-effort
  }

  return { ok: true, status: 'opened', sessionId };
}

