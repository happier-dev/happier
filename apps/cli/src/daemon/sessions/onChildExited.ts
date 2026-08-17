import type { ApiMachineClient } from '@/api/apiMachine';
import { logger } from '@/ui/logger';
import { writeSessionExitReport } from '@/session/diagnostics/sessionExitReport';

import type { TrackedSession } from '../types';
import { removeSessionMarker, updateSessionMarkerActiveTurn } from '../sessionRegistry';
import { cleanupPidSessionResources } from './cleanupPidSessionResources';
import { stageObservedExit } from './stageObservedExit';

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
  shouldPreserveSessionMarkerOnExit?: (input: Readonly<{ pid: number; trackedSession: TrackedSession; exit: ChildExit }>) => boolean;
  onFinalTrackedSessionExitStaged?: (input: Readonly<{
    pid: number;
    trackedSession: TrackedSession;
    exit: ChildExit;
    observedAt: number;
  }>) => Promise<void> | void;
  removeSessionMarkerFn?: typeof removeSessionMarker;
  updateSessionMarkerActiveTurnFn?: typeof updateSessionMarkerActiveTurn;
  stageObservedExitFn?: typeof stageObservedExit;
}>): (pid: number, exit: ChildExit) => Promise<void> {
  const {
    pidToTrackedSession,
    spawnResourceCleanupByPid,
    sessionAttachCleanupByPid,
    getApiMachineForSessions,
    onUnexpectedExit,
    isExitUnexpectedOverride,
    onPidPromoted,
    shouldPreserveSessionMarkerOnExit,
    onFinalTrackedSessionExitStaged,
    removeSessionMarkerFn = removeSessionMarker,
    updateSessionMarkerActiveTurnFn = updateSessionMarkerActiveTurn,
    stageObservedExitFn = stageObservedExit,
  } = params;

  return async (pid: number, exit: ChildExit) => {
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
      void removeSessionMarkerFn(pid).catch((error) => {
        logger.debug('[DAEMON RUN] Failed to remove wrapper marker after promoting tracked session to runner PID', error);
      });
      return;
    }

    if (tracked) {
      const liveReplacement = findLiveReplacementForSameSession(pidToTrackedSession, pid, tracked);
      const shouldReportSessionEnd = liveReplacement === null;
      const isUnexpectedBase =
        exit.reason === 'process-missing' ||
        exit.reason === 'process-reused' ||
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

      const preserveExitedMarker = shouldPreserveSessionMarkerOnExit?.({ pid, trackedSession: tracked, exit }) === true;
      const apiMachineForSessions = getApiMachineForSessions();
      const observedAt = Date.now();
      try {
        await stageObservedExitFn({
          trackedSession: tracked,
          observedAt,
          enqueueExactTurnEnd: async (mutation) => {
            if (!apiMachineForSessions?.enqueueDaemonTerminalExactTurnEnd) {
              throw new Error('Daemon terminal custody is unavailable');
            }
            await apiMachineForSessions.enqueueDaemonTerminalExactTurnEnd(mutation);
          },
          releaseMarkerEvidence: async ({ markerPid, sessionId, turnId }) => {
            const markerPids = Array.from(new Set([pid, markerPid]));
            if (preserveExitedMarker) {
              if (turnId === null) return;
              await Promise.all(markerPids.map(async (candidatePid) => {
                await updateSessionMarkerActiveTurnFn({
                  pid: candidatePid,
                  sessionId,
                  activeTurnId: null,
                });
              }));
              return;
            }
            await Promise.all(markerPids.map(async (candidatePid) => {
              await removeSessionMarkerFn(candidatePid);
            }));
          },
        });
      } catch (error) {
        logger.warn('[DAEMON RUN] Failed to durably stage observed runner exit; retaining marker evidence', {
          sessionId: tracked.happySessionId,
          pid,
          error,
        });
        throw error;
      }
      if (shouldReportSessionEnd && onFinalTrackedSessionExitStaged) {
        try {
          await onFinalTrackedSessionExitStaged({
            pid,
            trackedSession: tracked,
            exit,
            observedAt,
          });
        } catch (error) {
          // The runner exit is already durably staged above; this step only
          // registers the disconnected terminal host as a RECOVERY candidate.
          // Losing that affordance must not un-observe a proven exit: aborting
          // here left the dead pid tracked forever, so every later
          // `stop-session` re-entered this path, could never prove the runner
          // had exited, and the Session became permanently unstoppable — and
          // therefore unswitchable. A host that outlives its runner is still
          // reachable through `stopSession`'s stranded-terminal recovery.
          logger.warn('[DAEMON RUN] Failed to retain terminal-host recovery after observed runner exit; completing the exit lifecycle', {
            sessionId: tracked.happySessionId,
            pid,
            error,
          });
        }
      }
      if (shouldReportSessionEnd && isUnexpected && typeof tracked.happySessionId === 'string' && tracked.happySessionId.trim().length > 0) {
        try {
          onUnexpectedExit?.(tracked, exit);
        } catch (e) {
          logger.debug('[DAEMON RUN] Failed to run onUnexpectedExit handler', e);
        }
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
    await cleanupPidSessionResources({
      pid,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
    });
    pidToTrackedSession.delete(pid);
    if (!tracked) {
      void removeSessionMarkerFn(pid);
    }
  };
}
