import { readFileSync } from 'fs';

import type { ApiMachineClient } from '@/api/apiMachine';
import type { DaemonLocallyPersistedState } from '@/persistence';
import { readDaemonState, writeDaemonState } from '@/persistence';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { gcExecutionRunMarkers } from '@/daemon/executionRunRegistry';
import { findHappyProcessByPid } from '@/daemon/doctor';
import { resolveComparableCliVersion } from '@/daemon/resolveComparableCliVersion';
import { spawnDetachedDaemonStartSync } from '@/daemon/runtime/spawnDetachedDaemonStartSync';
import { configuration } from '@/configuration';
import {
  gcWorkspaceReplicationCas,
  gcWorkspaceReplicationJobs,
  recoverWorkspaceReplicationJobsAfterRestart,
} from '@/workspaces/replication/state/workspaceReplicationGc';
import { recoverSessionHandoffPrepareTargetJobsAfterRestart } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';

import type { TrackedSession } from '../types';
import { cleanupPidSessionResources } from '../sessions/cleanupPidSessionResources';
import { createOnChildExited } from '../sessions/onChildExited';

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

async function waitForReplacementDaemon(params: Readonly<{
  ownPid: number;
  expectedCliVersion: string;
  timeoutMs: number;
  pollMs: number;
}>): Promise<boolean> {
  const { ownPid, expectedCliVersion, timeoutMs, pollMs } = params;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const daemonState = await readDaemonState();
    if (
      daemonState &&
      daemonState.pid !== ownPid &&
      daemonState.startedWithCliVersion === expectedCliVersion
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

export function startDaemonHeartbeatLoop(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  spawnResourceCleanupByPid: Map<number, () => void>;
  sessionAttachCleanupByPid: Map<number, () => Promise<void>>;
  getApiMachineForSessions: () => ApiMachineClient | null;
  onChildExited?: (pid: number, exit: Readonly<{ reason: string; code: number | null; signal: string | null }>) => void;
  controlPort: number;
  fileState: DaemonLocallyPersistedState;
  currentCliVersion: string;
  requestShutdown: (source: 'happier-app' | 'happier-cli' | 'os-signal' | 'exception', errorMessage?: string) => void;
  isShuttingDown?: () => boolean;
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
  } = params;

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
  const restartVerifyTimeoutMs = parsePositiveInt(process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS, 10000);
  const restartVerifyPollMs = parsePositiveInt(process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS, 250);
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
      for (const [pid, _] of pidToTrackedSession.entries()) {
        if (!isPidAliveBestEffort(pid)) {
          // Process is dead, remove from tracking
          logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
          onChildExitedForPrune(pid, { reason: 'process-missing', code: null, signal: null });
          continue;
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

        let spawnStarted = false;
        try {
          const spawned = await spawnDetachedDaemonStartSync();
          spawned.unref?.();
          spawnStarted = true;
        } catch (error) {
          logger.debug(
            '[DAEMON RUN] Failed to spawn new daemon, this is quite likely to happen during integration tests as we are cleaning out dist/ directory',
            error,
          );
        }

        if (spawnStarted) {
          const replacementConfirmed = await waitForReplacementDaemon({
            ownPid: process.pid,
            expectedCliVersion: projectVersion,
            timeoutMs: restartVerifyTimeoutMs,
            pollMs: restartVerifyPollMs,
          });
          if (replacementConfirmed) {
            logger.debug('[DAEMON RUN] Replacement daemon confirmed. Exiting outdated daemon process.');
            process.exit(0);
          }
          logger.debug('[DAEMON RUN] Replacement daemon was not confirmed before timeout. Keeping current daemon alive.');
        }
      }

      // Before recklessly overwriting the daemon state file, we should check if we are the ones who own it
      // Race condition is possible, but thats okay for the time being :D
      const daemonState = await readDaemonState();
      if (daemonState && daemonState.pid !== process.pid) {
        logger.debug('[DAEMON RUN] Somehow a different daemon was started without killing us. We should kill ourselves.');
        requestShutdown('exception', 'A different daemon was started without killing us. We should kill ourselves.');
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
          machineId: fileState.machineId,
          lastHeartbeatAt: Date.now(),
          daemonLogPath: fileState.daemonLogPath,
          controlToken: fileState.controlToken,
        };
        writeDaemonState(updatedState);
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
