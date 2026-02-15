import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

export async function setPrimaryActionSessionId(params: Readonly<{ sessionId: string | null }>): Promise<Readonly<{ ok: true; status: 'ok'; sessionId: string | null }>> {
  useVoiceTargetStore.getState().setPrimaryActionSessionId(params.sessionId);
  return { ok: true, status: 'ok', sessionId: params.sessionId };
}

export async function setTrackedSessionIds(params: Readonly<{ sessionIds: readonly string[] }>): Promise<Readonly<{ ok: true; status: 'ok'; sessionIds: readonly string[] }>> {
  useVoiceTargetStore.getState().setTrackedSessionIds(params.sessionIds as string[]);
  return { ok: true, status: 'ok', sessionIds: params.sessionIds };
}

