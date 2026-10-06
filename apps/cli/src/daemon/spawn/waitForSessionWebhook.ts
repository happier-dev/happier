import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';

import type { TrackedSession } from '../types';
import type { PersistedTakeoverAdmissionWaitRegistration } from './persistedTakeoverAdmission';
import { DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS } from '@happier-dev/protocol/sessions/creation/sessionSpawnBudget';
import { logger } from '@/ui/logger';

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
  takeoverAdmission?: PersistedTakeoverAdmissionWaitRegistration;
  timeoutErrorMessage: string;
  onTimeout?: (trackedSession: TrackedSession | null) => void;
  onSuccess?: (session: TrackedSession) => void | Promise<void>;
};

export function resolveSessionStartupTimeoutMs(explicitTimeoutMs?: number): number {
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

export type SessionWebhookCompletion = Promise<SpawnSessionResult> & Readonly<{
  getCurrentPid: () => number;
  isPending: () => boolean;
  settleFailure: (failure: Extract<SpawnSessionResult, { type: 'error' }>) => void;
  waitForFinalization: () => Promise<void>;
}>;

export function armSessionWebhookStartupCustody(
  tracked: TrackedSession,
  completion: SessionWebhookCompletion,
  registration: Promise<void>,
): void {
  const custody: NonNullable<TrackedSession['startupCustody']> = {
    finalization: registration.catch(() => {
      completion.settleFailure({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorMessage: 'Daemon spawn custody was not accepted' });
    }).then(async () => {
      await completion;
      await completion.waitForFinalization();
    }).catch(() => {
      logger.infoFile('[DAEMON RUN] Warning: startup finalization did not complete', { pid: completion.getCurrentPid() });
    }),
    observeExit: (exit) => {
      if (!completion.isPending()) return;
      const failure: Extract<SpawnSessionResult, { type: 'error' }> = {
        type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
        errorMessage: `Child process exited before session webhook (pid=${completion.getCurrentPid()}, reason=${exit.reason})`,
      };
      tracked.spawnStartupReadinessFailure ??= failure;
      completion.settleFailure(failure);
    },
  };
  tracked.startupCustody = custody;
  void custody.finalization.then(() => {
    if (tracked.startupCustody === custody) delete tracked.startupCustody;
  });
}

export function waitForSessionWebhook(
  params: WaitForSessionWebhookParams,
): SessionWebhookCompletion {
  const timeoutMs = resolveSessionStartupTimeoutMs(params.timeoutMs);
  const requestTrackedSession = params.pidToTrackedSession?.get(params.pid);
  let isPending = () => true;
  let settleFailure!: SessionWebhookCompletion['settleFailure'];
  let waitForFinalization = () => Promise.resolve();
  const completion = new Promise<SpawnSessionResult>((resolve) => {
    const requestTrackedSession = params.pidToTrackedSession?.get(params.pid);
    let settled = false;
    let webhookSession: TrackedSession | null = null;
    const requestResolver = (result: SpawnSessionResult): void => {
      if (settled) return;
      settled = true;
      if (requestTrackedSession?.spawnStartupAwaiterPid === params.pid) {
        delete requestTrackedSession.spawnStartupAwaiterPid;
      }
      clearTimeout(requestTimeout);
      clearRequestOwnedState();
      if (result.type !== 'success') params.takeoverAdmission?.cancel();
      resolve(result);
    };
    let requestAwaiter!: (session: TrackedSession) => void;
    let successFinalization: Promise<void> | null = null;
    isPending = () => !settled;
    settleFailure = requestResolver;
    waitForFinalization = () => successFinalization ?? Promise.resolve();
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
      requestResolver({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: params.timeoutErrorMessage,
      });
    }, timeoutMs);

    params.pidToSpawnWebhookTimeout.set(params.pid, requestTimeout);

    requestAwaiter = (completedSession) => {
      if (settled) return;
      if (params.takeoverAdmission && (
        params.pidToSpawnResultResolver.get(params.pid) !== requestResolver
        || (params.pidToTrackedSession !== undefined && findRequestTrackedSession(params, requestTrackedSession) === null)
      )) {
        requestResolver({
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
          errorMessage: 'Takeover startup process custody changed',
        });
        return;
      }
      if (completedSession.spawnStartupReadinessFailure) {
        requestResolver(completedSession.spawnStartupReadinessFailure);
        return;
      }
      const sessionId =
        typeof completedSession.happySessionId === 'string' ? completedSession.happySessionId.trim() : '';
      if (!sessionId) {
        requestResolver({
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
          errorMessage: `Session webhook did not include a sessionId (pid=${params.pid})`,
        });
        return;
      }
      webhookSession = completedSession;
      if (params.takeoverAdmission && params.takeoverAdmission.readOutcome()?.status !== 'committed') return;
      successFinalization ??= Promise.resolve().then(async () => {
        await params.onSuccess?.(completedSession);
      });
      const complete = successFinalization.then(() => {
        if (settled) return;
        requestResolver({
          type: 'success',
          sessionId,
          ...(completedSession.sessionCreationOutcome
            ? { sessionCreationOutcome: completedSession.sessionCreationOutcome }
            : {}),
        });
      }, (error: unknown) => {
        requestResolver({
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
      // Takeover webhook acknowledgement must remain independent from the
      // later runtime-bound admission. Ordinary spawns return this promise so
      // their report cannot race canonical attachment finalization.
      if (params.takeoverAdmission) {
        void complete;
        return;
      }
      return complete;
    };
    params.pidToAwaiter.set(params.pid, requestAwaiter);
    void params.takeoverAdmission?.outcome.then((outcome) => {
      if (settled) return;
      if (outcome.status === 'failed') {
        const failure: Extract<SpawnSessionResult, { type: 'error' }> = {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
          errorMessage: 'Takeover runtime admission did not complete',
        };
        const tracked = findRequestTrackedSession(params, requestTrackedSession);
        if (tracked) tracked.spawnStartupReadinessFailure = failure;
        requestResolver(failure);
      } else if (webhookSession) {
        requestAwaiter(webhookSession);
      }
    });
  });
  return Object.assign(completion, {
    getCurrentPid: () => requestTrackedSession?.pid ?? params.pid,
    isPending: () => isPending(),
    settleFailure: (failure: Extract<SpawnSessionResult, { type: 'error' }>) => settleFailure(failure),
    waitForFinalization: () => waitForFinalization(),
  });
}
