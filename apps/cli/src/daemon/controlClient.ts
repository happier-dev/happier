/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from '@/ui/logger';
import { clearDaemonState, readDaemonState } from '@/persistence';
import { Metadata } from '@/api/types';
import { projectPath } from '@/projectPath';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { configuration } from '@/configuration';

export type DaemonControlRequestOptions = {
  timeoutMs?: number;
};

const DEFAULT_DAEMON_HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_DAEMON_SPAWN_HTTP_TIMEOUT_MS = 120_000;
const DAEMON_PING_TIMEOUT_MS = 1_000;
const DAEMON_PING_UNREACHABLE_STARTUP_GRACE_MS = 60_000;
const DAEMON_HTTP_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_HTTP_TIMEOUT';
const DAEMON_SPAWN_HTTP_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_SPAWN_HTTP_TIMEOUT';

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

export async function spawnDaemonSession(directory: string, sessionId?: string): Promise<any> {
  const result = await daemonPost('/spawn-session', { directory, sessionId });
  return result;
}

export async function stopDaemonHttp(): Promise<void> {
  const result = await daemonPost('/stop');
  if (result?.error) {
    throw new Error(result.error);
  }
}

/**
 * Best-effort health check for a running daemon.
 * Returns false and clears stale state when the PID is dead or (when available) the control token cannot /ping.
 */
export async function checkIfDaemonRunningAndCleanupStaleState(): Promise<boolean> {
  const state = await readDaemonState();
  if (!state) {
    return false;
  }

  if (state.controlToken && (!state.httpPort || typeof state.httpPort !== 'number')) {
    logger.debug('[DAEMON RUN] Daemon state missing httpPort, cleaning up state');
    await cleanupDaemonState();
    return false;
  }

  // Check if the daemon is running
  try {
    process.kill(state.pid, 0);
    // If the daemon state includes a control token, also verify that the control server responds.
    // This prevents PID reuse + stale port files from being treated as a healthy daemon.
    if (state.controlToken) {
      const ping = await daemonPost('/ping', undefined, { timeoutMs: DAEMON_PING_TIMEOUT_MS });

      // If we can conclusively authenticate and still fail, the token/state is stale and must be removed.
      if (ping && typeof ping === 'object' && (ping as any).success === false) {
        logger.debug('[DAEMON RUN] Daemon /ping rejected control token, cleaning up state');
        await cleanupDaemonState();
        return false;
      }

      if (ping?.error) {
        const ageMs = resolveDaemonStateAgeMs(state);
        if (ageMs !== null && ageMs < DAEMON_PING_UNREACHABLE_STARTUP_GRACE_MS) {
          // During startup, the daemon may have written state before the control server is accepting connections.
          // Keeping the state avoids flaking readiness checks that poll /ping in a tight loop.
          logger.debug('[DAEMON RUN] Daemon /ping unreachable during startup grace window, keeping state');
          return false;
        }

        logger.debug('[DAEMON RUN] Daemon control server did not respond to /ping, cleaning up state');
        await cleanupDaemonState();
        return false;
      }
    }

    return true;
  } catch {
    logger.debug('[DAEMON RUN] Daemon PID not running, cleaning up state');
    await cleanupDaemonState();
    return false;
  }
}

/**
 * Check if the running daemon version matches the current CLI version.
 * This should work from both the daemon itself & a new CLI process.
 * Works via the daemon.state.json file.
 * 
 * @returns true if versions match, false if versions differ or no daemon running
 */
export async function isDaemonRunningCurrentlyInstalledHappyVersion(): Promise<boolean> {
  logger.debug('[DAEMON CONTROL] Checking if daemon is running same version');
  const runningDaemon = await checkIfDaemonRunningAndCleanupStaleState();
  if (!runningDaemon) {
    logger.debug('[DAEMON CONTROL] No daemon running, returning false');
    return false;
  }

  const state = await readDaemonState();
  if (!state) {
    logger.debug('[DAEMON CONTROL] No daemon state found, returning false');
    return false;
  }
  
  try {
    // Read package.json on demand from disk - so we are guaranteed to get the latest version
    const packageJsonPath = join(projectPath(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const currentCliVersion = packageJson.version;
    
    logger.debug(`[DAEMON CONTROL] Current CLI version: ${currentCliVersion}, Daemon started with version: ${state.startedWithCliVersion}`);
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

export async function stopDaemon() {
  try {
    const state = await readDaemonState();
    if (!state) {
      logger.debug('No daemon state found');
      return;
    }

    logger.debug(`Stopping daemon with PID ${state.pid}`);

    // Try HTTP graceful stop
    try {
      await stopDaemonHttp();

      // Wait for daemon to die
      await waitForProcessDeath(state.pid, 2000);
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
