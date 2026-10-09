import type { ApiMachineClient } from '@/api/apiMachine';
import { logger } from '@/ui/logger';
import { writeSessionExitReport } from '@/session/diagnostics/sessionExitReport';

import type { TrackedSession } from '../types';
import { removeSessionMarker, updateSessionMarkerActiveTurn } from '../sessionRegistry';
import { cleanupPidSessionResources } from './cleanupPidSessionResources';
import { stageObservedExit } from './stageObservedExit';
import { classifyTrackedSessionRunnerPresence } from './isSessionRunnerActive';

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

function isServerBackedSessionId(sessionId: string): boolean {
  return !/^PID-\d+$/.test(sessionId);
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
  shouldPreserveSessionMarkerOnExit?: (input: Readonly<{ pid: number; trackedSession: TrackedSession; exit: ChildExit }>) => boolean | Promise<boolean>;
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
    if (tracked?.startupCustody && exit.reason === 'process-missing') {
      const presence = await classifyTrackedSessionRunnerPresence({ tracked });
      // Presence reads may overlap promotion, reports, or explicit cancellation.
      if (pidToTrackedSession.get(pid) !== tracked || tracked.reportMarkerCustody?.retiring) return;
      if (tracked.startupCustody && tracked.stopRequestedAtMs === undefined
        && presence !== 'absent' && (presence !== 'present' || !tracked.sessionRunnerPid)) {
        logger.infoFile('[DAEMON RUN] Retaining pending startup after an unproven runner exit', { pid, presence });
        return;
      }
    }
    const runnerPid = tracked?.sessionRunnerPid;
    const override = tracked && isExitUnexpectedOverride ? isExitUnexpectedOverride(tracked, exit) : null;
    let canPromoteRunner = Boolean(tracked && typeof runnerPid === 'number' && runnerPid !== pid && isPidAlive(runnerPid));
    if (tracked && canPromoteRunner && tracked.processInstanceFingerprint) {
      const presence = await classifyTrackedSessionRunnerPresence({ tracked });
      if (pidToTrackedSession.get(pid) !== tracked || tracked.sessionRunnerPid !== runnerPid
        || tracked.reportMarkerCustody?.retiring) return;
      if (presence === 'unknown' || presence === 'recoverable_stopped') {
        logger.infoFile('[DAEMON RUN] Retaining wrapper custody until runner identity is resolved', { pid, runnerPid, presence });
        return;
      }
      canPromoteRunner = presence === 'present';
    }
    if (tracked && typeof runnerPid === 'number' && canPromoteRunner) {
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
      tracked.startupCustody?.promotePid?.(runnerPid);
      onPidPromoted?.({ fromPid: pid, toPid: runnerPid, trackedSession: promoted });
      void Promise.all([tracked.reportMarkerCustody?.pending, tracked.startupCustody?.finalization])
        .then(() => removeSessionMarkerFn(pid)).catch(() => {
          logger.infoFile('[DAEMON RUN] Warning: failed to remove promoted wrapper marker', { pid });
        });
      return;
    }

    // Promotion is not a runner exit. Every actual exit source must settle startup
    // immediately, then let its existing marker/binding finalizer finish before retirement.
    const startup = tracked?.startupCustody;
    startup?.observeExit(exit);
    const markerCustody = tracked?.reportMarkerCustody;
    // Close the same write owner synchronously even when no report has arrived:
    // a first report during startup retirement must not open new marker work.
    if (tracked) {
      tracked.reportMarkerCustody ??= { pending: Promise.resolve(), retiring: true };
      tracked.reportMarkerCustody.retiring = true;
    }
    if (markerCustody) await markerCustody.pending;
    if (startup) await startup.finalization;

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

      const finalSessionId = normalizeSessionId(tracked.happySessionId);
      const hasServerBackedSession = Boolean(finalSessionId) && isServerBackedSessionId(finalSessionId);
      const actionableUnexpectedExit = shouldReportSessionEnd && isUnexpected && hasServerBackedSession;
      const preserveExitedMarker = hasServerBackedSession
        && await shouldPreserveSessionMarkerOnExit?.({ pid, trackedSession: tracked, exit }) === true;
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
        if (typeof tracked.stopRequestedAtMs === 'number') {
          logger.infoFile('[DAEMON STOP] Runner exit durable staging completed', {
            sessionId: tracked.happySessionId,
            pid,
            elapsedMs: Date.now() - observedAt,
          });
        }
      } catch (error) {
        logger.warn('[DAEMON RUN] Failed to durably stage observed runner exit; retaining marker evidence', {
          sessionId: tracked.happySessionId,
          pid,
          error,
        });
        throw error;
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
              sessionId: tracked.happySessionId,
              pid,
              elapsedMs: Date.now() - recoveryStartedAtMs,
            });
          }
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
      if (actionableUnexpectedExit) {
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
    const resourceCleanupStartedAtMs = Date.now();
    await cleanupPidSessionResources({
      pid,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
    });
    pidToTrackedSession.delete(pid);
    if (typeof tracked?.stopRequestedAtMs === 'number') {
      logger.infoFile('[DAEMON STOP] Runner exit resources completed', {
        sessionId: tracked.happySessionId,
        pid,
        elapsedMs: Date.now() - resourceCleanupStartedAtMs,
      });
    }
  };
}
