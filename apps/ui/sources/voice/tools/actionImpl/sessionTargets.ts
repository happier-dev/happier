import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { storage } from '@/sync/domains/state/storage';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { applyVoiceSessionTargetSelection } from '@/voice/sessionBinding/applyVoiceSessionTargetSelection';
import { resolveVoiceSessionIdFromTitle, resolveVoiceSessionRef } from './sessionReference';

export async function setPrimaryActionSessionId(params: Readonly<{
  sessionId: string | null;
  sessionTitle?: string | null;
  updateLastFocused?: boolean;
}>): Promise<
  | Readonly<{
    ok: true;
    status: 'ok';
    sessionId: string | null;
    session?: Readonly<{ id: string; title?: string; locationLabel?: string; serverId?: string; serverName?: string }>;
  }>
  | Readonly<{
    ok: false;
    status: 'not_found';
    error: Readonly<{ code: 'session_not_found'; message: string; sessionTitle: string }>;
  }>
> {
  const state = storage.getState();
  const resolvedByTitle = params.sessionTitle ? resolveVoiceSessionIdFromTitle(params.sessionTitle, state) : null;
  if (params.sessionTitle && !resolvedByTitle) {
    return {
      ok: false,
      status: 'not_found',
      error: {
        code: 'session_not_found',
        message: `I could not find a session titled "${String(params.sessionTitle).trim()}".`,
        sessionTitle: String(params.sessionTitle).trim(),
      },
    };
  }

  const nextSessionId = resolvedByTitle?.sessionId ?? params.sessionId;
  applyVoiceSessionTargetSelection({
    controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    targetSessionId: nextSessionId,
    updateLastFocused: params.updateLastFocused === true,
  });
  const session = resolvedByTitle?.session ?? resolveVoiceSessionRef(nextSessionId, state);
  return { ok: true, status: 'ok', sessionId: nextSessionId, ...(session ? { session } : {}) };
}

export async function setTrackedSessionIds(params: Readonly<{ sessionIds: readonly string[] }>): Promise<Readonly<{
  ok: true;
  status: 'ok';
  sessionIds: readonly string[];
  sessions: readonly Readonly<{ id: string; title?: string; locationLabel?: string; serverId?: string; serverName?: string }>[];
}>> {
  const normalizedSessionIds = Array.from(
    new Set(
      params.sessionIds
        .map((sessionId) => String(sessionId ?? '').trim())
        .filter((sessionId) => sessionId.length > 0),
    ),
  );
  useVoiceTargetStore.getState().setTrackedSessionIds(normalizedSessionIds as string[]);
  const storedSessionIds = useVoiceTargetStore.getState().trackedSessionIds;
  const state = storage.getState();
  const sessions = storedSessionIds
    .map((sessionId) => resolveVoiceSessionRef(sessionId, state))
    .filter(Boolean) as Array<Readonly<{ id: string; title?: string; locationLabel?: string; serverId?: string; serverName?: string }>>;
  return { ok: true, status: 'ok', sessionIds: storedSessionIds, sessions };
}
