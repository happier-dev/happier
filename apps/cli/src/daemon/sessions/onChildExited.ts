import type { ApiMachineClient } from '@/api/apiMachine';
import { logger } from '@/ui/logger';
import { writeSessionExitReport } from '@/daemon/sessionExitReport';

import type { TrackedSession } from '../types';
import { reportDaemonObservedSessionExit } from '../sessionTermination';
import { promoteSessionMarkerPid, removeSessionMarker } from '../sessionRegistry';
import { cleanupPidSessionResources } from './cleanupPidSessionResources';

export type ChildExit = { reason: string; code: number | null; signal: string | null };

export function createOnChildExited(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  spawnResourceCleanupByPid: Map<number, () => void>;
  sessionAttachCleanupByPid: Map<number, () => Promise<void>>;
  getApiMachineForSessions: () => ApiMachineClient | null;
  onUnexpectedExit?: (trackedSession: TrackedSession, exit: ChildExit) => void;
  isExitUnexpectedOverride?: (trackedSession: TrackedSession, exit: ChildExit) => boolean | null | undefined;
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
    removeSessionMarkerFn = removeSessionMarker,
    promoteSessionMarkerFn = promoteSessionMarkerPid,
  } = params;

  return (pid: number, exit: ChildExit) => {
    logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
    const tracked = pidToTrackedSession.get(pid);
    const runnerPid = tracked?.sessionRunnerPid;
    if (tracked && typeof runnerPid === 'number' && runnerPid !== pid) {
      tracked.pid = runnerPid;
      delete tracked.sessionRunnerPid;
      pidToTrackedSession.delete(pid);
      pidToTrackedSession.set(runnerPid, tracked);
      void promoteSessionMarkerFn(pid, runnerPid).catch((error) => {
        logger.debug('[DAEMON RUN] Failed to promote session marker to runner PID', error);
      });
      void cleanupPidSessionResources({
        pid,
        spawnResourceCleanupByPid,
        sessionAttachCleanupByPid,
      });
      void removeSessionMarkerFn(pid);
      return;
    }

    if (tracked) {
      const isUnexpectedBase =
        exit.reason === 'process-missing' ||
        exit.reason === 'process-error' ||
        (typeof exit.code === 'number' && exit.code !== 0) ||
        (typeof exit.signal === 'string' && exit.signal.length > 0 && !['SIGTERM', 'SIGINT'].includes(exit.signal));
      const override = isExitUnexpectedOverride ? isExitUnexpectedOverride(tracked, exit) : null;
      const isUnexpected = typeof override === 'boolean' ? override : isUnexpectedBase;

      if (isUnexpected && typeof tracked.happySessionId === 'string' && tracked.happySessionId.trim().length > 0) {
        try {
          onUnexpectedExit?.(tracked, exit);
        } catch (e) {
          logger.debug('[DAEMON RUN] Failed to run onUnexpectedExit handler', e);
        }
      }

      const apiMachineForSessions = getApiMachineForSessions();
      if (apiMachineForSessions) {
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
