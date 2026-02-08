/**
 * Integration tests for daemon HTTP control system.
 *
 * Recommended execution:
 * - `yarn test:integration-test-env`
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { configuration } from '@/configuration';
import { 
  listDaemonSessions, 
  stopDaemonSession, 
  spawnDaemonSession, 
  stopDaemonHttp, 
  notifyDaemonSessionStarted, 
  stopDaemon
} from '@/daemon/controlClient';
import { readDaemonState, clearDaemonState, writeDaemonState } from '@/persistence';
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
  timeoutMs: 10_000,
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
  return spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', 'daemon', 'start-sync'], {
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

async function waitForDaemonStateWithDifferentPid(initialPid: number, expectedVersion: string): Promise<void> {
  await waitFor(
    async () => {
      const finalState = await readDaemonState();
      return Boolean(
        finalState &&
          finalState.pid &&
          finalState.pid !== initialPid &&
          finalState.startedWithCliVersion === expectedVersion,
      );
    },
    {
      timeoutMs: 20_000,
      intervalMs: 300,
      label: 'daemon restart with updated version metadata',
    },
  );
}

async function waitForDaemonReadyState(): Promise<void> {
  await waitFor(
    async () => {
      const state = await readDaemonState();
      return Boolean(state && typeof state.pid === 'number' && typeof state.httpPort === 'number' && state.httpPort > 0);
    },
    DAEMON_READY_WAIT,
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
    
    // Check if we have test credentials
    const testCredentials = existsSync(join(configuration.happyHomeDir, 'access.key'));
    if (!testCredentials) {
      debugIntegrationPreflight(`missing test credentials at ${configuration.happyHomeDir}`);
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

describe.skipIf(!await isServerHealthy())('Daemon Integration Tests', { timeout: 20_000 }, () => {
  let daemonPid: number;

  beforeEach(async () => {
    // First ensure no daemon is running by checking PID in metadata file
    await stopDaemon()
    
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
    await stopDaemon()
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

    expect(response).toHaveProperty('success', true);
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

  it('stress test: spawn / stop', { timeout: 120_000 }, async () => {
    const promises = [];
    const sessionCount = 20;
    for (let i = 0; i < sessionCount; i++) {
      promises.push(spawnDaemonSession('/tmp'));
    }

    // Wait for all sessions to be spawned
    const results = await Promise.all(promises);
    results.forEach((result) => {
      expect(result.success).toBe(true);
      expect(result.sessionId).toBeDefined();
    });
    const sessionIds = results.map(r => r.sessionId);

    await waitForSessionCount(sessionCount, STRESS_SESSION_WAIT);

    // Stop all sessions
    const stopResults = await Promise.all(sessionIds.map(sessionId => stopDaemonSession(sessionId)));
    expect(stopResults.every(r => r), 'Not all sessions reported stopped').toBe(true);

    // Verify all sessions are stopped
    await waitForSessionCount(0, {
      ...STRESS_SESSION_WAIT,
      label: 'all stress sessions stopped',
    });
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
    const exitCode = await waitForChildExit(secondChild);

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
      expect(res.success).toBe(true);
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

  it('should detect daemon version mismatch and restart without workspace mutation', { timeout: 60_000 }, async () => {
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
    const exitCode = await waitForChildExit(secondChild);

    expect(exitCode).toBe(0);
    await waitForDaemonStateWithDifferentPid(initialPid, currentVersion);

    const finalState = await readDaemonState();
    expect(finalState).toBeDefined();
    expect(finalState?.startedWithCliVersion).toBe(currentVersion);
    expect(finalState?.pid).not.toBe(initialPid);
    expect(captured.output().toLowerCase()).toMatch(/version mismatch|restarting|already running|daemon/);
  });
});
