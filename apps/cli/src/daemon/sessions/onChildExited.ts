import { isPidPresent } from '@happier-dev/cli-common/process';
import type { ApiMachineClient } from '@/api/apiMachine';
import { logger } from '@/ui/logger';
import { writeSessionExitReport } from '@/session/diagnostics/sessionExitReport';

import type { TrackedSession } from '../types';
import {
  promoteSessionMarkerPid,
  removeSessionMarker,
  removeSessionMarkerIfOwned,
  type SessionMarkerOwnership,
  updateSessionMarkerActiveTurn,
} from '../sessionRegistry';
import { cleanupPidSessionResources } from './cleanupPidSessionResources';
import { promoteTrackedSessionPidCustody } from './promoteTrackedSessionPidCustody';
import { classifyTrackedSessionProcessPresence } from './isSessionRunnerActive';
import { readProcessRunState } from '../processRunState';
import { readProcessIdentityByPid } from '../processIdentity';
import { resolveTrackedSessionExitSettlementEvidence } from './resolveTrackedSessionExitSettlementEvidence';
import { stageObservedExit } from './stageObservedExit';
import { resolveTrackedSessionActiveTurn } from './trackedSessionActiveTurn';

export type ChildExit = {
  reason: string;
  code: number | null;
  signal: string | null;
  stderrTail?: string | null;
};

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveTrackedMarkerOwnership(tracked: TrackedSession): Readonly<{
  happySessionId: string;
  processCommandHash?: string;
  processStartTimeMs?: number;
}> {
  const happySessionId = normalizeSessionId(tracked.happySessionId) || `PID-${tracked.pid}`;
  // Exit retirement compares the captured OS evidence with the persisted record;
  // rereading a departed/reused PID or hashing launch arguments cannot supply it.
  return {
    happySessionId,
    ...(tracked.processCommandHash ? { processCommandHash: tracked.processCommandHash } : {}),
    ...(tracked.processStartTimeMs !== undefined ? { processStartTimeMs: tracked.processStartTimeMs } : {}),
  };
}

function isTrackedSessionAlive(tracked: TrackedSession): boolean {
  if (isPidPresent(tracked.pid)) return true;
  const runnerPid = tracked.sessionRunnerPid;
  return typeof runnerPid === 'number' && runnerPid !== tracked.pid && isPidPresent(runnerPid);
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

function isServerBackedSessionId(sessionId: string): boolean {
  return !/^PID-\d+$/.test(sessionId);
}

async function settleNoTurnFinalExit(params: Readonly<{
  apiMachine: Pick<ApiMachineClient, 'captureMachineSessionTerminal' | 'finalizeMachineSessionTerminal'>;
  sessionId: string;
}>): Promise<boolean> {
  try {
    const captured = await params.apiMachine.captureMachineSessionTerminal(params.sessionId);
    if (captured.status === 'rejected') {
      logger.warn('[DAEMON RUN] Failed to capture no-turn Session terminal authority; retaining marker evidence', {
        sessionId: params.sessionId,
        reason: captured.reason,
      });
      return false;
    }
    if (captured.status === 'already_inactive') return true;

    const finalized = await params.apiMachine.finalizeMachineSessionTerminal({
      sessionId: captured.sessionId,
      authority: captured.authority,
    });
    if (finalized.status !== 'rejected') return true;

    logger.warn('[DAEMON RUN] Failed to finalize no-turn Session terminal authority; retaining marker evidence', {
      sessionId: params.sessionId,
      reason: finalized.reason,
    });
    return false;
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to settle no-turn Session terminal authority; retaining marker evidence', {
      sessionId: params.sessionId,
      error,
    });
    return false;
  }
}

export function createOnChildExited(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  processPresenceDependencies?: Readonly<{
    readProcessRunState?: typeof readProcessRunState;
    readProcessIdentityByPid?: typeof readProcessIdentityByPid;
  }>;
  spawnResourceCleanupByPid: Map<number, () => void | Promise<void>>;
  sessionAttachCleanupByPid: Map<number, () => Promise<void>>;
  getApiMachineForSessions: () => ApiMachineClient | null;
  beforeUnexpectedExitSettlement?: (
    trackedSession: TrackedSession,
    exit: ChildExit,
  ) => void | Promise<void>;
  onUnexpectedExit?: (trackedSession: TrackedSession, exit: ChildExit) => void | Promise<void>;
  /**
   * Retire the managed children this Session runner owned, before anything respawns it.
   *
   * A runner that was killed or crashed ran none of its own disposal, and its managed services are
   * spawned detached, so they keep running with their port, listener and injected host credential.
   * Only reachable when no live runner still owns this session — a replacement PID means those
   * children still have their owner.
   */
  retireSessionRunnerOwnedManagedServices?: (
    input: Readonly<{ sessionId: string; trackedSession: TrackedSession; exit: ChildExit }>,
  ) => void | Promise<void>;
  isExitUnexpectedOverride?: (trackedSession: TrackedSession, exit: ChildExit) => boolean | null | undefined;
  onPidPromoted?: (input: Readonly<{ fromPid: number; toPid: number; trackedSession: TrackedSession }>) => void;
  shouldPreserveSessionMarkerOnExit?: (input: Readonly<{
    pid: number;
    trackedSession: TrackedSession;
    exit: ChildExit;
    unexpected: boolean;
  }>) => boolean | Promise<boolean>;
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
    retireSessionRunnerOwnedManagedServices,
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
    const tracked = pidToTrackedSession.get(pid);
    if (exit.reason === 'process-missing' && tracked?.windowsTerminalLaunchCustody) {
      const presence = await classifyTrackedSessionProcessPresence({
        tracked,
        readProcessRunState: params.processPresenceDependencies?.readProcessRunState ?? readProcessRunState,
        readProcessIdentityByPid: params.processPresenceDependencies?.readProcessIdentityByPid ?? readProcessIdentityByPid,
      });
      if (pidToTrackedSession.get(pid) !== tracked) return;
      if (tracked.stopRequestedAtMs === undefined && presence !== 'absent'
        && (presence !== 'present' || !tracked.sessionRunnerPid || tracked.sessionRunnerPid === pid)) {
        logger.infoFile('[DAEMON RUN] Missing Windows dispatcher does not prove runner exit; retaining startup custody', { pid });
        return;
      }
    }
    logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
    const runnerPid = tracked?.sessionRunnerPid;
    const override = tracked && isExitUnexpectedOverride ? isExitUnexpectedOverride(tracked, exit) : null;
    if (tracked && typeof runnerPid === 'number' && runnerPid !== pid && isPidPresent(runnerPid)) {
      if (tracked.acceptedSpawnMarkerGate && !await tracked.acceptedSpawnMarkerGate) return;
      if (pidToTrackedSession.get(pid) !== tracked) return;
      const currentRunnerPid = tracked.sessionRunnerPid;
      let canPromoteRunner = typeof currentRunnerPid === 'number' && currentRunnerPid !== pid && isPidPresent(currentRunnerPid);
      if (canPromoteRunner && (tracked.runnerProcessIdentity || tracked.startupCustody)) {
        const presence = await classifyTrackedSessionProcessPresence({
          tracked,
          readProcessRunState: params.processPresenceDependencies?.readProcessRunState ?? readProcessRunState,
          readProcessIdentityByPid: params.processPresenceDependencies?.readProcessIdentityByPid ?? readProcessIdentityByPid,
        });
        if (pidToTrackedSession.get(pid) !== tracked || tracked.sessionRunnerPid !== currentRunnerPid || tracked.reportMarkerCustody?.retiring) return;
        if (presence === 'unknown' || presence === 'recoverable_stopped') {
          logger.infoFile('[DAEMON RUN] Runner generation unresolved; retaining wrapper custody', { pid, runnerPid: currentRunnerPid, presence });
          return;
        }
        canPromoteRunner = presence === 'present';
      }
      if (typeof currentRunnerPid === 'number' && canPromoteRunner) {
        logger.debug(`[DAEMON RUN] Wrapper PID ${pid} exited; promoting tracked session to runner PID ${currentRunnerPid}`);
        await promoteTrackedSessionPidCustody({
          fromPid: pid,
          toPid: currentRunnerPid,
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
    }

    if (tracked) {
      const startupCustody = tracked.startupCustody;
      startupCustody?.observeExit(exit);
      const markerCustody = tracked.reportMarkerCustody;
      tracked.reportMarkerCustody ??= { pending: Promise.resolve(), retiring: true };
      tracked.reportMarkerCustody.retiring = true;
      if (markerCustody) await markerCustody.pending;
      if (startupCustody) await startupCustody.finalization;
      const isCurrentPidOwner = (): boolean => pidToTrackedSession.get(pid) === tracked;
      const resourceCleanupStartedAtMs = Date.now();
      const cleanupComplete = await cleanupPidSessionResources({
        pid,
        spawnResourceCleanupByPid,
        sessionAttachCleanupByPid,
      });
      if (!cleanupComplete || !isCurrentPidOwner()) return;
      if (typeof tracked.stopRequestedAtMs === 'number') {
        logger.infoFile('[DAEMON STOP] Runner exit resources completed', {
          sessionId: tracked.happySessionId, pid, elapsedMs: Date.now() - resourceCleanupStartedAtMs,
        });
      }
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

      const finalSessionId = normalizeSessionId(tracked.happySessionId);
      const hasServerBackedSession = Boolean(finalSessionId) && isServerBackedSessionId(finalSessionId);
      const actionableUnexpectedExit = shouldReportSessionEnd && isUnexpected && hasServerBackedSession;
      const shouldPreserveMarker = hasServerBackedSession && await shouldPreserveSessionMarkerOnExit?.({
        pid,
        trackedSession: tracked,
        exit,
        unexpected: actionableUnexpectedExit,
      }) === true;
      const apiMachineForSessions = getApiMachineForSessions();
      const observedAt = Date.now();
      const trackedExitSettlementEvidence = resolveTrackedSessionExitSettlementEvidence(tracked);
      const exactTurn = resolveTrackedSessionActiveTurn(trackedExitSettlementEvidence);
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
      if (
        shouldReportSessionEnd
        && !isUnexpected
        && exactTurn === null
        && finalSessionId
        && isServerBackedSessionId(finalSessionId)
      ) {
        if (!apiMachineForSessions || !await settleNoTurnFinalExit({
          apiMachine: apiMachineForSessions,
          sessionId: finalSessionId,
        })) {
          return;
        }
      }
      const stagingStartedAtMs = Date.now();
      try {
        await stageObservedExitFn({
          trackedSession: trackedExitSettlementEvidence,
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
        if (typeof tracked.stopRequestedAtMs === 'number') {
          logger.infoFile('[DAEMON STOP] Runner exit durable staging completed', {
            sessionId: tracked.happySessionId, pid, elapsedMs: Date.now() - stagingStartedAtMs,
          });
        }
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

      if (
        shouldReportSessionEnd
        && hasServerBackedSession
        && exit.reason !== 'startup-cancelled-before-ack'
        && onFinalTrackedSessionExitStaged
      ) {
        const recoveryStartedAtMs = Date.now();
        try {
          await onFinalTrackedSessionExitStaged({
            pid,
            trackedSession: tracked,
            exit,
            observedAt,
          });
          if (typeof tracked.stopRequestedAtMs === 'number') {
            logger.infoFile('[DAEMON STOP] Runner exit terminal recovery completed', {
              sessionId: tracked.happySessionId, pid, elapsedMs: Date.now() - recoveryStartedAtMs,
            });
          }
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
          await retireSessionRunnerOwnedManagedServices?.({
            sessionId: tracked.happySessionId,
            trackedSession: tracked,
            exit,
          });
        } catch (error) {
          logger.warn('[DAEMON RUN] Failed to retire managed services owned by an exited runner', {
            sessionId: tracked.happySessionId,
            pid,
            error,
          });
        }
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
  return async function handleChildExit(pid: number, exit: ChildExit) {
    const trackedSession = pidToTrackedSession.get(pid);
    if (!trackedSession) {
      await observeChildExit(pid, exit);
      return;
    }

    const existing = inFlightByTrackedSession.get(trackedSession);
    if (existing) {
      await existing;
      if (exit.reason !== 'process-missing' && pidToTrackedSession.get(pid) === trackedSession) {
        await handleChildExit(pid, exit);
      }
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
