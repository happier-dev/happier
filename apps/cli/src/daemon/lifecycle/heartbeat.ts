import { readFileSync } from 'fs';
import { join } from 'path';

import type { ApiMachineClient } from '@/api/apiMachine';
import type { DaemonLocallyPersistedState } from '@/persistence';
import { readDaemonState, writeDaemonState } from '@/persistence';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { writeSessionExitReport } from '@/daemon/sessionExitReport';
import { gcExecutionRunMarkers } from '@/daemon/executionRunRegistry';
import { findHappyProcessByPid } from '@/daemon/doctor';

import { reportDaemonObservedSessionExit } from '../sessionTermination';
import type { TrackedSession } from '../types';
import { removeSessionMarker } from '../sessionRegistry';

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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
  } = params;

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
  let heartbeatRunning = false;

  const intervalHandle = setInterval(async () => {
    if (heartbeatRunning) {
      return;
    }
    heartbeatRunning = true;
    try {
      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      // Prune stale sessions
      for (const [pid, _] of pidToTrackedSession.entries()) {
        try {
          // Check if process is still alive (signal 0 doesn't kill, just checks)
          process.kill(pid, 0);
        } catch (error) {
          // Process is dead, remove from tracking
          logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
          if (onChildExited) {
            onChildExited(pid, { reason: 'process-missing', code: null, signal: null });
            continue;
          }
          const tracked = pidToTrackedSession.get(pid);
          if (tracked) {
            const apiMachine = getApiMachineForSessions();
            if (apiMachine) {
              reportDaemonObservedSessionExit({
                apiMachine,
                trackedSession: tracked,
                now: () => Date.now(),
                exit: { reason: 'process-missing', code: null, signal: null },
              });
            }
            void writeSessionExitReport({
              sessionId: tracked.happySessionId ?? null,
              pid,
              report: {
                observedAt: Date.now(),
                observedBy: 'daemon',
                reason: 'process-missing',
                code: null,
                signal: null,
              },
            }).catch((e) => logger.debug('[DAEMON RUN] Failed to write session exit report', e));
          }
          const cleanup = spawnResourceCleanupByPid.get(pid);
          if (cleanup) {
            spawnResourceCleanupByPid.delete(pid);
            try {
              cleanup();
            } catch (cleanupError) {
              logger.debug('[DAEMON RUN] Failed to cleanup spawn resources', cleanupError);
            }
          }
          const attachCleanup = sessionAttachCleanupByPid.get(pid);
          if (attachCleanup) {
            sessionAttachCleanupByPid.delete(pid);
            try {
              await attachCleanup();
            } catch (cleanupError) {
              logger.debug('[DAEMON RUN] Failed to cleanup session attach file', cleanupError);
            }
          }
          pidToTrackedSession.delete(pid);
          void removeSessionMarker(pid);
        }
      }

      try {
        await gcExecutionRunMarkers({
          nowMs: Date.now(),
          terminalTtlMs: executionRunTerminalTtlMs,
          isPidAlive: (pid) => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
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

      // Cleanup any spawn resources for sessions no longer tracked (e.g. stopSession removed them).
      for (const [pid, cleanup] of spawnResourceCleanupByPid.entries()) {
        if (pidToTrackedSession.has(pid)) continue;
        try {
          process.kill(pid, 0);
        } catch {
          spawnResourceCleanupByPid.delete(pid);
          try {
            cleanup();
          } catch (cleanupError) {
            logger.debug('[DAEMON RUN] Failed to cleanup spawn resources', cleanupError);
          }
        }
      }

      for (const [pid, cleanup] of sessionAttachCleanupByPid.entries()) {
        if (pidToTrackedSession.has(pid)) continue;
        try {
          process.kill(pid, 0);
        } catch {
          sessionAttachCleanupByPid.delete(pid);
          try {
            await cleanup();
          } catch (cleanupError) {
            logger.debug('[DAEMON RUN] Failed to cleanup session attach file', cleanupError);
          }
        }
      }

      // Check if daemon needs update
      // If version on disk is different from the one in package.json - we need to restart
      // BIG if - does this get updated from underneath us on npm upgrade?
      let projectVersion: string | null = null;
      try {
        projectVersion = JSON.parse(
          readFileSync(join(projectPath(), 'package.json'), 'utf-8'),
        ).version;
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to read package.json version; skipping self-restart check', error);
      }

      if (projectVersion && projectVersion !== currentCliVersion) {
        logger.debug('[DAEMON RUN] Daemon is outdated, triggering self-restart with latest version');

        let spawnStarted = false;
        try {
          const spawned = spawnHappyCLI(['daemon', 'start-sync'], {
            detached: true,
            stdio: 'ignore',
            env: process.env,
          });
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
        const updatedState: DaemonLocallyPersistedState = {
          pid: process.pid,
          httpPort: controlPort,
          startedAt: fileState.startedAt,
          startedWithCliVersion: fileState.startedWithCliVersion,
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
