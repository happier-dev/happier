import { getCurrentAuth } from '@/auth/context/AuthContext';
import { storage } from '@/sync/domains/state/storage';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { router } from 'expo-router';
import { resolveVoiceSessionIdFromTitle, resolveVoiceSessionRef } from './sessionReference';
import { setPrimaryActionSessionId } from './sessionTargets';

export async function openSessionForVoiceTool(params: Readonly<{
  sessionId?: string | null;
  sessionTitle?: string | null;
  resolveServerIdForSessionId?: (sessionId: string) => string | null;
  resolveServerNameForSessionId?: (sessionId: string) => string | null;
}>): Promise<
  | Readonly<{ ok: true; status: 'opened'; sessionId: string; session?: Readonly<{ id: string; title?: string; locationLabel?: string; serverId?: string; serverName?: string }> }>
  | Readonly<{ ok: false; status: 'not_found'; error: Readonly<{ code: 'session_not_found'; message: string; sessionTitle: string }> }>
  | Readonly<{ ok: false; status: 'server_switch_failed'; error: Readonly<{ code: 'server_switch_failed'; message: string; serverId: string; serverName: string | null }> }>
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

  const sessionId = resolvedByTitle?.sessionId ?? String(params.sessionId ?? '').trim();
  if (!sessionId) {
    return {
      ok: false,
      status: 'not_found',
      error: {
        code: 'session_not_found',
        message: 'I could not determine which session to open.',
        sessionTitle: String(params.sessionTitle ?? '').trim(),
      },
    };
  }
  const targetServerId = params.resolveServerIdForSessionId ? params.resolveServerIdForSessionId(sessionId) : null;
  const targetServerName = params.resolveServerNameForSessionId ? params.resolveServerNameForSessionId(sessionId) : null;
  if (targetServerId) {
    const active = getActiveServerSnapshot();
    if (String(active.serverId ?? '').trim() !== targetServerId) {
      const auth = getCurrentAuth();
      try {
        const switched = await setActiveServerAndSwitch({
          serverId: targetServerId,
          scope: 'device',
          refreshAuth: auth?.refreshFromActiveServer ?? null,
        });
        if (switched !== true) {
          return {
            ok: false,
            status: 'server_switch_failed',
            error: {
              code: 'server_switch_failed',
              message: 'server_switch_failed',
              serverId: targetServerId,
              serverName: targetServerName,
            },
          };
        }
      } catch {
        return {
          ok: false,
          status: 'server_switch_failed',
          error: {
            code: 'server_switch_failed',
            message: 'server_switch_failed',
            serverId: targetServerId,
            serverName: targetServerName,
          },
        };
      }
    }
  }

  await setPrimaryActionSessionId({ sessionId, updateLastFocused: true });

  try {
    router.navigate(`/session/${sessionId}` as any, {
      dangerouslySingular() {
        return 'session';
      },
    } as any);
  } catch {
    // best-effort
  }

  const session = resolvedByTitle?.session ?? resolveVoiceSessionRef(sessionId, state, {
    serverId: targetServerId,
    serverName: targetServerName,
  });

  return { ok: true, status: 'opened', sessionId, ...(session ? { session } : {}) };
}
