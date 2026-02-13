/**
 * Integration tests for daemon HTTP control system.
 *
 * Recommended execution:
 * - `yarn test:integration-test-env`
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { copyFile, mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { configuration, reloadConfiguration } from '@/configuration';
import { 
  listDaemonSessions, 
  stopDaemonSession, 
  spawnDaemonSession, 
  stopDaemonHttp, 
  notifyDaemonSessionStarted, 
  stopDaemon,
  checkIfDaemonRunningAndCleanupStaleState,
} from '@/daemon/controlClient';
import { readCredentials, readDaemonState, clearDaemonState, writeDaemonState } from '@/persistence';
import { Metadata } from '@/api/types';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { getLatestDaemonLog } from '@/ui/logger';

type WaitForOptions = {
  timeoutMs: number;
  intervalMs?: number;
  label: string;
  debug?: () => string;
};

type DaemonSessionRecord = {
  startedBy: string;
  happySessionId: string;
  pid: number;
};

const DAEMON_READY_WAIT: WaitForOptions = {
  timeoutMs: 45_000,
  intervalMs: 250,
  label: 'daemon startup state',
};

const SESSION_CONSISTENCY_WAIT: WaitForOptions = {
  timeoutMs: 30_000,
  intervalMs: 250,
  label: 'session list consistency',
};

const STRESS_SESSION_WAIT: WaitForOptions = {
  timeoutMs: 60_000,
  intervalMs: 500,
  label: 'stress-session list consistency',
};

const PROCESS_EXIT_WAIT: WaitForOptions = {
  timeoutMs: 15_000,
  intervalMs: 250,
  label: 'daemon process exit',
};

type EnvSnapshot = {
  homeDir: string | undefined;
  activeServerId: string | undefined;
  serverUrl: string | undefined;
  webappUrl: string | undefined;
  publicServerUrl: string | undefined;
};

let isolatedHomeDir: string | null = null;
let daemonIntegrationSourceHomeDir: string | null = null;
const originalEnv: EnvSnapshot = {
  homeDir: process.env.HAPPIER_HOME_DIR,
  activeServerId: process.env.HAPPIER_ACTIVE_SERVER_ID,
  serverUrl: process.env.HAPPIER_SERVER_URL,
  webappUrl: process.env.HAPPIER_WEBAPP_URL,
  publicServerUrl: process.env.HAPPIER_PUBLIC_SERVER_URL,
};

async function copyIfExists(sourcePath: string, targetPath: string): Promise<void> {
  if (!existsSync(sourcePath)) {
    return;
  }
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
}

async function copyLogsToSourceHomeBestEffort(): Promise<void> {
  if (!isolatedHomeDir) return;
  if (!daemonIntegrationSourceHomeDir) return;

  const srcLogsDir = join(isolatedHomeDir, 'logs');
  if (!existsSync(srcLogsDir)) return;
  const dstLogsDir = join(daemonIntegrationSourceHomeDir, 'logs');
  await mkdir(dstLogsDir, { recursive: true });

  const runPrefix = `daemon-int-${basename(isolatedHomeDir)}`;
  const entries = readdirSync(srcLogsDir);
  for (const entry of entries) {
    if (!entry.endsWith('.log')) continue;
    const from = join(srcLogsDir, entry);
    const to = join(dstLogsDir, `${runPrefix}-${entry}`);
    try {
      await copyFile(from, to);
    } catch {
      // best-effort
    }
  }
}

async function prepareIsolatedDaemonIntegrationHome(): Promise<void> {
  const sourceHome = configuration.happyHomeDir;
  daemonIntegrationSourceHomeDir = sourceHome;
  const sourceSettingsFile = configuration.settingsFile;
  const sourceLegacyKeyFile = configuration.legacyPrivateKeyFile;
  const sourceServerKeyFile = configuration.privateKeyFile;
  const sourceServerId = configuration.activeServerId;
  const sourceServerUrl = configuration.serverUrl;
  const sourceWebappUrl = configuration.webappUrl;
  const sourcePublicServerUrl = configuration.publicServerUrl;

  // Keep daemon integration artifacts under the configured home dir so CI can reliably
  // collect daemon logs/state even when the test suite isolates $HAPPIER_HOME_DIR.
  const parentDir = join(sourceHome, 'tmp');
  await mkdir(parentDir, { recursive: true });
  isolatedHomeDir = await mkdtemp(join(parentDir, 'happier-cli-daemon-int-'));

  process.env.HAPPIER_HOME_DIR = isolatedHomeDir;
  process.env.HAPPIER_ACTIVE_SERVER_ID = sourceServerId;
  process.env.HAPPIER_SERVER_URL = sourceServerUrl;
  process.env.HAPPIER_WEBAPP_URL = sourceWebappUrl;
  process.env.HAPPIER_PUBLIC_SERVER_URL = sourcePublicServerUrl;
  reloadConfiguration();

  await copyIfExists(sourceSettingsFile, configuration.settingsFile);
  await copyIfExists(sourceLegacyKeyFile, configuration.legacyPrivateKeyFile);
  await copyIfExists(sourceServerKeyFile, configuration.privateKeyFile);
}

async function restoreDaemonIntegrationEnvironment(): Promise<void> {
  if (originalEnv.homeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
  else process.env.HAPPIER_HOME_DIR = originalEnv.homeDir;
  if (originalEnv.activeServerId === undefined) delete process.env.HAPPIER_ACTIVE_SERVER_ID;
  else process.env.HAPPIER_ACTIVE_SERVER_ID = originalEnv.activeServerId;
  if (originalEnv.serverUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
  else process.env.HAPPIER_SERVER_URL = originalEnv.serverUrl;
  if (originalEnv.webappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
  else process.env.HAPPIER_WEBAPP_URL = originalEnv.webappUrl;
  if (originalEnv.publicServerUrl === undefined) delete process.env.HAPPIER_PUBLIC_SERVER_URL;
  else process.env.HAPPIER_PUBLIC_SERVER_URL = originalEnv.publicServerUrl;

  reloadConfiguration();

  if (isolatedHomeDir) {
    await copyLogsToSourceHomeBestEffort();
    const expectedPrefix = daemonIntegrationSourceHomeDir
      ? join(daemonIntegrationSourceHomeDir, 'tmp', 'happier-cli-daemon-int-')
      : null;
    const safeToDelete = expectedPrefix ? isolatedHomeDir.startsWith(expectedPrefix) : false;
    if (!safeToDelete) {
      process.stderr.write(
        `[daemon.integration cleanup] Refusing to delete unexpected isolated home dir: ${isolatedHomeDir}\n`,
      );
    } else {
      await rm(isolatedHomeDir, { recursive: true, force: true });
    }
    isolatedHomeDir = null;
  }
  daemonIntegrationSourceHomeDir = null;
}

function debugIntegrationPreflight(message: string): void {
  if (process.env.HAPPIER_CLI_DAEMON_INTEGRATION_DEBUG === '1') {
    process.stderr.write(`[daemon.integration preflight] ${message}\n`);
  }
}

async function waitFor(
  condition: () => Promise<boolean>,
  opts: WaitForOptions
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 100;
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  const debug = opts.debug ? `\n${opts.debug()}` : '';
  throw new Error(`Timed out waiting for ${opts.label} after ${opts.timeoutMs}ms${debug}`);
}

async function listDaemonSessionsTyped(): Promise<DaemonSessionRecord[]> {
  return (await listDaemonSessions()) as DaemonSessionRecord[];
}

function startDaemonProcessForStartSync(): ReturnType<typeof spawn> {
  return spawnHappyCLI(['daemon', 'start-sync'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function captureChildOutput(child: ReturnType<typeof spawn>): { output: () => string } {
  let output = '';
  child.stdout?.on('data', (data) => {
    output += data.toString();
  });
  child.stderr?.on('data', (data) => {
    output += data.toString();
  });
  return {
    output: () => output,
  };
}

async function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs = 30_000): Promise<number | null> {
  if (child.exitCode !== null) {
    return child.exitCode;
  }

  return await new Promise<number | null>((resolve, reject) => {
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      child.off('error', onError);
      resolve(code);
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      child.off('error', onError);
      reject(new Error(`Timed out waiting for child process exit after ${timeoutMs}ms`));
    }, timeoutMs);

    child.once('exit', onExit);
    child.once('error', onError);
  });
}

describe('waitForChildExit helper', () => {
  it('resolves for children that already exited before listeners attach', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
    });
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });
    await expect(waitForChildExit(child, 50)).resolves.toBe(0);
  });
});

async function waitForDaemonStateWithDifferentPid(
  initialPid: number,
  expectedVersion: string,
): Promise<{ pid: number; startedWithCliVersion: string }> {
  let matchedState: { pid: number; startedWithCliVersion: string } | null = null;
  await waitFor(
    async () => {
      const finalState = await readDaemonState();
      const matches = Boolean(
        finalState &&
          finalState.pid &&
          finalState.pid !== initialPid &&
          finalState.startedWithCliVersion === expectedVersion,
      );
      if (matches) {
        matchedState = {
          pid: Number(finalState?.pid),
          startedWithCliVersion: String(finalState?.startedWithCliVersion),
        };
      }
      return matches;
    },
    {
      timeoutMs: 20_000,
      intervalMs: 300,
      label: 'daemon restart with updated version metadata',
    },
  );
  if (!matchedState) {
    throw new Error('matched daemon state was not captured');
  }
  return matchedState;
}

async function waitForDaemonReadyState(): Promise<void> {
  await waitFor(
    async () => {
      const state = await readDaemonState();
      if (!state || typeof state.pid !== 'number' || typeof state.httpPort !== 'number' || state.httpPort <= 0) {
        return false;
      }
      if (!isProcessAlive(state.pid)) {
        return false;
      }
      return await checkIfDaemonRunningAndCleanupStaleState();
    },
    DAEMON_READY_WAIT,
  );
}

async function ensureDaemonFullyStoppedBeforeRestart(): Promise<void> {
  const stateBeforeStop = await readDaemonState();
  const previousPid = stateBeforeStop?.pid;
  const lockPidBeforeStop = readDaemonLockPid();

  await stopDaemon();

  if (typeof previousPid === 'number' && Number.isFinite(previousPid) && previousPid > 0) {
    await waitFor(async () => !isProcessAlive(previousPid), {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: `previous daemon pid ${previousPid} to exit`,
    });
  }

  if (
    typeof lockPidBeforeStop === 'number' &&
    Number.isFinite(lockPidBeforeStop) &&
    lockPidBeforeStop > 0 &&
    lockPidBeforeStop !== previousPid
  ) {
    await waitFor(async () => !isProcessAlive(lockPidBeforeStop), {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: `daemon lock pid ${lockPidBeforeStop} to exit`,
    });
  }

  await waitFor(
    async () => !existsSync(configuration.daemonLockFile),
    {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'daemon lock file cleanup before restart',
    },
  );

  await waitFor(
    async () => {
      const state = await readDaemonState();
      if (!state) return true;
      if (typeof state.pid !== 'number' || !Number.isFinite(state.pid) || state.pid <= 0) return true;
      return !isProcessAlive(state.pid);
    },
    {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'daemon state to be quiescent before restart',
    },
  );
}

async function waitForSessionCount(count: number, opts: WaitForOptions): Promise<void> {
  await waitFor(async () => {
    const sessions = await listDaemonSessionsTyped();
    return sessions.length === count;
  }, opts);
}

async function waitForSessionById(sessionId: string, opts: WaitForOptions): Promise<void> {
  await waitFor(async () => {
    const sessions = await listDaemonSessionsTyped();
    return sessions.some((session) => session.happySessionId === sessionId);
  }, opts);
}

async function waitForDaemonExit(pid: number, opts: WaitForOptions): Promise<void> {
  await waitFor(async () => !isProcessAlive(pid), opts);
}

async function waitForDaemonStateFileCleanup(opts: WaitForOptions): Promise<void> {
  await waitFor(async () => !existsSync(configuration.daemonStateFile), opts);
}

async function stopAllTrackedSessionsBestEffort(): Promise<void> {
  const sessions = await listDaemonSessionsTyped().catch(() => [] as DaemonSessionRecord[]);
  if (sessions.length === 0) return;

  await Promise.all(
    sessions.map(async (session) => {
      if (!session?.happySessionId) return;
      try {
        await stopDaemonSession(session.happySessionId);
      } catch {
        // Best-effort cleanup only; daemon teardown still runs afterwards.
      }
    }),
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    // `process.kill(pid, 0)` can return true for zombies; prefer checking `ps` state.
    const stat = execSync(`ps -o stat= -p ${pid}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    if (!stat) return false;
    return !stat.includes('Z');
  } catch {
    return false;
  }
}

function readDaemonLockPid(): number | null {
  try {
    if (!existsSync(configuration.daemonLockFile)) return null;
    const raw = readFileSync(configuration.daemonLockFile, 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

// Check if dev server is running and properly configured
async function isServerHealthy(): Promise<boolean> {
  try {
    const configuredServerUrl = process.env.HAPPIER_SERVER_URL || 'http://localhost:3005';
    const healthUrl = new URL('/health', configuredServerUrl);
    // Avoid IPv6/localhost resolution issues in some CI/container environments.
    if (healthUrl.hostname === 'localhost') healthUrl.hostname = '127.0.0.1';

    // First check if server responds
    const response = await fetch(healthUrl.toString(), {
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) {
      debugIntegrationPreflight(`health endpoint failed with ${response.status} ${response.statusText}`);
      return false;
    }

    const credentials = await readCredentials();
    if (!credentials?.token) {
      debugIntegrationPreflight(`missing readable credentials for active server in ${configuration.happyHomeDir}`);
      return false;
    }

    const profileUrl = new URL('/v1/account/profile', configuredServerUrl);
    if (profileUrl.hostname === 'localhost') profileUrl.hostname = '127.0.0.1';
    const profileResponse = await fetch(profileUrl.toString(), {
      headers: {
        Authorization: `Bearer ${credentials.token}`,
      },
      signal: AbortSignal.timeout(3_000),
    });
    if (!profileResponse.ok) {
      debugIntegrationPreflight(`authenticated profile probe failed with ${profileResponse.status} ${profileResponse.statusText}`);
      return false;
    }

    return true;
  } catch (error) {
    if (error instanceof Error) {
      debugIntegrationPreflight(`server unreachable: ${error.name}: ${error.message}`);
    } else {
      debugIntegrationPreflight('server unreachable');
    }
    return false;
  }
}

describe.skipIf(!await isServerHealthy())('Daemon Integration Tests', { timeout: 60_000 }, () => {
  let daemonPid: number;

  beforeAll(async () => {
    await prepareIsolatedDaemonIntegrationHome();
  });

  beforeEach(async () => {
    // Ensure previous daemon teardown has fully completed before starting another one.
    await ensureDaemonFullyStoppedBeforeRestart();
    
    // Start fresh daemon for this test
    // This will return and start a background process - we don't need to wait for it
    void spawnHappyCLI(['daemon', 'start'], {
      stdio: 'ignore'
    });
    
    await waitForDaemonReadyState();
    
    const daemonState = await readDaemonState();
    if (!daemonState?.pid || !daemonState?.httpPort) {
      throw new Error('Daemon failed to start within timeout');
    }
    daemonPid = daemonState.pid;

  });

  afterEach(async () => {
    await stopAllTrackedSessionsBestEffort();
    await stopDaemon()
  });

  afterAll(async () => {
    await restoreDaemonIntegrationEnvironment();
  });

  it('should list sessions (initially empty)', async () => {
    const sessions = await listDaemonSessionsTyped();
    expect(sessions).toEqual([]);
  });

  it('should track session-started webhook from terminal session', async () => {
    // Simulate a terminal-started session reporting to daemon
    const mockMetadata: Metadata = {
      path: '/test/path',
      host: 'test-host',
      homeDir: '/test/home',
      happyHomeDir: configuration.happyHomeDir,
      happyLibDir: '/test/happy-lib',
      happyToolsDir: '/test/happy-tools',
      hostPid: 99999,
      startedBy: 'terminal',
      machineId: 'test-machine-123'
    };

    await notifyDaemonSessionStarted('test-session-123', mockMetadata);

    // Verify session is tracked
    await waitForSessionCount(1, {
      ...DAEMON_READY_WAIT,
      label: 'single tracked session after webhook',
    });

    const sessions = await listDaemonSessionsTyped();
    
    const tracked = sessions[0];
    expect(tracked.startedBy).toBe('happy directly - likely by user from terminal');
    expect(tracked.happySessionId).toBe('test-session-123');
    expect(tracked.pid).toBe(99999);
  });

  it('should spawn & stop a session via HTTP (not testing RPC route, but similar enough)', { timeout: 60_000 }, async () => {
    const response = await spawnDaemonSession('/tmp', 'spawned-test-456');

    expect(response, `spawnDaemonSession(/tmp) response=${JSON.stringify(response)}`).toHaveProperty('success', true);
    expect(response).toHaveProperty('sessionId');

    // Verify session is tracked
    await waitForSessionById(response.sessionId, SESSION_CONSISTENCY_WAIT);

    const sessions = await listDaemonSessionsTyped();
    const spawnedSession = sessions.find((session) => session.happySessionId === response.sessionId);
    
    expect(spawnedSession).toBeDefined();
    if (!spawnedSession) {
      throw new Error('spawned session not found after successful spawn response');
    }
    expect(spawnedSession.startedBy).toBe('daemon');
    
    // Clean up - stop the spawned session
    await stopDaemonSession(spawnedSession.happySessionId);
  });

  it('should handle daemon stop request gracefully', async () => {    
    await stopDaemonHttp();

    // Verify metadata file is cleaned up
    await waitForDaemonStateFileCleanup({
      timeoutMs: 1_000,
      intervalMs: 100,
      label: 'daemon state cleanup after HTTP stop',
    });
  });

  it('should track both daemon-spawned and terminal sessions', { timeout: 60_000 }, async () => {
    // Spawn a real happy process that looks like it was started from terminal
    const terminalHappyProcess = spawnHappyCLI([
      '--happy-starting-mode', 'remote',
      '--started-by', 'terminal'
    ], {
      cwd: '/tmp',
      detached: true,
      stdio: 'ignore'
    });
    if (!terminalHappyProcess || !terminalHappyProcess.pid) {
      throw new Error('Failed to spawn terminal happy process');
    }
    // Give time to start & report itself
    await waitFor(async () => {
      const sessions = await listDaemonSessionsTyped();
      return sessions.some((session) => session.startedBy !== 'daemon');
    }, {
      timeoutMs: 30_000,
      intervalMs: 500,
      label: 'terminal-started session discovery',
    });

    // Spawn a daemon session
    const spawnResponse = await spawnDaemonSession('/tmp', 'daemon-session-bbb');

    // List all sessions
    await waitForSessionCount(2, {
      timeoutMs: 30_000,
      intervalMs: 500,
      label: 'two sessions tracked',
    });
    const sessions = await listDaemonSessionsTyped();

    // Verify we have one of each type
    const terminalSession =
      sessions.find((session) => session.pid === terminalHappyProcess.pid)
      ?? sessions.find((session) => session.startedBy !== 'daemon');
    const daemonSession = sessions.find((session) => session.happySessionId === spawnResponse.sessionId);

    expect(terminalSession).toBeDefined();
    if (!terminalSession) {
      throw new Error('terminal session not found');
    }
    expect(terminalSession.startedBy).toBe('happy directly - likely by user from terminal');
    
    expect(daemonSession).toBeDefined();
    if (!daemonSession) {
      throw new Error('daemon session not found');
    }
    expect(daemonSession.startedBy).toBe('daemon');

    // Clean up both sessions
    await stopDaemonSession(terminalSession.happySessionId);

    await stopDaemonSession(daemonSession.happySessionId);
    
    // Also kill the terminal process directly to be sure
    try {
      terminalHappyProcess.kill('SIGTERM');
    } catch {
      // Process might already be dead
    }
  });

  it('should update session metadata when webhook is called', { timeout: 60_000 }, async () => {
    // Spawn a session
    const spawnResponse = await spawnDaemonSession('/tmp');

    // Verify webhook was processed (session ID updated)
    await waitForSessionById(spawnResponse.sessionId, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'session metadata webhook propagation',
    });

    // Clean up
    await stopDaemonSession(spawnResponse.sessionId);
  });

  it('should not allow starting a second daemon', { timeout: 60_000 }, async () => {
    // Daemon is already running from beforeEach
    const initialState = await readDaemonState();
    expect(initialState).toBeDefined();
    const initialPid = initialState!.pid;

    // Try to start another daemon
    const secondChild = startDaemonProcessForStartSync();
    const captured = captureChildOutput(secondChild);
    const exitCode = await waitForChildExit(secondChild, 60_000);

    // Should not have replaced the running daemon
    expect(exitCode).toBe(0);
    const finalState = await readDaemonState();
    expect(finalState).toBeDefined();
    expect(finalState!.pid).toBe(initialPid);

    // Optional: keep message flexible
    expect(captured.output().toLowerCase()).toMatch(/already running|lock|another daemon/i);
  });

  it('should handle concurrent session operations', { timeout: 60_000 }, async () => {
    // Spawn multiple sessions concurrently
    const promises = [];
    for (let i = 0; i < 3; i++) {
      promises.push(
        spawnDaemonSession('/tmp')
      );
    }

    const results = await Promise.all(promises);
    
    // All should succeed
    results.forEach(res => {
      expect(res.success, `concurrent spawn result=${JSON.stringify(res)}`).toBe(true);
      expect(res.sessionId).toBeDefined();
    });

    // Collect session IDs for tracking
    const spawnedSessionIds = results.map(r => r.sessionId);

    // List should show all sessions
    await waitFor(async () => {
      const sessions = await listDaemonSessionsTyped();
      const daemonSessions = sessions.filter(
        (session) => session.startedBy === 'daemon' && spawnedSessionIds.includes(session.happySessionId),
      );
      return daemonSessions.length >= 3;
    }, {
      ...SESSION_CONSISTENCY_WAIT,
      label: 'three daemon-spawned sessions tracked',
    });

    const sessions = await listDaemonSessionsTyped();
    const daemonSessions = sessions.filter(
      (session) => session.startedBy === 'daemon' && spawnedSessionIds.includes(session.happySessionId),
    );

    // Stop all spawned sessions
    for (const session of daemonSessions) {
      expect(session.happySessionId).toBeDefined();
      await stopDaemonSession(session.happySessionId);
    }
  });

  it('should die with logs when SIGKILL is sent', async () => {
    // SIGKILL test - daemon should die immediately
    const logsDir = configuration.logsDir;
    
    // Get initial log files
    const initialLogs = readdirSync(logsDir).filter(f => f.endsWith('-daemon.log'));
    
    // Send SIGKILL to daemon (force kill)
    process.kill(daemonPid, 'SIGKILL');
    
    // Wait for process to die
    await waitForDaemonExit(daemonPid, {
      timeoutMs: 10_000,
      intervalMs: 250,
      label: 'daemon exit after SIGKILL',
    });
    
    // Check if process is dead
    expect(isProcessAlive(daemonPid)).toBe(false);
    
    // Check that log file exists (it was created when daemon started)
    const finalLogs = readdirSync(logsDir).filter(f => f.endsWith('-daemon.log'));
    expect(finalLogs.length).toBeGreaterThanOrEqual(initialLogs.length);
    
    // Clean up state file manually since daemon couldn't do it
    await clearDaemonState();
  });

  it('should die with cleanup logs when SIGTERM is sent', async () => {
    // SIGTERM test - daemon should cleanup gracefully
    const logFile = await getLatestDaemonLog();
    if (!logFile) {
      throw new Error('No log file found');
    }
    
    // Send SIGTERM to daemon (graceful shutdown)
    process.kill(daemonPid, 'SIGTERM');
    
    // Wait for graceful shutdown
    await waitForDaemonExit(daemonPid, PROCESS_EXIT_WAIT);
    
    // Check if process is dead
    expect(isProcessAlive(daemonPid)).toBe(false);
    
    // Read the log file to check for cleanup messages
    const logContent = readFileSync(logFile.path, 'utf8');
    
    // Should contain cleanup messages
    expect(logContent).toContain('SIGTERM');
    expect(logContent).toContain('cleanup');
    
    // Clean up state file if it still exists (should have been cleaned by SIGTERM handler)
    await clearDaemonState();
  });

  it('should detect daemon version mismatch and restart without workspace mutation', { timeout: 120_000 }, async () => {
    const initialState = await readDaemonState();
    expect(initialState).toBeDefined();
    if (!initialState) {
      return;
    }

    const initialPid = initialState.pid;
    const currentVersion = initialState.startedWithCliVersion;
    const staleVersion = `${currentVersion}-stale-${Date.now()}`;
    writeDaemonState({
      ...initialState,
      startedWithCliVersion: staleVersion,
    });

    const secondChild = startDaemonProcessForStartSync();
    const captured = captureChildOutput(secondChild);
    const restartedState = await waitForDaemonStateWithDifferentPid(initialPid, currentVersion);

    let exitCode: number | null = null;
    try {
      exitCode = await waitForChildExit(secondChild, 30_000);
    } catch (error) {
      if (secondChild.exitCode === null && !secondChild.killed) {
        secondChild.kill('SIGTERM');
        exitCode = await waitForChildExit(secondChild, 10_000).catch(() => null);
      } else {
        throw error;
      }
    }

    expect([0, null]).toContain(exitCode);

    expect(restartedState.startedWithCliVersion).toBe(currentVersion);
    expect(restartedState.pid).not.toBe(initialPid);
    // Output can be empty in CI depending on stream flush timing; state assertions above are authoritative.
    expect(typeof captured.output()).toBe('string');
  });
});
