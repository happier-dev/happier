import {
  checkIfDaemonRunningAndCleanupStaleState,
  inspectDaemonRunningStateAndCleanupStaleState,
  restartAllDaemonSessionRunners,
  stopDaemon,
} from '@/daemon/controlClient';
import type {
  DaemonSessionRunnerRestartMode,
  RestartAllDaemonSessionRunnersResult,
} from '@/daemon/controlClient';
import { spawnDetachedDaemonStartSync } from '@/daemon/runtime/spawnDetachedDaemonStartSync';
import { readDaemonStartWaitPollMs, readDaemonStartWaitTimeoutMs } from '@/daemon/startupWaitDefaults';
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

export type RestartDaemonAndWaitParams = Readonly<{
  stopSessions?: boolean;
  takeover?: boolean;
  restartSessionRunners?: boolean;
  restartSessionRunnersMode?: DaemonSessionRunnerRestartMode;
}>;

export type RestartDaemonAndWaitResult = Readonly<{
  ok: boolean;
  sessionRunnerRestart?: RestartAllDaemonSessionRunnersResult;
}>;

function restartFailed(): RestartDaemonAndWaitResult {
  return { ok: false };
}

export async function restartDaemonAndWait(params: RestartDaemonAndWaitParams = {}): Promise<RestartDaemonAndWaitResult> {
  const previousDaemon = await inspectDaemonRunningStateAndCleanupStaleState();
  const previousIdentityFingerprint = resolveDaemonIdentityFingerprint(previousDaemon);

  let stopSucceeded = true;
  try {
    await stopDaemon({
      stopSessions: params.stopSessions,
      transferManagedLocalServices: params.takeover !== false,
    });
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

  const timeoutMs = readDaemonStartWaitTimeoutMs();
  const pollMs = readDaemonStartWaitPollMs();
  const started = await waitForDaemonRunningWithinBudget({
    isRunning: () => checkIfDaemonRunningAndCleanupStaleState(),
    timeoutMs,
    pollMs,
  });
  if (!started) {
    return restartFailed();
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
    return restartFailed();
  }

  if (previousIdentityFingerprint) {
    const currentIdentityFingerprint = resolveDaemonIdentityFingerprint(stableInspection);
    if (!currentIdentityFingerprint) {
      return restartFailed();
    }
    if (currentIdentityFingerprint === previousIdentityFingerprint) {
      return restartFailed();
    }
  }

  let sessionRunnerRestart: RestartAllDaemonSessionRunnersResult | undefined;
  if (stopSucceeded && params.restartSessionRunners === true) {
    try {
      sessionRunnerRestart = await restartAllDaemonSessionRunners({
        mode: params.restartSessionRunnersMode ?? 'force_current_cli',
        dryRun: false,
        reason: 'daemon_restart_session_runners',
      });
      if (!sessionRunnerRestart.ok || sessionRunnerRestart.failedCount > 0) {
        return {
          ok: false,
          sessionRunnerRestart,
        };
      }
    } catch {
      return restartFailed();
    }
  }

  return {
    ok: stopSucceeded,
    ...(sessionRunnerRestart ? { sessionRunnerRestart } : {}),
  };
}
