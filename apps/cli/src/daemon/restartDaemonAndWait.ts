import {
  checkIfDaemonRunningAndCleanupStaleState,
  inspectDaemonRunningStateAndCleanupStaleState,
  stopDaemon,
} from '@/daemon/controlClient';
import { spawnDetachedDaemonStartSync } from '@/daemon/runtime/spawnDetachedDaemonStartSync';
import { waitForDaemonRunningWithinBudget } from '@/daemon/waitForDaemonRunningWithinBudget';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';

const DEFAULT_DAEMON_RESTART_STABILITY_TIMEOUT_MS = 2_000;

function resolveDaemonIdentityFingerprint(
  inspection: Awaited<ReturnType<typeof inspectDaemonRunningStateAndCleanupStaleState>>,
): string | null {
  if (inspection.status !== 'running') {
    return null;
  }

  const { state } = inspection;
  return [
    state.pid,
    state.startedAt ?? '',
    state.httpPort ?? '',
    state.controlToken ?? '',
    state.startedWithCliVersion ?? '',
    state.startedWithPublicReleaseChannel ?? '',
  ].join('|');
}

export async function restartDaemonAndWait(
  params: Readonly<{ stopSessions?: boolean; takeover?: boolean }> = {},
): Promise<boolean> {
  const previousDaemon = await inspectDaemonRunningStateAndCleanupStaleState();
  const previousIdentityFingerprint = resolveDaemonIdentityFingerprint(previousDaemon);

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
  if (!started) {
    return false;
  }

  const stabilityTimeoutMs = readPositiveIntEnv(
    'HAPPIER_DAEMON_RESTART_STABILITY_TIMEOUT_MS',
    DEFAULT_DAEMON_RESTART_STABILITY_TIMEOUT_MS,
  );
  if (stabilityTimeoutMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, stabilityTimeoutMs)));
  }

  const stableInspection = await inspectDaemonRunningStateAndCleanupStaleState();
  if (stableInspection.status !== 'running') {
    return false;
  }

  if (previousIdentityFingerprint) {
    const currentIdentityFingerprint = resolveDaemonIdentityFingerprint(stableInspection);
    if (!currentIdentityFingerprint) {
      return false;
    }
    if (currentIdentityFingerprint === previousIdentityFingerprint) {
      return false;
    }
  }

  return stopSucceeded;
}
