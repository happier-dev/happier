/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from '@/ui/logger';
import { clearDaemonState, readDaemonState } from '@/persistence';
import { Metadata } from '@/api/types';
import { projectPath } from '@/projectPath';
import { readFileSync, statSync } from 'fs';
import { configuration } from '@/configuration';
import type { SpawnDaemonSessionRequest } from '@/rpc/handlers/spawnSessionOptionsContract';
import { resolveComparableCliVersion } from './resolveComparableCliVersion';

export type DaemonControlRequestOptions = {
  timeoutMs?: number;
};

const DEFAULT_DAEMON_HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_DAEMON_SPAWN_HTTP_TIMEOUT_MS = 120_000;
const DEFAULT_DAEMON_PING_TIMEOUT_MS = 3_000;
const DEFAULT_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS = 12_000;
const DEFAULT_DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_MS = 10_000;
const DAEMON_PING_UNREACHABLE_STARTUP_GRACE_MS = 60_000;
const DAEMON_HTTP_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_HTTP_TIMEOUT';
const DAEMON_SPAWN_HTTP_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_SPAWN_HTTP_TIMEOUT';
const DAEMON_PING_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_PING_TIMEOUT_MS';
const DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS';
const DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_ENV_KEY = 'HAPPIER_DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_MS';

function resolveDaemonStateAgeMs(state: unknown): number | null {
  if (state && typeof state === 'object') {
    const startedAt = (state as any).startedAt;
    if (typeof startedAt === 'number' && Number.isFinite(startedAt)) {
      return Math.max(0, Date.now() - startedAt);
    }
  }

  // Fall back to file mtime if startedAt is missing; helps avoid deleting freshly written state.
  try {
    const stat = statSync(configuration.daemonStateFile);
    if (Number.isFinite(stat.mtimeMs)) {
      return Math.max(0, Date.now() - stat.mtimeMs);
    }
  } catch {
    // ignore
  }

  return null;
}

function resolvePositiveIntValue(
  raw: string | number | undefined,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (raw === undefined) return fallback;
  const parsed =
    typeof raw === 'number'
      ? raw
      : raw.trim().length > 0
        ? Number.parseInt(raw, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(parsed)));
}

function resolveDaemonControlTimeoutMs(path: string, options: DaemonControlRequestOptions): number {
  if (options.timeoutMs !== undefined) {
    return resolvePositiveIntValue(options.timeoutMs, DEFAULT_DAEMON_HTTP_TIMEOUT_MS, { min: 100, max: 300_000 });
  }

  if (path === '/spawn-session') {
    const rawSpawnTimeout = process.env[DAEMON_SPAWN_HTTP_TIMEOUT_ENV_KEY];
    if (rawSpawnTimeout !== undefined && String(rawSpawnTimeout).trim().length > 0) {
      return resolvePositiveIntValue(rawSpawnTimeout, DEFAULT_DAEMON_SPAWN_HTTP_TIMEOUT_MS, {
        min: 100,
        max: 300_000,
      });
    }
    return resolvePositiveIntValue(process.env[DAEMON_HTTP_TIMEOUT_ENV_KEY], DEFAULT_DAEMON_SPAWN_HTTP_TIMEOUT_MS, {
      min: 100,
      max: 300_000,
    });
  }

  return resolvePositiveIntValue(process.env[DAEMON_HTTP_TIMEOUT_ENV_KEY], DEFAULT_DAEMON_HTTP_TIMEOUT_MS, {
    min: 100,
    max: 300_000,
  });
}

function resolveDaemonPingTimeoutMs(): number {
  return resolvePositiveIntValue(process.env[DAEMON_PING_TIMEOUT_ENV_KEY], DEFAULT_DAEMON_PING_TIMEOUT_MS, {
    min: 100,
    max: 300_000,
  });
}

function resolveDaemonStopWaitForDeathTimeoutMs(): number {
  const rawExplicit = process.env[DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_ENV_KEY];
  if (rawExplicit !== undefined && String(rawExplicit).trim().length > 0) {
    return resolvePositiveIntValue(rawExplicit, DEFAULT_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS, {
      min: 0,
      max: 300_000,
    });
  }

  const rawDrainGrace = process.env[DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_ENV_KEY];
  const drainGraceMs = resolvePositiveIntValue(rawDrainGrace, DEFAULT_DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_MS, {
    min: 0,
    max: 120_000,
  });

  return Math.max(DEFAULT_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS, drainGraceMs + 2_000);
}

export type DaemonRunningInspection =
  | { status: 'not-running' }
  | { status: 'starting'; state: NonNullable<Awaited<ReturnType<typeof readDaemonState>>> }
  | { status: 'running'; state: NonNullable<Awaited<ReturnType<typeof readDaemonState>>> };

export async function inspectDaemonRunningStateAndCleanupStaleState(): Promise<DaemonRunningInspection> {
  const state = await readDaemonState();
  if (!state) {
    return { status: 'not-running' };
  }

  if (state.controlToken && (!state.httpPort || typeof state.httpPort !== 'number')) {
    logger.debug('[DAEMON RUN] Daemon state missing httpPort, cleaning up state');
    await cleanupDaemonState();
    return { status: 'not-running' };
  }

  try {
    process.kill(state.pid, 0);
    if (state.controlToken) {
      const ping = await daemonPost('/ping', undefined, { timeoutMs: resolveDaemonPingTimeoutMs() });

      if (ping && typeof ping === 'object' && (ping as any).success === false) {
        logger.debug('[DAEMON RUN] Daemon /ping rejected control token, cleaning up state');
        await cleanupDaemonState();
        return { status: 'not-running' };
      }

      if (ping?.error) {
        const ageMs = resolveDaemonStateAgeMs(state);
        if (ageMs !== null && ageMs < DAEMON_PING_UNREACHABLE_STARTUP_GRACE_MS) {
          logger.debug('[DAEMON RUN] Daemon /ping unreachable during startup grace window, keeping state');
          return { status: 'starting', state };
        }

        logger.debug('[DAEMON RUN] Daemon control server did not respond to /ping, cleaning up state');
        await cleanupDaemonState();
        return { status: 'not-running' };
      }
    }

    return { status: 'running', state };
  } catch {
    logger.debug('[DAEMON RUN] Daemon PID not running, cleaning up state');
    await cleanupDaemonState();
    return { status: 'not-running' };
  }
}

async function daemonPost(path: string, body?: any, options: DaemonControlRequestOptions = {}): Promise<{ error?: string } | any> {
  const state = await readDaemonState();
  if (!state?.httpPort) {
    const errorMessage = 'No daemon running, no state file found';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  try {
    process.kill(state.pid, 0);
  } catch (error) {
    const errorMessage = 'Daemon is not running, file is stale';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  try {
    const timeout = resolveDaemonControlTimeoutMs(path, options);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (state.controlToken) {
      headers['x-happier-daemon-token'] = state.controlToken;
    }
    const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
      // Mostly increased for stress test
      signal: AbortSignal.timeout(timeout)
    });
    
    const rawBody = await response.text();
    let parsedBody: unknown = null;
    if (rawBody.trim().length > 0) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = rawBody;
      }
    }

    if (!response.ok) {
      const responseObject =
        parsedBody && typeof parsedBody === 'object' ? (parsedBody as Record<string, unknown>) : null;
      // If the daemon control server returns a structured payload (e.g. {success:false,...}),
      // preserve it so callers can act on fields like requiresUserApproval/errorCode.
      if (responseObject && typeof responseObject.success === 'boolean') {
        return responseObject;
      }

      const remoteErrorCode =
        responseObject && typeof responseObject.errorCode === 'string' ? responseObject.errorCode : undefined;

      const remoteErrorMessage =
        responseObject && typeof responseObject.error === 'string'
          ? responseObject.error
          : responseObject && typeof responseObject.message === 'string'
            ? responseObject.message
            : undefined;

      const detailSuffix = [remoteErrorCode, remoteErrorMessage].filter(Boolean).join(': ');
      const errorMessage = `Request failed: ${path}, HTTP ${response.status}${detailSuffix ? ` (${detailSuffix})` : ''}`;
      logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
      return {
        error: errorMessage,
        errorCode: remoteErrorCode,
        response: parsedBody,
      };
    }
    
    return parsedBody ?? {};
  } catch (error) {
    const errorMessage = `Request failed: ${path}, ${error instanceof Error ? error.message : 'Unknown error'}`;
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    }
  }
}

export async function notifyDaemonSessionStarted(
  sessionId: string,
  metadata: Metadata,
  options: DaemonControlRequestOptions = {},
): Promise<{ error?: string } | any> {
  return await daemonPost('/session-started', {
    sessionId,
    metadata
  }, options);
}

export async function listDaemonSessions(): Promise<any[]> {
  const result = await daemonPost('/list');
  return result.children || [];
}

export async function stopDaemonSession(sessionId: string): Promise<boolean> {
  const result = await daemonPost('/stop-session', { sessionId });
  return result.success || false;
}

export async function spawnDaemonSession(directory: string, sessionId?: string): Promise<any>;
export async function spawnDaemonSession(request: SpawnDaemonSessionRequest): Promise<any>;
export async function spawnDaemonSession(
  directoryOrRequest: string | SpawnDaemonSessionRequest,
  sessionId?: string,
): Promise<any> {
  const request = typeof directoryOrRequest === 'string'
    ? { directory: directoryOrRequest, ...(sessionId ? { sessionId } : {}) }
    : directoryOrRequest;

  const result = await daemonPost('/spawn-session', request);
  return result;
}

export async function stopDaemonHttp(params: { stopSessions?: boolean } = {}): Promise<void> {
  const result = await daemonPost('/stop', params.stopSessions ? { stopSessions: true } : {});
  if (result?.error) {
    throw new Error(result.error);
  }
}

/**
 * Best-effort health check for a running daemon.
 * Returns false and clears stale state when the PID is dead or (when available) the control token cannot /ping.
 */
export async function checkIfDaemonRunningAndCleanupStaleState(): Promise<boolean> {
  const inspection = await inspectDaemonRunningStateAndCleanupStaleState();
  return inspection.status === 'running';
}

/**
 * Check if the running daemon version matches the current CLI version.
 * This should work from both the daemon itself & a new CLI process.
 * Works via the daemon.state.json file.
 * 
 * @returns true if versions match, false if versions differ or no daemon running
 */
export async function isDaemonRunningCurrentlyInstalledHappyVersion(params: Readonly<{
  expectedMachineId?: string | null;
}> = {}): Promise<boolean> {
  logger.debug('[DAEMON CONTROL] Checking if daemon is running same version');
  const runningDaemon = await inspectDaemonRunningStateAndCleanupStaleState();
  if (runningDaemon.status === 'not-running') {
    logger.debug('[DAEMON CONTROL] No daemon running, returning false');
    return false;
  }

  const state = runningDaemon.state;

  const expectedMachineId = typeof params.expectedMachineId === 'string' ? params.expectedMachineId.trim() : '';
  if (expectedMachineId) {
    const stateMachineId = typeof state.machineId === 'string' ? state.machineId.trim() : '';
    if (!stateMachineId || stateMachineId !== expectedMachineId) {
      logger.debug(
        `[DAEMON CONTROL] Running daemon machine mismatch. expected=${expectedMachineId} actual=${stateMachineId || 'missing'}`,
      );
      return false;
    }
  }
  
  try {
    const currentCliVersion = resolveComparableCliVersion({
      fallbackVersion: configuration.currentCliVersion,
      projectRootPath: projectPath(),
      readFileSyncImpl: readFileSync,
    });
    
    logger.debug(
      `[DAEMON CONTROL] Current CLI version: ${currentCliVersion}, Daemon started with version: ${state.startedWithCliVersion}, status=${runningDaemon.status}`,
    );
    return currentCliVersion === state.startedWithCliVersion;
  } catch (error) {
    logger.debug('[DAEMON CONTROL] Error checking daemon version', error);
    return false;
  }
}

export async function cleanupDaemonState(): Promise<void> {
  try {
    await clearDaemonState();
    logger.debug('[DAEMON RUN] Daemon state file removed');
  } catch (error) {
    logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
  }
}

export async function stopDaemon(params: { stopSessions?: boolean } = {}) {
  try {
    const state = await readDaemonState();
    if (!state) {
      logger.debug('No daemon state found');
      return;
    }

    logger.debug(`Stopping daemon with PID ${state.pid}`);

    // Try HTTP graceful stop
    try {
      await stopDaemonHttp({ stopSessions: params.stopSessions === true });

      // Wait for daemon to die
      await waitForProcessDeath(state.pid, resolveDaemonStopWaitForDeathTimeoutMs());
      await cleanupDaemonState();
      logger.debug('Daemon stopped gracefully via HTTP');
      return;
    } catch (error) {
      logger.debug('HTTP stop failed, will force kill', error);
    }

    const { findHappyProcessByPid } = await import('@/daemon/doctor');
    const proc = await findHappyProcessByPid(state.pid);
    const safeToKill = proc?.type === 'daemon' || proc?.type === 'dev-daemon';
    if (!safeToKill) {
      logger.warn(`[CONTROL CLIENT] Refusing to force-kill PID ${state.pid} (does not look like a happier daemon process)`);
      await cleanupDaemonState();
      return;
    }

    // Force kill (best-effort; prefer SIGTERM first).
    try {
      process.kill(state.pid, 'SIGTERM');
      await waitForProcessDeath(state.pid, 2000).catch(() => {});
      try {
        process.kill(state.pid, 0);
        process.kill(state.pid, 'SIGKILL');
      } catch {
        // already exited
      }
      await cleanupDaemonState();
      logger.debug('Force killed daemon (SIGTERM/SIGKILL)');
    } catch (error) {
      logger.debug('Daemon already dead');
    }
  } catch (error) {
    logger.debug('Error stopping daemon', error);
  }
}

async function waitForProcessDeath(pid: number, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch {
      return; // Process is dead
    }
  }
  throw new Error('Process did not die within timeout');
}
