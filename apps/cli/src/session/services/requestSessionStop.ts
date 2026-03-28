import type { Credentials } from '@/persistence';
import { stopDaemonSession } from '@/daemon/controlClient';
import { listSessionMarkers, removeSessionMarker } from '@/daemon/sessionRegistry';
import { createStopSession } from '@/daemon/sessions/stopSession';
import type { TrackedSession } from '@/daemon/types';
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

async function stopSessionViaMarkersBestEffort(sessionId: string): Promise<boolean> {
  const markers = (await listSessionMarkers()).filter((marker) => marker.happySessionId === sessionId);
  if (markers.length === 0) {
    return false;
  }

  const pidToTrackedSession = new Map<number, TrackedSession>(
    markers.map((marker) => [
      marker.pid,
      {
        startedBy: marker.startedBy ?? 'terminal',
        happySessionId: marker.happySessionId,
        pid: marker.pid,
        ...(typeof marker.processCommandHash === 'string' ? { processCommandHash: marker.processCommandHash } : {}),
      },
    ]),
  );

  return await createStopSession({ pidToTrackedSession })(sessionId);
}

async function cleanupStoppedSessionMarkersBestEffort(sessionId: string): Promise<void> {
  const markers = await listSessionMarkers();
  await Promise.all(
    markers
      .filter((marker) => marker.happySessionId === sessionId)
      .map((marker) => removeSessionMarker(marker.pid).catch(() => undefined)),
  );
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
    const daemonStopped = await stopDaemonSession(resolved.sessionId).catch(() => false);
    if (!daemonStopped) {
      await stopSessionViaMarkersBestEffort(resolved.sessionId).catch(() => false);
    }
    const stopped = await waitForSessionStopResult({
      token: params.credentials.token,
      sessionId: resolved.sessionId,
    });
    if (stopped) {
      await cleanupStoppedSessionMarkersBestEffort(resolved.sessionId).catch(() => undefined);
    }
    return {
      ok: true,
      sessionId: resolved.sessionId,
      stopped,
    };
  } catch {
    return {
      ok: true,
      sessionId: resolved.sessionId,
      stopped: false,
    };
  }
}
