import { checkIfDaemonRunningAndCleanupStaleState, stopDaemon } from '@/daemon/controlClient';
import { spawnDetachedDaemonStartSync } from '@/daemon/runtime/spawnDetachedDaemonStartSync';
import { waitForDaemonRunningWithinBudget } from '@/daemon/waitForDaemonRunningWithinBudget';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';

export async function restartDaemonAndWait(
  params: Readonly<{ stopSessions?: boolean; takeover?: boolean }> = {},
): Promise<boolean> {
  let stopSucceeded = true;
  try {
    await stopDaemon({ stopSessions: params.stopSessions });
  } catch {
    // best-effort; restart should still attempt to start even if the daemon wasn't running
    stopSucceeded = false;
  }

  const child = await spawnDetachedDaemonStartSync({
    startupSource: 'self-restart',
    ...(params.takeover === false
      ? null
      : {
        env: {
          ...process.env,
          HAPPIER_DAEMON_TAKEOVER: '1',
        },
      }),
  });
  child.unref();

  const timeoutMs = readPositiveIntEnv('HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS', 5000);
  const pollMs = readPositiveIntEnv('HAPPIER_DAEMON_START_WAIT_POLL_MS', 100);
  const started = await waitForDaemonRunningWithinBudget({
    isRunning: () => checkIfDaemonRunningAndCleanupStaleState(),
    timeoutMs,
    pollMs,
  });
  return stopSucceeded && started;
}
