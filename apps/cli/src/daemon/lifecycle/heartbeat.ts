import { readFileSync } from 'fs';

import type { ApiMachineClient } from '@/api/apiMachine';
import type { DaemonLocallyPersistedState } from '@/persistence';
import { readDaemonState, writeDaemonStateIfLockOwned } from '@/persistence';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { gcExecutionRunMarkers } from '@/daemon/executionRunRegistry';
import { findHappyProcessByPid } from '@/daemon/doctor';
import { resolveComparableCliVersion } from '@/daemon/resolveComparableCliVersion';
import { configuration } from '@/configuration';
import {
  readDaemonRestartVerifyPollMs,
  readDaemonRestartVerifyTimeoutMs,
} from '@/daemon/startupWaitDefaults';
import {
  gcWorkspaceReplicationCas,
  gcWorkspaceReplicationJobs,
  recoverWorkspaceReplicationJobsAfterRestart,
} from '@/workspaces/replication/state/workspaceReplicationGc';
import { recoverSessionHandoffPrepareTargetJobsAfterRestart } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';

import type { TrackedSession } from '../types';
import { cleanupPidSessionResources } from '../sessions/cleanupPidSessionResources';
import { createOnChildExited } from '../sessions/onChildExited';
import { readSessionMarkerForPid } from '../sessionRegistry';
import {
  isValidProcessCommandHash,
  readSessionRunnerProcessIdentity as readSessionRunnerProcessIdentityDefault,
  storedProcessIdentityProvesPidReuse,
  type SessionRunnerProcessIdentity,
} from '../sessionRunnerProcessIdentity';
import { requestDaemonSelfRestart } from './requestDaemonSelfRestart';

type RequestDaemonSelfRestart = typeof requestDaemonSelfRestart;

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isPidAliveBestEffort(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as any).code : null;
    // EPERM means the process exists but we lack permission to signal it. Fail closed and treat it as alive.
    if (code === 'ESRCH') return false;
    return true;
  }
}

type TrackedSessionHeartbeatPruneReason = 'process-missing' | 'process-reused';
type ReadSessionRunnerProcessIdentity = (params: Readonly<{ pid: number }>) => Promise<SessionRunnerProcessIdentity>;

function hasLiveDaemonChildProcessHandle(
  trackedSession: Pick<TrackedSession, 'startedBy' | 'pid' | 'childProcess'>,
): boolean {
  if (trackedSession.startedBy !== 'daemon') return false;
  const childProcess = trackedSession.childProcess;
  if (!childProcess || childProcess.pid !== trackedSession.pid) return false;
  return childProcess.exitCode === null && childProcess.signalCode === null;
}

export function getTrackedSessionHeartbeatPruneReason(params: Readonly<{
  isPidAlive: boolean;
  trackedSession: Pick<TrackedSession, 'startedBy' | 'pid' | 'childProcess' | 'processCommandHash' | 'processInstanceFingerprint'>;
  currentIdentity?: SessionRunnerProcessIdentity;
}>): TrackedSessionHeartbeatPruneReason | null {
  if (!params.isPidAlive) return 'process-missing';
  if (!params.currentIdentity) return null;
  const processIdentityProvesPidReuse = storedProcessIdentityProvesPidReuse({
    storedProcessInstanceFingerprint: params.trackedSession.processInstanceFingerprint,
    currentIdentity: params.currentIdentity,
  });
  if (!processIdentityProvesPidReuse) return null;
  if (hasLiveDaemonChildProcessHandle(params.trackedSession)) return null;
  return 'process-reused';
}

export function startDaemonHeartbeatLoop(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  spawnResourceCleanupByPid: Map<number, () => void>;
  sessionAttachCleanupByPid: Map<number, () => Promise<void>>;
  getApiMachineForSessions: () => ApiMachineClient | null;
  onChildExited?: (pid: number, exit: Readonly<{ reason: string; code: number | null; signal: string | null }>) => void | Promise<void>;
  controlPort: number;
  fileState: DaemonLocallyPersistedState;
  currentCliVersion: string;
  requestShutdown: (source: 'happier-app' | 'happier-cli' | 'os-signal' | 'exception', errorMessage?: string) => void;
  isShuttingDown?: () => boolean;
  readSessionRunnerProcessIdentity?: ReadSessionRunnerProcessIdentity;
  requestSelfRestart?: RequestDaemonSelfRestart;
}>): NodeJS.Timeout {
  const {
    pidToTrackedSession,
    spawnResourceCleanupByPid,
    sessionAttachCleanupByPid,
    getApiMachineForSessions,
    onChildExited,
    controlPort,
    fileState,
    currentCliVersion,
    requestShutdown,
    isShuttingDown,
    readSessionRunnerProcessIdentity,
    requestSelfRestart = requestDaemonSelfRestart,
  } = params;
  const readSessionRunnerProcessIdentityForHeartbeat =
    readSessionRunnerProcessIdentity ?? readSessionRunnerProcessIdentityDefault;

  const onChildExitedForPrune =
    onChildExited ??
    createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions,
    });

  // Every 60 seconds:
  // 1. Prune stale sessions
  // 2. Check if daemon needs update
  // 3. If outdated, restart with latest version
  // 4. Write heartbeat
  const heartbeatIntervalMs = parsePositiveInt(process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL, 60000);
  const restartVerifyTimeoutMs = readDaemonRestartVerifyTimeoutMs();
  const restartVerifyPollMs = readDaemonRestartVerifyPollMs();
  const executionRunTerminalTtlMs = parseNonNegativeInt(
    process.env.HAPPIER_DAEMON_EXECUTION_RUN_TERMINAL_TTL_MS,
    6 * 60 * 60 * 1000,
  );
  const workspaceReplicationJobTerminalTtlMs = parseNonNegativeInt(
    process.env.HAPPIER_DAEMON_WORKSPACE_REPLICATION_JOB_TERMINAL_TTL_MS,
    14 * 24 * 60 * 60 * 1000,
  );
  const workspaceReplicationCasUnreferencedTtlMs = parseNonNegativeInt(
    process.env.HAPPIER_DAEMON_WORKSPACE_REPLICATION_CAS_UNREFERENCED_TTL_MS,
    14 * 24 * 60 * 60 * 1000,
  );
  const workspaceReplicationCasMaxBytes = parseNonNegativeInt(
    process.env.HAPPIER_DAEMON_WORKSPACE_REPLICATION_CAS_MAX_BYTES,
    0,
  );
  let heartbeatRunning = false;
  let workspaceReplicationRecoveryPromise: Promise<void> | null = null;
  let sessionHandoffPrepareTargetRecoveryPromise: Promise<void> | null = null;

  const ensureWorkspaceReplicationRecovery = (): Promise<void> => {
    if (workspaceReplicationRecoveryPromise) {
      return workspaceReplicationRecoveryPromise;
    }
    workspaceReplicationRecoveryPromise = (async () => {
      try {
        await recoverWorkspaceReplicationJobsAfterRestart({
          activeServerDir: configuration.activeServerDir,
          nowMs: Date.now(),
        });
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to recover workspace replication jobs', error);
      }
    })();
    return workspaceReplicationRecoveryPromise;
  };

  const ensureSessionHandoffPrepareTargetRecovery = (): Promise<void> => {
    if (sessionHandoffPrepareTargetRecoveryPromise) {
      return sessionHandoffPrepareTargetRecoveryPromise;
    }
    sessionHandoffPrepareTargetRecoveryPromise = (async () => {
      try {
        await recoverSessionHandoffPrepareTargetJobsAfterRestart({
          activeServerDir: configuration.activeServerDir,
          nowMs: Date.now(),
        });
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to recover session-handoff prepare-target jobs', error);
      }
    })();
    return sessionHandoffPrepareTargetRecoveryPromise;
  };

  // Kick off recovery immediately; do not wait for the first heartbeat tick.
  void ensureWorkspaceReplicationRecovery();
  void ensureSessionHandoffPrepareTargetRecovery();

  const intervalHandle = setInterval(async () => {
    // During shutdown we must not mutate local daemon state (especially daemon.state.json),
    // otherwise "stop via HTTP" can race and recreate state files after cleanup.
    if (isShuttingDown?.() === true) {
      return;
    }
    if (heartbeatRunning) {
      return;
    }
    heartbeatRunning = true;
    try {
      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      await ensureWorkspaceReplicationRecovery();
      await ensureSessionHandoffPrepareTargetRecovery();

      // Prune stale sessions
      for (const [pid, tracked] of pidToTrackedSession.entries()) {
        const isPidAlive = isPidAliveBestEffort(pid);
        const currentIdentity = isPidAlive && (
          isValidProcessCommandHash(tracked.processCommandHash)
          || Boolean(tracked.processInstanceFingerprint)
        )
          ? await readSessionRunnerProcessIdentityForHeartbeat({ pid }).catch(() => ({ kind: 'unknown' as const }))
          : undefined;
        const pruneReason = getTrackedSessionHeartbeatPruneReason({
          isPidAlive,
          trackedSession: tracked,
          currentIdentity,
        });
        if (pruneReason) {
          logger.debug(
            `[DAEMON RUN] Removing stale session with PID ${pid} (${
              pruneReason === 'process-missing' ? 'process no longer exists' : 'PID was reused by another process'
            })`,
          );
          await onChildExitedForPrune(pid, { reason: pruneReason, code: null, signal: null });
          continue;
        }
        if (tracked.happySessionId) {
          const marker = await readSessionMarkerForPid(pid).catch(() => null);
          if (marker?.happySessionId === tracked.happySessionId) {
            tracked.terminalHostHealth = marker.terminalHostHealth;
          }
        }
      }

      try {
        await gcExecutionRunMarkers({
          nowMs: Date.now(),
          terminalTtlMs: executionRunTerminalTtlMs,
          isPidAlive: (pid) => {
            return isPidAliveBestEffort(pid);
          },
          isPidSafeHappyProcess: async (pid) => {
            if (pidToTrackedSession.has(pid)) return true;
            const proc = await findHappyProcessByPid(pid);
            return Boolean(proc);
          },
        });
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to gc execution run markers', error);
      }

      try {
        await gcWorkspaceReplicationJobs({
          activeServerDir: configuration.activeServerDir,
          nowMs: Date.now(),
          terminalTtlMs: workspaceReplicationJobTerminalTtlMs,
        });
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to gc workspace replication jobs', error);
      }

      try {
        if (workspaceReplicationCasUnreferencedTtlMs > 0 || workspaceReplicationCasMaxBytes > 0) {
          await gcWorkspaceReplicationCas({
            activeServerDir: configuration.activeServerDir,
            nowMs: Date.now(),
            unreferencedTtlMs: workspaceReplicationCasUnreferencedTtlMs,
            ...(workspaceReplicationCasMaxBytes > 0 ? { maxBytes: workspaceReplicationCasMaxBytes } : {}),
          });
        }
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to gc workspace replication cas', error);
      }

      // Cleanup any spawn resources for sessions no longer tracked (e.g. stopSession removed them).
      const cleanupPidMapIfUntracked = async (map: Map<number, unknown>) => {
        for (const [pid] of map.entries()) {
          if (pidToTrackedSession.has(pid)) continue;
          if (!isPidAliveBestEffort(pid)) {
            await cleanupPidSessionResources({
              pid,
              spawnResourceCleanupByPid,
              sessionAttachCleanupByPid,
            });
          }
        }
      };

      await cleanupPidMapIfUntracked(spawnResourceCleanupByPid);
      await cleanupPidMapIfUntracked(sessionAttachCleanupByPid);

      // Check if daemon needs update
      // If version on disk is different from the one in package.json - we need to restart
      // BIG if - does this get updated from underneath us on npm upgrade?
      const projectVersion = resolveComparableCliVersion({
        fallbackVersion: currentCliVersion,
        projectRootPath: projectPath(),
        readFileSyncImpl: readFileSync,
      });

      if (projectVersion && projectVersion !== currentCliVersion) {
        logger.debug('[DAEMON RUN] Daemon is outdated, triggering self-restart with latest version');

        await requestSelfRestart({
          runtimeId: fileState.runtimeId,
          expectedCliVersion: projectVersion,
          ownPid: process.pid,
          timeoutMs: restartVerifyTimeoutMs,
          pollMs: restartVerifyPollMs,
          takeover: true,
        });
      }

      // Observe an already-published successor before constructing this heartbeat. The subsequent
      // owner-gated write closes the lock handoff race between this read and publication.
      const daemonState = await readDaemonState();
      if (daemonState && daemonState.pid !== process.pid) {
        logger.debug('[DAEMON RUN] Somehow a different daemon was started without killing us. We should kill ourselves.');
        requestShutdown('exception', 'A different daemon was started without killing us. We should kill ourselves.');
        return;
      }

      // Heartbeat
      try {
        if (isShuttingDown?.() === true) {
          return;
        }
        const updatedState: DaemonLocallyPersistedState = {
          pid: process.pid,
          httpPort: controlPort,
          startedAt: fileState.startedAt,
          startedWithCliVersion: fileState.startedWithCliVersion,
          startedWithPublicReleaseChannel: fileState.startedWithPublicReleaseChannel,
          runtimeId: fileState.runtimeId,
          startupSource: fileState.startupSource,
          serviceLabel: fileState.serviceLabel,
          machineId: fileState.machineId,
          lastHeartbeatAt: Date.now(),
          daemonLogPath: fileState.daemonLogPath,
          controlToken: fileState.controlToken,
        };
        if (!writeDaemonStateIfLockOwned(updatedState)) {
          requestShutdown('exception', 'Daemon lifecycle lock ownership changed before heartbeat publication.');
          return;
        }
        if (process.env.DEBUG) {
          logger.debug(
            `[DAEMON RUN] Health check completed at ${new Date(updatedState.lastHeartbeatAt ?? Date.now()).toISOString()}`,
          );
        }
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to write heartbeat', error);
      }
    } catch (error) {
      // This is defensive: any unexpected error in the async interval callback should not permanently stop the loop.
      logger.debug('[DAEMON RUN] Heartbeat loop tick failed', error);
    } finally {
      heartbeatRunning = false;
    }
  }, heartbeatIntervalMs); // Every 60 seconds in production

  return intervalHandle;
}
