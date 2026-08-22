import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';

import type { TrackedSession } from '../types';
import { DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS } from './sessionWebhookTimeoutPolicy';

export { DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS };
const SESSION_WEBHOOK_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS';
const SESSION_WEBHOOK_TIMED_OUT_PID_TOMBSTONE_TTL_MS = 10 * 60_000;

const timedOutSessionWebhookPidTombstones = new Map<number, NodeJS.Timeout>();

type WaitForSessionWebhookParams = {
  pid: number;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
  pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
  pidToTrackedSession?: Map<number, TrackedSession>;
  timeoutMs?: number;
  timeoutErrorMessage: string;
  onTimeout?: (trackedSession: TrackedSession | null) => void;
  onSuccess?: (session: TrackedSession) => void;
};

function resolveTimeoutMs(explicitTimeoutMs: number | undefined): number {
  if (typeof explicitTimeoutMs === 'number' && explicitTimeoutMs > 0) {
    return explicitTimeoutMs;
  }

  const rawEnvValue = String(process.env[SESSION_WEBHOOK_TIMEOUT_ENV_KEY] ?? '').trim();
  if (!rawEnvValue) {
    return DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(rawEnvValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS;
  }

  return parsed;
}

export function markSessionWebhookPidTimedOut(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const previous = timedOutSessionWebhookPidTombstones.get(pid);
  if (previous) {
    clearTimeout(previous);
  }
  const timeout = setTimeout(() => {
    timedOutSessionWebhookPidTombstones.delete(pid);
  }, SESSION_WEBHOOK_TIMED_OUT_PID_TOMBSTONE_TTL_MS);
  timeout.unref?.();
  timedOutSessionWebhookPidTombstones.set(pid, timeout);
}

export function hasSessionWebhookPidTimedOut(pid: number): boolean {
  return timedOutSessionWebhookPidTombstones.has(pid);
}

function findRequestTrackedSession(
  params: Pick<WaitForSessionWebhookParams, 'pid' | 'pidToTrackedSession'>,
  requestTrackedSession: TrackedSession | undefined,
): TrackedSession | null {
  const direct = params.pidToTrackedSession?.get(params.pid);
  if (direct === requestTrackedSession) return direct ?? null;
  if (
    requestTrackedSession
    && params.pidToTrackedSession?.get(requestTrackedSession.pid)
      === requestTrackedSession
  ) {
    return requestTrackedSession;
  }
  return null;
}

export function tombstoneTrackedSessionWebhookPids(
  requestPid: number,
  tracked: TrackedSession | null,
): void {
  if (!tracked) return;
  markSessionWebhookPidTimedOut(requestPid);
  if (tracked.pid !== requestPid) {
    markSessionWebhookPidTimedOut(tracked.pid);
  }
  if (
    typeof tracked.sessionRunnerPid === 'number'
    && tracked.sessionRunnerPid > 0
    && tracked.sessionRunnerPid !== requestPid
    && tracked.sessionRunnerPid !== tracked.pid
  ) {
    markSessionWebhookPidTimedOut(tracked.sessionRunnerPid);
  }
}

function markTrackedSessionWebhookTimedOut(
  params: Pick<WaitForSessionWebhookParams, 'pid'>,
  tracked: TrackedSession | null,
): void {
  if (!tracked) return;
  tracked.sessionWebhookTimedOutAtMs = Date.now();
  tombstoneTrackedSessionWebhookPids(params.pid, tracked);
}

export function waitForSessionWebhook(
  params: WaitForSessionWebhookParams,
): Promise<SpawnSessionResult> {
  const timeoutMs = resolveTimeoutMs(params.timeoutMs);

  return new Promise((resolve) => {
    const requestTrackedSession = params.pidToTrackedSession?.get(params.pid);
    const requestResolver = resolve;
    let requestAwaiter!: (session: TrackedSession) => void;
    let requestTimeout!: NodeJS.Timeout;
    const clearRequestOwnedState = () => {
      if (params.pidToAwaiter.get(params.pid) === requestAwaiter) {
        params.pidToAwaiter.delete(params.pid);
      }
      if (params.pidToSpawnResultResolver.get(params.pid) === requestResolver) {
        params.pidToSpawnResultResolver.delete(params.pid);
      }
      if (params.pidToSpawnWebhookTimeout.get(params.pid) === requestTimeout) {
        params.pidToSpawnWebhookTimeout.delete(params.pid);
      }
    };

    params.pidToSpawnResultResolver.set(params.pid, requestResolver);

    requestTimeout = setTimeout(() => {
      const stillOwnsTimeout = params.pidToSpawnWebhookTimeout.get(params.pid) === requestTimeout;
      const currentTrackedSession = params.pidToTrackedSession === undefined
        ? requestTrackedSession ?? null
        : findRequestTrackedSession(params, requestTrackedSession);
      const stillOwnsTrackedSession =
        params.pidToTrackedSession === undefined
        || currentTrackedSession !== null;
      clearRequestOwnedState();
      if (stillOwnsTimeout && stillOwnsTrackedSession) {
        markTrackedSessionWebhookTimedOut(params, currentTrackedSession);
        params.onTimeout?.(currentTrackedSession);
      }
      resolve({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: params.timeoutErrorMessage,
      });
    }, timeoutMs);

    params.pidToSpawnWebhookTimeout.set(params.pid, requestTimeout);

    requestAwaiter = (completedSession) => {
      clearTimeout(requestTimeout);
      clearRequestOwnedState();
      if (completedSession.spawnStartupReadinessFailure) {
        resolve(completedSession.spawnStartupReadinessFailure);
        return;
      }
      const sessionId =
        typeof completedSession.happySessionId === 'string' ? completedSession.happySessionId.trim() : '';
      if (!sessionId) {
        resolve({
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
          errorMessage: `Session webhook did not include a sessionId (pid=${params.pid})`,
        });
        return;
      }
      params.onSuccess?.(completedSession);
      resolve({
        type: 'success',
        sessionId,
        ...(completedSession.sessionCreationOutcome
          ? { sessionCreationOutcome: completedSession.sessionCreationOutcome }
          : {}),
      });
    };
    params.pidToAwaiter.set(params.pid, requestAwaiter);
  });
}
