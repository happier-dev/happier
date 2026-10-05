import { getCurrentAuth } from '@/auth/context/currentAuth';
import { storage } from '@/sync/domains/state/storage';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { router } from 'expo-router';
import { resolveVoiceSessionReference, resolveVoiceSessionRef, type VoiceSessionCandidate } from './sessionReference';
import { setPrimaryActionSessionId } from './sessionTargets';
import { Platform } from 'react-native';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { VoiceSessionCorpusOptions } from './voiceSessionRows';

export async function openSessionForVoiceTool(params: Readonly<{
  sessionId?: string | null;
  serverId?: string | null;
  sessionTitle?: string | null;
  query?: Readonly<Record<string, string>>;
  corpus?: VoiceSessionCorpusOptions;
  resolveServerIdForSessionId?: (sessionId: string) => string | null;
  resolveServerNameForSessionId?: (sessionId: string) => string | null;
}>): Promise<
  | Readonly<{ ok: true; status: 'opened'; sessionId: string; serverId: string; address: SessionAddress; session?: VoiceSessionCandidate }>
  | Readonly<{ ok: false; status: 'not_found'; error: Readonly<{ code: 'session_not_found'; message: string; sessionTitle: string }> }>
  | Readonly<{ ok: false; status: 'ambiguous'; error: Readonly<{ code: 'session_ambiguous'; message: string; candidates: readonly VoiceSessionCandidate[] }> }>
  | Readonly<{ ok: false; status: 'incomplete'; error: Readonly<{ code: 'session_lookup_incomplete'; message: string }> }>
  | Readonly<{ ok: false; status: 'server_switch_failed'; error: Readonly<{ code: 'server_switch_failed'; message: string; serverId: string; serverName: string | null }> }>
> {
  const state = storage.getState();
  const active = getActiveServerSnapshot();
  const titleResolution = params.sessionTitle
    ? resolveVoiceSessionReference(
        { serverId: params.serverId, sessionTitle: params.sessionTitle },
        state,
        params.corpus ?? { coverage: 'incomplete' },
      )
    : null;
  if (titleResolution?.kind === 'ambiguous') {
    return {
      ok: false,
      status: 'ambiguous',
      error: {
        code: 'session_ambiguous',
        message: 'More than one session matches. Choose a Home or session.',
        candidates: titleResolution.candidates,
      },
    };
  }
  if (titleResolution?.kind === 'incomplete') {
    return {
      ok: false,
      status: 'incomplete',
      error: {
        code: 'session_lookup_incomplete',
        message: 'One or more selected Homes are unavailable, so I cannot verify this session is unique.',
      },
    };
  }
  if (titleResolution?.kind === 'none') {
    const sessionTitle = String(params.sessionTitle).trim();
    return {
      ok: false,
      status: 'not_found',
      error: {
        code: 'session_not_found',
        message: `I could not find a session titled "${sessionTitle}".`,
        sessionTitle,
      },
    };
  }
  const sessionId = titleResolution?.kind === 'unique'
    ? titleResolution.address.sessionId
    : String(params.sessionId ?? '').trim();
  const callbackServerId = sessionId && params.resolveServerIdForSessionId
    ? params.resolveServerIdForSessionId(sessionId)
    : null;
  const exactAddress = titleResolution?.kind === 'unique'
    ? titleResolution.address
    : normalizeSessionAddress(params.serverId ?? callbackServerId, sessionId);
  const candidate = exactAddress
    ? resolveVoiceSessionRef(exactAddress, state)
    : resolveVoiceSessionRef(sessionId, state, { activeServerId: active.serverId });
  const address = exactAddress ?? candidate?.address ?? null;
  if (!address) {
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
  const targetServerId = address.serverId;
  const targetServerName = params.resolveServerNameForSessionId ? params.resolveServerNameForSessionId(sessionId) : null;
  if (targetServerId) {
    if (String(active.serverId ?? '').trim() !== targetServerId) {
      const auth = getCurrentAuth();
      try {
        const switched = await setActiveServerAndSwitch({
          serverId: targetServerId,
          scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
          refreshAuth: auth?.refreshFromActiveServer ?? null,
        });
        if (switched === 'blocked') {
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

  await setPrimaryActionSessionId({ sessionId, serverId: address.serverId, updateLastFocused: true });

  try {
    router.navigate(buildScopedSessionRouteHref({ ...address, query: params.query }) as any, {
      dangerouslySingular() {
        return 'session';
      },
    } as any);
  } catch {
    // best-effort
  }

  const session = titleResolution?.kind === 'unique'
    ? titleResolution.candidate
    : candidate ?? resolveVoiceSessionRef(address, state, { serverName: targetServerName });

  return {
    ok: true,
    status: 'opened',
    sessionId,
    serverId: address.serverId,
    address,
    ...(session ? { session } : {}),
  };
}
