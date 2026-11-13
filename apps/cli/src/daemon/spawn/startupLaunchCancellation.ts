import type { ChildExit } from '../sessions/onChildExited';
import type { TrackedSession } from '../types';
import { isPidPresent, probeProcessGroupLiveness } from '@happier-dev/cli-common/process';
import { SessionLaunchRetiredV1Schema } from '@happier-dev/protocol/spawnSession';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { isCurrentTrackedSession, type TrackedSessionMap } from '@/daemon/sessions/sessionTrackingKey';

export type StartupLaunchCancellationResult =
  | Readonly<{ status: 'stopped' }>
  | Readonly<{
      status: 'incomplete';
      reason:
        | 'process_still_running'
        | 'exit_cleanup_incomplete'
        | 'terminal_host_disposition_failed'
        | 'terminal_host_custody_unproven';
    }>;

export type CancelStartupLaunch =
  () => Promise<StartupLaunchCancellationResult>;

export async function completeStartupCancellationCleanup(params: Readonly<{
  trackedSession: TrackedSession;
  /** Captured POSIX launch wrapper, even after custody moves to its runner. */
  wrapperPid?: number;
  trackedSessionsByKey: TrackedSessionMap;
  onChildExited: (pid: number, exit: ChildExit) => void | Promise<void>;
}>): Promise<StartupLaunchCancellationResult> {
  const attemptedPids = new Set<number>();
  const exit: ChildExit = {
    reason: 'startup-cancelled-before-ack',
    code: null,
    signal: 'SIGTERM',
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Terminal disappearance and synthetic exit bookkeeping cannot prove
    // process retirement. Windows launch owners instead prove exact native
    // runner identity/absence before entering cleanup (their pid can be a dispatcher).
    // The detached POSIX wrapper leads its own process group; only ESRCH proves that group gone
    // (EPERM is a group run by an isolated agent user, still present).
    if (process.platform !== 'win32' && (
      (typeof params.wrapperPid === 'number' && probeProcessGroupLiveness(params.wrapperPid) !== 'absent')
      || [params.wrapperPid, params.trackedSession.pid, params.trackedSession.sessionRunnerPid]
        .some(pid => typeof pid === 'number' && pid > 0 && isPidPresent(pid)))) {
      return { status: 'incomplete', reason: 'process_still_running' };
    }
    const currentPid = params.trackedSession.pid;
    if (!isCurrentTrackedSession(params.trackedSessionsByKey, params.trackedSession)) {
      return { status: 'stopped' };
    }
    if (attemptedPids.has(currentPid)) {
      return {
        status: 'incomplete',
        reason: 'exit_cleanup_incomplete',
      };
    }
    attemptedPids.add(currentPid);
    try {
      await params.onChildExited(currentPid, exit);
    } catch {
      return {
        status: 'incomplete',
        reason: 'exit_cleanup_incomplete',
      };
    }
    if (
      ![...params.trackedSessionsByKey.values()].includes(
        params.trackedSession,
      )
    ) {
      return { status: 'stopped' };
    }
  }

  return {
    status: 'incomplete',
    reason: 'exit_cleanup_incomplete',
  };
}

export function resolveSpawnErrorAfterStartupCancellation(
  result: StartupLaunchCancellationResult,
): string | null {
  return result.status === 'stopped'
    ? null
    : `startup_retirement_incomplete:${result.reason}`;
}

/** Called by launch owners only after their physical cancellation and cleanup succeeded. */
export function projectRetiredStartupLaunchResult(params: Readonly<{
  result: SpawnSessionResult;
  readinessFailure: TrackedSession['spawnStartupReadinessFailure'];
  spawnNonce: string | undefined;
  wrapperPid: number;
}>): SpawnSessionResult {
  if (params.result.type !== 'error' || params.result.errorCode !== SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED
    || !params.readinessFailure || !params.spawnNonce) return params.result;
  return { ...params.result, errorDetail: SessionLaunchRetiredV1Schema.parse({ kind: 'launch_retired',
    spawnNonce: params.spawnNonce, wrapperPid: params.wrapperPid }) };
}
