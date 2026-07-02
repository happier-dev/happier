import type { ApiMachineClient } from '@/api/apiMachine';
import { logger } from '@/ui/logger';
import { writeSessionExitReport } from '@/daemon/sessionExitReport';

import type { TrackedSession } from '../types';
import { reportDaemonObservedSessionExit, settleDaemonObservedOpenTurn } from '../sessionTermination';
import { promoteSessionMarkerPid, removeSessionMarker } from '../sessionRegistry';
import { cleanupPidSessionResources } from './cleanupPidSessionResources';

export type ChildExit = { reason: string; code: number | null; signal: string | null };

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isTrackedSessionAlive(tracked: TrackedSession): boolean {
  if (isPidAlive(tracked.pid)) return true;
  const runnerPid = tracked.sessionRunnerPid;
  return typeof runnerPid === 'number' && runnerPid !== tracked.pid && isPidAlive(runnerPid);
}

function findLiveReplacementForSameSession(
  pidToTrackedSession: Map<number, TrackedSession>,
  pid: number,
  tracked: TrackedSession,
): TrackedSession | null {
  const sessionId = normalizeSessionId(tracked.happySessionId);
  if (!sessionId) return null;

  for (const [candidatePid, candidate] of pidToTrackedSession.entries()) {
    if (candidatePid === pid) continue;
    if (normalizeSessionId(candidate.happySessionId) !== sessionId) continue;
    if (isTrackedSessionAlive(candidate)) return candidate;
  }

  return null;
}

export function createOnChildExited(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  spawnResourceCleanupByPid: Map<number, () => void>;
  sessionAttachCleanupByPid: Map<number, () => Promise<void>>;
  getApiMachineForSessions: () => ApiMachineClient | null;
  onUnexpectedExit?: (trackedSession: TrackedSession, exit: ChildExit) => void;
  isExitUnexpectedOverride?: (trackedSession: TrackedSession, exit: ChildExit) => boolean | null | undefined;
  onPidPromoted?: (input: Readonly<{ fromPid: number; toPid: number; trackedSession: TrackedSession }>) => void;
  removeSessionMarkerFn?: typeof removeSessionMarker;
  promoteSessionMarkerFn?: typeof promoteSessionMarkerPid;
}>): (pid: number, exit: ChildExit) => void {
  const {
    pidToTrackedSession,
    spawnResourceCleanupByPid,
    sessionAttachCleanupByPid,
    getApiMachineForSessions,
    onUnexpectedExit,
    isExitUnexpectedOverride,
    onPidPromoted,
    removeSessionMarkerFn = removeSessionMarker,
    promoteSessionMarkerFn = promoteSessionMarkerPid,
  } = params;

  return (pid: number, exit: ChildExit) => {
    logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
    const tracked = pidToTrackedSession.get(pid);
    const runnerPid = tracked?.sessionRunnerPid;
    const override = tracked && isExitUnexpectedOverride ? isExitUnexpectedOverride(tracked, exit) : null;
    if (tracked && typeof runnerPid === 'number' && runnerPid !== pid && isPidAlive(runnerPid)) {
      logger.debug(`[DAEMON RUN] Wrapper PID ${pid} exited; promoting tracked session to runner PID ${runnerPid}`);
      const spawnCleanup = spawnResourceCleanupByPid.get(pid);
      if (spawnCleanup) {
        spawnResourceCleanupByPid.delete(pid);
        spawnResourceCleanupByPid.set(runnerPid, spawnCleanup);
      }
      const attachCleanup = sessionAttachCleanupByPid.get(pid);
      if (attachCleanup) {
        sessionAttachCleanupByPid.delete(pid);
        sessionAttachCleanupByPid.set(runnerPid, attachCleanup);
      }
      pidToTrackedSession.delete(pid);
      const promoted = {
        ...tracked,
        pid: runnerPid,
        sessionRunnerPid: undefined,
        childProcess: undefined,
      };
      pidToTrackedSession.set(runnerPid, promoted);
      onPidPromoted?.({ fromPid: pid, toPid: runnerPid, trackedSession: promoted });
      void promoteSessionMarkerFn(pid, runnerPid).catch((error) => {
        logger.debug('[DAEMON RUN] Failed to promote session marker to runner PID', error);
      });
      void removeSessionMarkerFn(pid);
      return;
    }

    if (tracked) {
      const liveReplacement = findLiveReplacementForSameSession(pidToTrackedSession, pid, tracked);
      const shouldReportSessionEnd = liveReplacement === null;
      const isUnexpectedBase =
        exit.reason === 'process-missing' ||
        exit.reason === 'process-error' ||
        (typeof exit.code === 'number' && exit.code !== 0) ||
        (typeof exit.signal === 'string' && exit.signal.length > 0 && !['SIGTERM', 'SIGINT'].includes(exit.signal));
      const isUnexpected = typeof override === 'boolean' ? override : isUnexpectedBase;

      if (liveReplacement) {
        logger.debug('[DAEMON RUN] Skipping session-end for exited PID because another live PID owns the same session', {
          sessionId: tracked.happySessionId,
          exitedPid: pid,
          livePid: liveReplacement.pid,
        });
      }

      if (shouldReportSessionEnd && isUnexpected && typeof tracked.happySessionId === 'string' && tracked.happySessionId.trim().length > 0) {
        try {
          onUnexpectedExit?.(tracked, exit);
        } catch (e) {
          logger.debug('[DAEMON RUN] Failed to run onUnexpectedExit handler', e);
        }
      }

      const apiMachineForSessions = getApiMachineForSessions();
      if (apiMachineForSessions) {
        // Settle the dead runner's open canonical turn even when a live replacement exists
        // (the case where the full session-end below is skipped). Without this, a respawn-kill
        // (e.g. usage-limit account switch) leaves the turn 'in_progress' forever and the UI
        // stuck "working" until the next prompt.
        settleDaemonObservedOpenTurn({
          apiMachine: apiMachineForSessions,
          trackedSession: tracked,
          now: () => Date.now(),
        });
      }
      if (shouldReportSessionEnd && apiMachineForSessions) {
        reportDaemonObservedSessionExit({
          apiMachine: apiMachineForSessions,
          trackedSession: tracked,
          now: () => Date.now(),
          exit,
        });
      }
      void writeSessionExitReport({
        sessionId: tracked.happySessionId ?? null,
        pid,
        report: {
          observedAt: Date.now(),
          observedBy: 'daemon',
          reason: exit.reason,
          code: exit.code,
          signal: exit.signal,
        },
      }).catch((e) => logger.debug('[DAEMON RUN] Failed to write session exit report', e));
    }
    void cleanupPidSessionResources({
      pid,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
    });
    pidToTrackedSession.delete(pid);
    void removeSessionMarkerFn(pid);
    if (typeof runnerPid === 'number' && runnerPid !== pid) {
      void removeSessionMarkerFn(runnerPid);
    }
  };
}
