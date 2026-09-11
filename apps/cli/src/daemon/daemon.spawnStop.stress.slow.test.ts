/**
 * Daemon spawn/stop stress tests.
 *
 * These are intentionally not part of the default integration lane because they are
 * resource-intensive and can be sensitive to CI machine load.
 *
 * Run with a local integration server and credentials:
 * - `HAPPIER_CLI_DAEMON_SPAWN_STOP_STRESS_INTEGRATION=1 yarn workspace @happier-dev/cli test:slow`
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { join } from 'path';

import { listDaemonSessions, stopDaemonHttp, stopDaemonSession } from '@/daemon/controlClient';
import { readCredentials, readDaemonState } from '@/persistence';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { waitForCondition } from '@/testkit/async/waitFor';
import {
  prepareIsolatedDaemonTestHome,
  spawnDaemonSessionWithResolvedIdentity,
  type PreparedDaemonTestHome,
} from './testkit/realIntegration.testkit';

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
  timeoutMs: 60_000,
  intervalMs: 500,
  label: 'session list consistency',
};

let daemonPid: number;
let preparedDaemonHome: PreparedDaemonTestHome | null = null;
let startedDaemon: ReturnType<typeof startDaemonProcessForStartSync> | null = null;

const daemonSpawnStopStressEnabled = process.env.HAPPIER_CLI_DAEMON_SPAWN_STOP_STRESS_INTEGRATION === '1';

async function listDaemonSessionsTyped(): Promise<DaemonSessionRecord[]> {
  return (await listDaemonSessions()) as DaemonSessionRecord[];
}

function startDaemonProcessForStartSync(): { child: ReturnType<typeof spawn>; output: () => string } {
  const child = spawnHappyCLI(['daemon', 'start-sync'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout?.on('data', (data) => {
    output += data.toString();
  });
  child.stderr?.on('data', (data) => {
    output += data.toString();
  });

  return { child, output: () => output };
}

async function waitForDaemonReady(started: ReturnType<typeof startDaemonProcessForStartSync>): Promise<void> {
  await waitForCondition(async () => {
    if (started.child.exitCode !== null) {
      throw new Error(`daemon start-sync exited before readiness (exit=${started.child.exitCode})\n${started.output()}`);
    }
    const state = await readDaemonState();
    if (!state) return false;
    daemonPid = state.pid;
    // Best-effort: confirm credentials are readable for this isolated home.
    const creds = await readCredentials().catch(() => null);
    return Boolean(state.httpPort && state.controlToken && creds);
  }, {
    ...DAEMON_READY_WAIT,
    debug: started.output,
  });
}

async function waitForSessionCount(expected: number, opts: WaitForOptions): Promise<void> {
  await waitForCondition(async () => {
    const sessions = await listDaemonSessionsTyped();
    const daemonSessions = sessions.filter((s) => s.startedBy === 'daemon');
    return daemonSessions.length === expected;
  }, opts);
}

describe.skipIf(!daemonSpawnStopStressEnabled)('daemon spawn/stop stress (slow lane)', () => {
  beforeAll(async () => {
    preparedDaemonHome = await prepareIsolatedDaemonTestHome({
      prefix: 'happier-cli-daemon-slow-',
      logCopyPrefix: 'daemon-slow',
      extraEnv: {
        HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: join(process.cwd(), 'dist', 'index.mjs'),
      },
    });
  });

  afterAll(async () => {
    await preparedDaemonHome?.restore();
    preparedDaemonHome = null;
  });

  beforeEach(async () => {
    startedDaemon = startDaemonProcessForStartSync();
    startedDaemon.child.unref?.();
    await waitForDaemonReady(startedDaemon);
  }, 60_000);

  afterEach(async () => {
    const daemonProcess = startedDaemon?.child ?? null;
    try {
      await stopDaemonHttp();
    } catch {
      if (daemonProcess?.exitCode === null) {
        daemonProcess.kill('SIGTERM');
      }
    }

    if (daemonProcess) {
      await waitForCondition(() => daemonProcess.exitCode !== null, {
        timeoutMs: 30_000,
        intervalMs: 100,
        label: `stress daemon process ${daemonPid} to exit before isolated-home cleanup`,
        debug: startedDaemon?.output,
      });
    }
    startedDaemon = null;
  }, 35_000);

  it('spawns and stops multiple sessions', { timeout: 10 * 60_000 }, async () => {
    const sessionCount = 20;
    const results = await Promise.all(
      Array.from({ length: sessionCount }, () => spawnDaemonSessionWithResolvedIdentity(
        { directory: '/tmp', spawnNonce: randomUUID() },
        {
          ...SESSION_CONSISTENCY_WAIT,
          label: 'accepted stress daemon spawn identity resolution',
        },
      )),
    );

    results.forEach((result) => {
      expect(result.success, `stress spawn result=${JSON.stringify(result)}`).toBe(true);
      expect(result.sessionId).toBeDefined();
    });

    const sessionIds = results.map((r) => r.sessionId);
    await waitForSessionCount(sessionCount, SESSION_CONSISTENCY_WAIT);

    const stopResults = await Promise.all(
      sessionIds.map((sessionId) => stopDaemonSession(sessionId, { timeoutMs: null })),
    );
    expect(stopResults.every((result) => result.status === 'stopped'), 'Not all sessions reported stopped').toBe(true);
    await waitForSessionCount(0, {
      ...SESSION_CONSISTENCY_WAIT,
      label: 'all stress sessions stopped',
    });
  });
});
