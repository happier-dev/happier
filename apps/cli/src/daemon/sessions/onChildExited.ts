import type { ApiMachineClient } from '@/api/apiMachine';
import { logger } from '@/ui/logger';
import { writeSessionExitReport } from '@/session/diagnostics/sessionExitReport';

import type { TrackedSession } from '../types';
import {
  hashProcessCommand,
  promoteSessionMarkerPid,
  removeSessionMarker,
  removeSessionMarkerIfOwned,
  type SessionMarkerOwnership,
  updateSessionMarkerActiveTurn,
} from '../sessionRegistry';
import { cleanupPidSessionResources } from './cleanupPidSessionResources';
import { promoteTrackedSessionPidCustody } from './promoteTrackedSessionPidCustody';
import { resolveTrackedSessionExitSettlementEvidence } from './resolveTrackedSessionExitSettlementEvidence';
import { stageObservedExit } from './stageObservedExit';

export type ChildExit = {
  reason: string;
  code: number | null;
  signal: string | null;
  stderrTail?: string | null;
};

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

function resolveTrackedMarkerOwnership(tracked: TrackedSession): Readonly<{
  happySessionId: string;
  processCommandHash?: string;
  processStartTimeMs?: number;
}> {
  const happySessionId = normalizeSessionId(tracked.happySessionId) || `PID-${tracked.pid}`;
  if (tracked.processCommandHash) {
    return {
      happySessionId,
      processCommandHash: tracked.processCommandHash,
      ...(tracked.processStartTimeMs !== undefined
        ? { processStartTimeMs: tracked.processStartTimeMs }
        : {}),
    };
  }
  const processCommand = normalizeSessionId(tracked.processCommand)
    || tracked.childProcess?.spawnargs
      ?.filter((arg): arg is string => typeof arg === 'string' && arg.trim().length > 0)
      .join(' ')
      .trim()
    || '';
  return processCommand
    ? {
        happySessionId,
        processCommandHash: hashProcessCommand(processCommand),
        ...(tracked.processStartTimeMs !== undefined
          ? { processStartTimeMs: tracked.processStartTimeMs }
          : {}),
      }
    : { happySessionId };
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
  spawnResourceCleanupByPid: Map<number, () => void | Promise<void>>;
  sessionAttachCleanupByPid: Map<number, () => Promise<void>>;
  getApiMachineForSessions: () => ApiMachineClient | null;
  beforeUnexpectedExitSettlement?: (
    trackedSession: TrackedSession,
    exit: ChildExit,
  ) => void | Promise<void>;
  onUnexpectedExit?: (trackedSession: TrackedSession, exit: ChildExit) => void | Promise<void>;
  isExitUnexpectedOverride?: (trackedSession: TrackedSession, exit: ChildExit) => boolean | null | undefined;
  onPidPromoted?: (input: Readonly<{ fromPid: number; toPid: number; trackedSession: TrackedSession }>) => void;
  shouldPreserveSessionMarkerOnExit?: (input: Readonly<{
    pid: number;
    trackedSession: TrackedSession;
    exit: ChildExit;
    unexpected: boolean;
  }>) => boolean;
  onFinalTrackedSessionExitStaged?: (input: Readonly<{
    pid: number;
    trackedSession: TrackedSession;
    exit: ChildExit;
    observedAt: number;
  }>) => void | Promise<void>;
  removeSessionMarkerFn?: typeof removeSessionMarker;
  removeSessionMarkerIfOwnedFn?: typeof removeSessionMarkerIfOwned;
  promoteSessionMarkerFn?: typeof promoteSessionMarkerPid;
  updateSessionMarkerActiveTurnFn?: typeof updateSessionMarkerActiveTurn;
  stageObservedExitFn?: typeof stageObservedExit;
}>): (pid: number, exit: ChildExit) => Promise<void> {
  const {
    pidToTrackedSession,
    spawnResourceCleanupByPid,
    sessionAttachCleanupByPid,
    getApiMachineForSessions,
    beforeUnexpectedExitSettlement,
    onUnexpectedExit,
    isExitUnexpectedOverride,
    onPidPromoted,
    shouldPreserveSessionMarkerOnExit,
    onFinalTrackedSessionExitStaged,
    removeSessionMarkerFn,
    removeSessionMarkerIfOwnedFn = removeSessionMarkerIfOwned,
    promoteSessionMarkerFn = promoteSessionMarkerPid,
    updateSessionMarkerActiveTurnFn = updateSessionMarkerActiveTurn,
    stageObservedExitFn = stageObservedExit,
  } = params;

  const removeObservedSessionMarker = async (
    pid: number,
    tracked: TrackedSession,
    isStillOwned: () => boolean,
    markerOwnership: SessionMarkerOwnership = resolveTrackedMarkerOwnership(tracked),
  ): Promise<void> => {
    if (removeSessionMarkerFn) {
      await removeSessionMarkerFn(pid);
      return;
    }
    await removeSessionMarkerIfOwnedFn({
      pid,
      ...markerOwnership,
      isStillOwned,
    });
  };

  const observeChildExit = async (pid: number, exit: ChildExit) => {
    logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
    const tracked = pidToTrackedSession.get(pid);
    const runnerPid = tracked?.sessionRunnerPid;
    const override = tracked && isExitUnexpectedOverride ? isExitUnexpectedOverride(tracked, exit) : null;
    if (tracked && typeof runnerPid === 'number' && runnerPid !== pid && isPidAlive(runnerPid)) {
      logger.debug(`[DAEMON RUN] Wrapper PID ${pid} exited; promoting tracked session to runner PID ${runnerPid}`);
      await promoteTrackedSessionPidCustody({
        fromPid: pid,
        toPid: runnerPid,
        trackedSession: tracked,
        pidToTrackedSession,
        spawnResourceCleanupByPid,
        sessionAttachCleanupByPid,
        promoteSessionMarkerFn,
        removeSessionMarkerIfOwnedFn,
        removeSourceMarker: async (ownership, isStillOwned) => {
          await removeObservedSessionMarker(
            pid,
            tracked,
            isStillOwned,
            ownership,
          );
        },
        onPidPromoted,
      });
      return;
    }

    if (tracked) {
      const isCurrentPidOwner = (): boolean => pidToTrackedSession.get(pid) === tracked;
      const cleanupComplete = await cleanupPidSessionResources({
        pid,
        spawnResourceCleanupByPid,
        sessionAttachCleanupByPid,
      });
      if (!cleanupComplete || !isCurrentPidOwner()) return;
      const liveReplacement = findLiveReplacementForSameSession(pidToTrackedSession, pid, tracked);
      const shouldReportSessionEnd = liveReplacement === null;
      const isUnexpectedBase =
        exit.reason === 'process-exited-before-webhook' ||
        exit.reason === 'process-error-before-webhook' ||
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

      const actionableUnexpectedExit = shouldReportSessionEnd && isUnexpected;
      const shouldPreserveMarker = shouldPreserveSessionMarkerOnExit?.({
        pid,
        trackedSession: tracked,
        exit,
        unexpected: actionableUnexpectedExit,
      }) === true;
      const apiMachineForSessions = getApiMachineForSessions();
      const observedAt = Date.now();
      if (
        actionableUnexpectedExit
        && typeof tracked.happySessionId === 'string'
        && tracked.happySessionId.trim().length > 0
      ) {
        try {
          await beforeUnexpectedExitSettlement?.(tracked, exit);
        } catch (error) {
          logger.warn('[DAEMON RUN] Failed to capture unexpected runner exit authority; retaining marker evidence', {
            sessionId: tracked.happySessionId,
            pid,
            error,
          });
          return;
        }
      }
      try {
        await stageObservedExitFn({
          trackedSession: resolveTrackedSessionExitSettlementEvidence(tracked),
          observedAt,
          enqueueExactTurnEnd: async (mutation) => {
            if (!apiMachineForSessions?.enqueueDaemonTerminalExactTurnEnd) {
              throw new Error('Daemon terminal mutation custody is unavailable');
            }
            await apiMachineForSessions.enqueueDaemonTerminalExactTurnEnd(mutation);
          },
          releaseMarkerEvidence: async ({ markerPid, sessionId, turnId }) => {
            if (!isCurrentPidOwner()) return;
            const markerPids = Array.from(new Set([pid, markerPid]));
            if (shouldPreserveMarker) {
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
              await removeObservedSessionMarker(candidatePid, tracked, isCurrentPidOwner);
            }));
          },
        });
      } catch (error) {
        logger.warn('[DAEMON RUN] Failed to durably stage observed runner exit; retaining marker evidence', {
          sessionId: tracked.happySessionId,
          pid,
          error,
        });
        return;
      }
      if (!isCurrentPidOwner()) {
        logger.debug('[DAEMON RUN] PID ownership changed during durable exit staging; preserving replacement custody', {
          pid,
          exitedSessionId: tracked.happySessionId,
        });
        return;
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
          logger.warn('[DAEMON RUN] Failed to register the final runner exit with terminal-host recovery; retaining tracked custody', {
            sessionId: tracked.happySessionId,
            pid,
            error,
          });
          return;
        }
      }

      if (actionableUnexpectedExit && typeof tracked.happySessionId === 'string' && tracked.happySessionId.trim().length > 0) {
        try {
          await onUnexpectedExit?.(tracked, exit);
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to run onUnexpectedExit handler', error);
        }
      }
      void writeSessionExitReport({
        sessionId: tracked.happySessionId ?? null,
        pid,
        report: {
          observedAt,
          observedBy: 'daemon',
          reason: exit.reason,
          code: exit.code,
          signal: exit.signal,
          stderrTail: exit.stderrTail ?? null,
        },
      }).catch((error) => logger.debug('[DAEMON RUN] Failed to write session exit report', error));
      if (!isCurrentPidOwner()) return;
      if (isCurrentPidOwner()) {
        pidToTrackedSession.delete(pid);
      }
      return;
    }
    await cleanupPidSessionResources({
      pid,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
    });
  };

  const inFlightByTrackedSession = new WeakMap<TrackedSession, Promise<void>>();
  return async (pid: number, exit: ChildExit) => {
    const trackedSession = pidToTrackedSession.get(pid);
    if (!trackedSession) {
      await observeChildExit(pid, exit);
      return;
    }

    const existing = inFlightByTrackedSession.get(trackedSession);
    if (existing) {
      await existing;
      return;
    }

    const observation = observeChildExit(pid, exit);
    inFlightByTrackedSession.set(trackedSession, observation);
    try {
      await observation;
    } finally {
      if (inFlightByTrackedSession.get(trackedSession) === observation) {
        inFlightByTrackedSession.delete(trackedSession);
      }
    }
  };
}
