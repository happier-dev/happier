import type { Credentials } from '@/persistence';
import { stopDaemonSession } from '@/daemon/controlClient';
import { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import {
  resolveSessionControlStopPollIntervalMs,
  resolveSessionControlStopTimeoutMs,
} from '@/session/transport/shared/sessionTimeouts';
import { delay } from '@/utils/time';

async function waitForSessionStopResult(params: Readonly<{
  token: string;
  sessionId: string;
}>): Promise<boolean> {
  const deadlineMs = Date.now() + resolveSessionControlStopTimeoutMs();

  while (Date.now() <= deadlineMs) {
    const session = await fetchSessionByIdCompat({
      token: params.token,
      sessionId: params.sessionId,
    }).catch(() => null);

    if (session?.active === false) {
      return true;
    }

    if (Date.now() >= deadlineMs) {
      break;
    }

    await delay(resolveSessionControlStopPollIntervalMs());
  }

  return false;
}

export async function requestSessionStop(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
}>): Promise<
  | Readonly<{ ok: true; sessionId: string; stopped: boolean }>
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'unsupported'; candidates?: string[] }>
> {
  const resolved = await resolveSessionIdOrPrefix({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
    };
  }

  try {
    await stopDaemonSession(resolved.sessionId).catch(() => false);
    return {
      ok: true,
      sessionId: resolved.sessionId,
      stopped: await waitForSessionStopResult({
        token: params.credentials.token,
        sessionId: resolved.sessionId,
      }),
    };
  } catch {
    return {
      ok: true,
      sessionId: resolved.sessionId,
      stopped: false,
    };
  }
}
