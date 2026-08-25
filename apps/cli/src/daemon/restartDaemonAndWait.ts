import {
  checkIfDaemonRunningAndCleanupStaleState,
  inspectDaemonRunningStateAndCleanupStaleState,
  restartAllDaemonSessionRunners,
  stopDaemon,
} from '@/daemon/controlClient';
import type {
  DaemonRunningInspection,
  DaemonSessionRunnerRestartMode,
  RestartAllDaemonSessionRunnersResult,
} from '@/daemon/controlClient';
import { spawnDetachedDaemonStartSync } from '@/daemon/runtime/spawnDetachedDaemonStartSync';
import { readDaemonStartWaitPollMs, readDaemonStartWaitTimeoutMs } from '@/daemon/startupWaitDefaults';
import {
  hasObservableDaemonStartProcessExited,
  waitForDaemonRunningWithinBudget,
} from '@/daemon/waitForDaemonRunningWithinBudget';
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

/** Which half of the restart did not complete. */
export type DaemonRestartFailedPhase = 'stop' | 'start' | 'session-runners';

/** The daemon lifecycle state observed at the moment the restart gave up. */
export type DaemonRestartObservedDaemonStatus = DaemonRunningInspection['status'];

export type RestartDaemonAndWaitFailure = Readonly<{
  ok: false;
  failedPhase: DaemonRestartFailedPhase;
  daemonStatusAfterFailure: DaemonRestartObservedDaemonStatus;
  sessionRunnerRestart?: RestartAllDaemonSessionRunnersResult;
}>;

export type RestartDaemonAndWaitResult =
  | Readonly<{ ok: true; sessionRunnerRestart?: RestartAllDaemonSessionRunnersResult }>
  | RestartDaemonAndWaitFailure;

async function observeDaemonStatus(): Promise<DaemonRestartObservedDaemonStatus> {
  try {
    return (await inspectDaemonRunningStateAndCleanupStaleState()).status;
  } catch {
    // The lifecycle state could not be read at all, which is not evidence of a running daemon.
    return 'not-running';
  }
}

/**
 * A restart tears the previous daemon down before it can prove the replacement is up, so a failure
 * can leave the machine with no daemon at all. The failure therefore has to carry the phase that
 * failed and the state the command is leaving behind; a bare `ok: false` reads as "nothing happened"
 * and is what left an operator daemonless without being told (`F-DAEMON-6`).
 */
async function restartFailed(params: Readonly<{
  failedPhase: DaemonRestartFailedPhase;
  observedStatus?: DaemonRestartObservedDaemonStatus;
  sessionRunnerRestart?: RestartAllDaemonSessionRunnersResult;
}>): Promise<RestartDaemonAndWaitFailure> {
  return {
    ok: false,
    failedPhase: params.failedPhase,
    daemonStatusAfterFailure: params.observedStatus ?? await observeDaemonStatus(),
    ...(params.sessionRunnerRestart ? { sessionRunnerRestart: params.sessionRunnerRestart } : {}),
  };
}

export async function restartDaemonAndWait(params: RestartDaemonAndWaitParams = {}): Promise<RestartDaemonAndWaitResult> {
  const previousDaemon = await inspectDaemonRunningStateAndCleanupStaleState();
  const previousIdentityFingerprint = resolveDaemonIdentityFingerprint(previousDaemon);

  let stopSucceeded = true;
  try {
    await stopDaemon({
      stopSessions: params.stopSessions,
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
    shouldAbort: () => hasObservableDaemonStartProcessExited(child),
    timeoutMs,
    pollMs,
  });
  if (!started) {
    return await restartFailed({ failedPhase: 'start' });
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
    return await restartFailed({ failedPhase: 'start', observedStatus: stableInspection.status });
  }

  if (previousIdentityFingerprint) {
    const currentIdentityFingerprint = resolveDaemonIdentityFingerprint(stableInspection);
    // A daemon is running, but it is still the previous one: the replacement never took over.
    if (!currentIdentityFingerprint || currentIdentityFingerprint === previousIdentityFingerprint) {
      return await restartFailed({ failedPhase: 'start', observedStatus: stableInspection.status });
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
        return await restartFailed({
          failedPhase: 'session-runners',
          observedStatus: stableInspection.status,
          sessionRunnerRestart,
        });
      }
    } catch {
      return await restartFailed({ failedPhase: 'session-runners', observedStatus: stableInspection.status });
    }
  }

  if (!stopSucceeded) {
    // The replacement daemon is proven running and distinct; only the previous daemon's stop could
    // not be confirmed. Reporting that as a bare restart failure hid a healthy daemon from the user.
    return await restartFailed({ failedPhase: 'stop', observedStatus: stableInspection.status });
  }

  return {
    ok: true,
    ...(sessionRunnerRestart ? { sessionRunnerRestart } : {}),
  };
}
