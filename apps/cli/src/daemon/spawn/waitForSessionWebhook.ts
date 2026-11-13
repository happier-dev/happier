import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';

import type { TrackedSession } from '../types';
import type { PersistedTakeoverAdmissionWaitRegistration } from './persistedTakeoverAdmission';
import { DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS } from '@happier-dev/protocol/sessions/creation/sessionSpawnBudget';
import { logger } from '@/ui/logger';
import { buildChildExitBeforeWebhookFailure } from './childStderrDiagnostic';
import { isCurrentTrackedSession, type SessionTrackingKey, type TrackedSessionMap } from '@/daemon/sessions/sessionTrackingKey';

export { DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS };
const SESSION_WEBHOOK_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS';

type WaitForSessionWebhookParams = {
  /** The spawned Session; its waiters are keyed by it. */
  trackingKey: SessionTrackingKey;
  /** Launched process, for diagnostics. */
  pid: number;
  spawnAwaiterByKey: Map<SessionTrackingKey, (session: TrackedSession) => void>;
  spawnResultResolverByKey: Map<SessionTrackingKey, (result: SpawnSessionResult) => void>;
  spawnWebhookTimeoutByKey: Map<SessionTrackingKey, NodeJS.Timeout>;
  trackedSessionsByKey?: TrackedSessionMap;
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

function findRequestTrackedSession(
  params: Pick<WaitForSessionWebhookParams, 'trackedSessionsByKey'>,
  requestTrackedSession: TrackedSession | undefined,
): TrackedSession | null {
  return requestTrackedSession && params.trackedSessionsByKey && isCurrentTrackedSession(params.trackedSessionsByKey, requestTrackedSession)
    ? requestTrackedSession
    : null;
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
      const failure = buildChildExitBeforeWebhookFailure({ pid: completion.getCurrentPid(), ...exit });
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
  const requestTrackedSession = params.trackedSessionsByKey?.get(params.trackingKey);
  let isPending = () => true;
  let settleFailure!: SessionWebhookCompletion['settleFailure'];
  let waitForFinalization = () => Promise.resolve();
  const completion = new Promise<SpawnSessionResult>((resolve) => {
    const requestTrackedSession = params.trackedSessionsByKey?.get(params.trackingKey);
    let settled = false;
    let webhookSession: TrackedSession | null = null;
    const requestResolver = (result: SpawnSessionResult): void => {
      if (settled) return;
      settled = true;
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
      if (params.spawnAwaiterByKey.get(params.trackingKey) === requestAwaiter) {
        params.spawnAwaiterByKey.delete(params.trackingKey);
      }
      if (params.spawnResultResolverByKey.get(params.trackingKey) === requestResolver) {
        params.spawnResultResolverByKey.delete(params.trackingKey);
      }
      if (params.spawnWebhookTimeoutByKey.get(params.trackingKey) === requestTimeout) {
        params.spawnWebhookTimeoutByKey.delete(params.trackingKey);
      }
    };

    params.spawnResultResolverByKey.set(params.trackingKey, requestResolver);

    requestTimeout = setTimeout(() => {
      const stillOwnsTimeout = params.spawnWebhookTimeoutByKey.get(params.trackingKey) === requestTimeout;
      const currentTrackedSession = params.trackedSessionsByKey === undefined
        ? requestTrackedSession ?? null
        : findRequestTrackedSession(params, requestTrackedSession);
      const stillOwnsTrackedSession =
        params.trackedSessionsByKey === undefined
        || currentTrackedSession !== null;
      clearRequestOwnedState();
      if (stillOwnsTimeout && stillOwnsTrackedSession) {
        if (currentTrackedSession) currentTrackedSession.sessionWebhookTimedOutAtMs = Date.now();
        params.onTimeout?.(currentTrackedSession);
      }
      requestResolver({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: params.timeoutErrorMessage,
      });
    }, timeoutMs);

    params.spawnWebhookTimeoutByKey.set(params.trackingKey, requestTimeout);

    requestAwaiter = (completedSession) => {
      if (settled) return;
      if (params.takeoverAdmission && (
        params.spawnResultResolverByKey.get(params.trackingKey) !== requestResolver
        || (params.trackedSessionsByKey !== undefined && findRequestTrackedSession(params, requestTrackedSession) === null)
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
    params.spawnAwaiterByKey.set(params.trackingKey, requestAwaiter);
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
