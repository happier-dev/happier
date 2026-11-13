import type { PersistedTakeoverAdmissionWaitRegistration } from '../spawn/persistedTakeoverAdmission';
import { isPidPresent } from '@happier-dev/cli-common/process';

import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { logger } from '@/ui/logger';
import type { ChildExit } from './onChildExited';
import type { TrackedSession } from '../types';
import { waitForSessionWebhook, type SessionWebhookCompletion } from '../spawn/waitForSessionWebhook';
import { trackedSessionsForProcess, type SessionTrackingKey, type TrackedSessionMap } from '@/daemon/sessions/sessionTrackingKey';

export function waitForVisibleConsoleSessionWebhook(params: Readonly<{
  trackingKey: SessionTrackingKey;
  pid: number;
  pollMs: number;
  spawnAwaiterByKey: Map<SessionTrackingKey, (session: TrackedSession) => void>;
  spawnResultResolverByKey: Map<SessionTrackingKey, (result: SpawnSessionResult) => void>;
  spawnWebhookTimeoutByKey: Map<SessionTrackingKey, ReturnType<typeof setTimeout>>;
  takeoverAdmission?: PersistedTakeoverAdmissionWaitRegistration;
  trackedSessionsByKey?: TrackedSessionMap;
  onChildExited: (pid: number, exit: ChildExit) => void | Promise<void>;
  onSuccess?: (session: TrackedSession) => void | Promise<void>;
}>): SessionWebhookCompletion {
  const { pid, pollMs, spawnAwaiterByKey, spawnResultResolverByKey, spawnWebhookTimeoutByKey, onChildExited } = params;
  let interval: ReturnType<typeof setInterval> | undefined;
  const completion = waitForSessionWebhook({
    trackingKey: params.trackingKey, pid, spawnAwaiterByKey, takeoverAdmission: params.takeoverAdmission,
    spawnResultResolverByKey, spawnWebhookTimeoutByKey,
    trackedSessionsByKey: params.trackedSessionsByKey, onSuccess: params.onSuccess,
    timeoutErrorMessage: `Session webhook timeout for PID ${pid}`,
    onTimeout: () => { if (interval) clearInterval(interval); },
  });
  let exitObserved = false;
  interval = setInterval(() => {
    const currentPid = completion.getCurrentPid();
    // Only proof of absence retires the session. A pid we may not signal is still running, and
    // reporting `process-exited` for it would tear down a live console session.
    if (isPidPresent(currentPid)) return;
    if (exitObserved) return;
    exitObserved = true;
    void (async () => {
      try {
        await onChildExited(currentPid, {
          reason: 'process-missing', code: null, signal: null,
        });
      } catch (error) {
        logger.infoFile('[DAEMON RUN] Visible console process observation could not complete; retaining startup custody', { pid: currentPid, error });
      } finally {
        // The exit owner settles startup custody and transfers or retires tracking.
        // A missing launcher alone is not an observed runner exit.
        if (params.trackedSessionsByKey && trackedSessionsForProcess(params.trackedSessionsByKey, completion.getCurrentPid()).length === 0) {
          if (interval) clearInterval(interval);
        } else {
          exitObserved = false;
        }
      }
    })();
  }, pollMs);
  if (typeof interval.unref === 'function') {
    interval.unref();
  }

  return completion;
}
