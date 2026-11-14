import { readFileSync } from 'fs';

import { isPidPresent } from '@happier-dev/cli-common/process';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { DaemonLocallyPersistedState } from '@/persistence';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { gcExecutionRunMarkers } from '@/daemon/executionRunRegistry';
import { findHappyProcessByPid } from '@/daemon/doctor';
import { processGenerationProvesReuse, readProcessIdentitiesByPid, readProcessIdentityByPid } from '@/daemon/processIdentity';
import { resolveComparableCliVersion } from '@/daemon/resolveComparableCliVersion';
import { readDaemonRestartVerifyPollMs, readDaemonRestartVerifyTimeoutMs } from '@/daemon/startupWaitDefaults';
import { configuration } from '@/configuration';
import { recoverSessionHandoffPrepareTargetJobsAfterRestart } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';

import type { TrackedSession } from '../types';
import { cleanupSessionResources, type SessionAttachCleanupByKey, type SpawnResourceCleanupByKey } from '../sessions/cleanupSessionResources';
import { createOnChildExited } from '../sessions/onChildExited';
import { classifyTrackedSessionProcessPresence } from '../sessions/isSessionRunnerActive';
import { readProcessRunState } from '../processRunState';
import { requestDaemonSelfRestart } from './requestDaemonSelfRestart';
import type { ManagedActivityInventory } from './managedActivity';
import { isCurrentTrackedSession, trackedSessionsForProcess, type SessionTrackingKey, type TrackedSessionMap } from '@/daemon/sessions/sessionTrackingKey';

type RequestDaemonSelfRestart = typeof requestDaemonSelfRestart;

export {
  DEFAULT_DAEMON_RESTART_VERIFY_POLL_MS,
  DEFAULT_DAEMON_RESTART_VERIFY_TIMEOUT_MS,
} from '@/daemon/startupWaitDefaults';

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Removes execution-run markers whose runner is gone or whose terminal visibility window passed.
 * Part of the ended-runner retirement the daemon runs at startup and on each runner exit edge.
 */
export async function collectEndedExecutionRunMarkers(trackedSessionsByKey: TrackedSessionMap): Promise<void> {
  await gcExecutionRunMarkers({
    nowMs: Date.now(),
    terminalTtlMs: parseNonNegativeInt(process.env.HAPPIER_DAEMON_EXECUTION_RUN_TERMINAL_TTL_MS, 6 * 60 * 60 * 1000),
    isPidAlive: isPidPresent,
    isPidSafeHappyProcess: async (pid) => {
      if (trackedSessionsForProcess(trackedSessionsByKey, pid).length > 0) return true;
      return Boolean(await findHappyProcessByPid(pid));
    },
  });
}

export function startDaemonHeartbeatLoop(params: Readonly<{
  trackedSessionsByKey: TrackedSessionMap;
  spawnResourceCleanupByKey: SpawnResourceCleanupByKey;
  sessionAttachCleanupByKey: SessionAttachCleanupByKey;
  getApiMachineForSessions: () => ApiMachineClient | null;
  onChildExited?: (
    pid: number,
    exit: Readonly<{ reason: string; code: number | null; signal: string | null }>,
  ) => void | Promise<void>;
  onTrackedSessionHealthy?: (tracked: TrackedSession) => Promise<void>;
  /**
   * Retires state owned by runners that ended (managed-service projections, execution-run markers).
   * The daemon runs it on every runner exit edge; the heartbeat runs it once at startup for runners
   * that ended while no daemon was watching.
   */
  retireEndedRunnerOwnedState?: () => Promise<void>;
  allocatorMaintenance?: Readonly<{
    activity: Pick<ManagedActivityInventory, 'readDecision'>;
    trim: () => Promise<boolean>;
  }>;
  pidSafetyDependencies?: Readonly<{
    readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
    readProcessRunStateFn?: typeof readProcessRunState;
  }>;
  fileState: DaemonLocallyPersistedState;
  currentCliVersion: string;
  isShuttingDown?: () => boolean;
  requestSelfRestart?: RequestDaemonSelfRestart;
}>): NodeJS.Timeout {
  const {
    trackedSessionsByKey,
    spawnResourceCleanupByKey,
    sessionAttachCleanupByKey,
    getApiMachineForSessions,
    onChildExited,
    pidSafetyDependencies,
    fileState,
    currentCliVersion,
    isShuttingDown,
    requestSelfRestart = requestDaemonSelfRestart,
  } = params;

  const onChildExitedForPrune =
    onChildExited ??
    createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey,
      sessionAttachCleanupByKey,
      getApiMachineForSessions,
    });

  const observeHealthySession = async (tracked: TrackedSession): Promise<void> => {
    if (isCurrentTrackedSession(trackedSessionsByKey, tracked)
      && isShuttingDown?.() !== true
      && typeof tracked.stopRequestedAtMs !== 'number'
      && tracked.reportMarkerCustody?.retiring !== true) {
      await params.onTrackedSessionHealthy?.(tracked);
    }
  };

  // Periodically: observe runners whose exit the daemon cannot see, and restart onto a newer installed
  // CLI. Daemon state is published on real changes by its owners, never re-written per tick.
  const heartbeatIntervalMs = parsePositiveInt(process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL, 30_000);
  const restartVerifyTimeoutMs = readDaemonRestartVerifyTimeoutMs();
  const restartVerifyPollMs = readDaemonRestartVerifyPollMs();
  let heartbeatRunning = false;
  let lastAllocatorTrimAt: number | null = null;
  let sessionHandoffPrepareTargetRecoveryPromise: Promise<void> | null = null;

  const ensureSessionHandoffPrepareTargetRecovery = (): Promise<void> => {
    if (sessionHandoffPrepareTargetRecoveryPromise) {
      return sessionHandoffPrepareTargetRecoveryPromise;
    }
    sessionHandoffPrepareTargetRecoveryPromise = (async () => {
      let retryDeferredRecovery = false;
      try {
        const recovery = await recoverSessionHandoffPrepareTargetJobsAfterRestart({
          activeServerDir: configuration.activeServerDir,
          nowMs: Date.now(),
        });
        retryDeferredRecovery = recovery.deferredByLiveRunnerLease;
      } catch (error) {
        retryDeferredRecovery = true;
        logger.debug('[DAEMON RUN] Failed to recover session-handoff prepare-target jobs', error);
      } finally {
        if (retryDeferredRecovery) {
          // A replacement daemon can overlap the old runner briefly. Reuse the
          // existing heartbeat cadence only until startup recovery is no longer
          // blocked; terminal and explicitly resumable jobs remain passive.
          sessionHandoffPrepareTargetRecoveryPromise = null;
        }
      }
    })();
    return sessionHandoffPrepareTargetRecoveryPromise;
  };

  // Retired workspace-replication state is owned by the workspace-sync
  // production composition, which inspects it once per installation startup
  // and fails its entry points closed with the typed legacy-state code.
  // Do not put this maintenance back into the generic heartbeat.
  void ensureSessionHandoffPrepareTargetRecovery();
  // Startup edge: runners that ended while no daemon was watching. Later exits retire their own state.
  void params.retireEndedRunnerOwnedState?.().catch(error => {
    logger.warn('[DAEMON RUN] Ended-runner state retirement at startup failed; the next runner exit retries it', { error });
  });

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

      await ensureSessionHandoffPrepareTargetRecovery();
      if (isShuttingDown?.() === true) {
        return;
      }

      // One process-table sample serves this tick's tracked runner observations.
      // Node child handles remain authoritative and require no census.
      const observedPids = [...trackedSessionsByKey.values()].flatMap(tracked => {
        const child = tracked.childProcess;
        if (!tracked.windowsTerminalLaunchCustody && tracked.startedBy === 'daemon'
          && child?.pid === tracked.pid && child.exitCode === null && child.signalCode === null) return [];
        return [tracked.pid, ...(child?.pid ? [child.pid] : []),
          ...(tracked.runnerProcessIdentity ? [tracked.runnerProcessIdentity.pid] : [])];
      });
      const observations = await readProcessIdentitiesByPid(observedPids);
      const readIdentity: typeof readProcessIdentityByPid = pidSafetyDependencies?.readProcessIdentityByPidFn
        ?? (async pid => observations.get(pid) ?? null);
      const readRunState: typeof readProcessRunState = pidSafetyDependencies?.readProcessRunStateFn
        ?? (async pid => readProcessRunState(pid, { observedProcess: observations.get(pid) ?? null }));
      // Prune stale sessions
      for (const tracked of trackedSessionsByKey.values()) {
        const pid = tracked.pid;
        // The child handle remains authoritative until Node reports its exit.
        // A process-table observation can race that notification.
        if (tracked.windowsTerminalLaunchCustody) {
          const presence = await classifyTrackedSessionProcessPresence({
            tracked,
            readProcessRunState: readRunState,
            readProcessIdentityByPid: readIdentity,
          });
          if (isShuttingDown?.() === true) return;
          if (!isCurrentTrackedSession(trackedSessionsByKey, tracked)) continue;
          if (presence === 'absent') {
            await onChildExitedForPrune(pid, { reason: 'process-missing', code: null, signal: null });
          } else if (presence === 'present') {
            await observeHealthySession(tracked);
          } else {
            logger.infoFile('[DAEMON RUN] Pending Windows runner presence unresolved; retaining startup custody', { pid });
          }
          continue;
        }
        const childProcess = tracked.childProcess;
        if (
          tracked.startedBy === 'daemon'
          && childProcess?.pid === pid
          && childProcess.exitCode === null
          && childProcess.signalCode === null
        ) {
          await observeHealthySession(tracked);
          continue;
        }
        const runState = await readRunState(pid).catch(() => null);
        if (isShuttingDown?.() === true) return;
        if (!isCurrentTrackedSession(trackedSessionsByKey, tracked)) continue;
        if (runState === 'dead' || runState === 'zombie') {
          logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (run state: ${runState})`);
          await onChildExitedForPrune(pid, { reason: 'process-missing', code: null, signal: null });
          continue;
        }
        if (!isPidPresent(pid)) {
          if (isShuttingDown?.() === true) {
            return;
          }
          logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
          await onChildExitedForPrune(pid, { reason: 'process-missing', code: null, signal: null });
          continue;
        }
        const expectedProcessStartTimeMs = tracked.processStartTimeMs;
        if (expectedProcessStartTimeMs === undefined) {
          await observeHealthySession(tracked);
          continue;
        }
        const processIdentity = await readIdentity(pid).catch(() => null);
        const currentTracked = trackedSessionsByKey.get(tracked.trackingKey);
        if (
          currentTracked !== tracked
          || currentTracked.processStartTimeMs !== expectedProcessStartTimeMs
        ) {
          continue;
        }
        if (!processGenerationProvesReuse(expectedProcessStartTimeMs, processIdentity?.processStartTimeMs)) {
          await observeHealthySession(tracked);
          continue;
        }
        logger.debug(
          `[DAEMON RUN] Removing stale session with PID ${pid} (process identity no longer matches)`,
        );
        if (isShuttingDown?.() === true) {
          return;
        }
        await onChildExitedForPrune(pid, {
          reason: 'process-missing',
          code: null,
          signal: null,
        });
      }

      // Cleanup any spawn resources for Sessions no longer tracked.
      const cleanupKeyMapIfUntracked = async (map: ReadonlyMap<SessionTrackingKey, unknown>) => {
        for (const trackingKey of [...map.keys()]) {
          if (trackedSessionsByKey.has(trackingKey)) continue;
          await cleanupSessionResources({
            trackingKey,
            spawnResourceCleanupByKey,
            sessionAttachCleanupByKey,
          });
        }
      };

      await cleanupKeyMapIfUntracked(spawnResourceCleanupByKey);
      await cleanupKeyMapIfUntracked(sessionAttachCleanupByKey);

      // Check if daemon needs update
      // If version on disk is different from the one in package.json - we need to restart
      // BIG if - does this get updated from underneath us on npm upgrade?
      const projectVersion = resolveComparableCliVersion({
        fallbackVersion: currentCliVersion,
        projectRootPath: projectPath(),
        readFileSyncImpl: readFileSync,
      });

      if (isShuttingDown?.() === true) {
        return;
      }
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

      // The idle glibc probe retained ~455 MB of its 513 MB release at +10m;
      // only another ~27 MB regrew by +20m. Reuse heartbeat instead of adding
      // a timer or paying for a trim on every 30-second maintenance tick.
      const allocatorMaintenance = params.allocatorMaintenance;
      if (allocatorMaintenance && isShuttingDown?.() !== true
        && (lastAllocatorTrimAt === null || Date.now() - lastAllocatorTrimAt >= 10 * 60_000)) {
        try {
          if ((await allocatorMaintenance.activity.readDecision()).kind === 'idle'
            && isShuttingDown?.() !== true) {
            lastAllocatorTrimAt = Date.now();
            const startedAt = performance.now();
            const released = await allocatorMaintenance.trim();
            logger.debug('[DAEMON RUN] Allocator maintenance completed', {
              released, durationMs: performance.now() - startedAt,
            });
          }
        } catch (error) {
          logger.debug('[DAEMON RUN] Allocator maintenance failed', error);
        }
      }
    } catch (error) {
      // This is defensive: any unexpected error in the async interval callback should not permanently stop the loop.
      logger.debug('[DAEMON RUN] Heartbeat loop tick failed', error);
    } finally {
      heartbeatRunning = false;
    }
  }, heartbeatIntervalMs);

  return intervalHandle;
}
