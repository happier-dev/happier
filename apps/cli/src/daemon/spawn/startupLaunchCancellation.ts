import type { ChildExit } from '../sessions/onChildExited';
import type { TrackedSession } from '../types';

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
  pidToTrackedSession: Map<number, TrackedSession>;
  onChildExited: (pid: number, exit: ChildExit) => void | Promise<void>;
}>): Promise<StartupLaunchCancellationResult> {
  const attemptedPids = new Set<number>();
  const exit: ChildExit = {
    reason: 'startup-cancelled-before-ack',
    code: null,
    signal: 'SIGTERM',
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const currentPid = params.trackedSession.pid;
    if (
      params.pidToTrackedSession.get(currentPid)
      !== params.trackedSession
    ) {
      return [...params.pidToTrackedSession.values()].includes(
        params.trackedSession,
      )
        ? {
            status: 'incomplete',
            reason: 'exit_cleanup_incomplete',
          }
        : { status: 'stopped' };
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
      ![...params.pidToTrackedSession.values()].includes(
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
