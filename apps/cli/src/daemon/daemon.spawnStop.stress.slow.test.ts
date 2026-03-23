/**
 * Daemon spawn/stop stress tests.
 *
 * These are intentionally not part of the default integration lane because they are
 * resource-intensive and can be sensitive to CI machine load.
 *
 * Run with:
 * - `yarn workspace @happier/cli test:slow`
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { join } from 'path';

import { listDaemonSessions, spawnDaemonSession, stopDaemonHttp, stopDaemonSession } from '@/daemon/controlClient';
import { readCredentials, readDaemonState } from '@/persistence';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { waitForCondition } from '@/testkit/async/waitFor';
import { prepareIsolatedDaemonTestHome, type PreparedDaemonTestHome } from './testkit/realIntegration.testkit';

type WaitForOptions = {
  timeoutMs: number;
  intervalMs?: number;
  label: string;
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

async function waitForDaemonReady(): Promise<void> {
  await waitForCondition(async () => {
    const state = await readDaemonState();
    if (!state) return false;
    daemonPid = state.pid;
    // Best-effort: confirm credentials are readable for this isolated home.
    const creds = await readCredentials().catch(() => null);
    return Boolean(state.httpPort && state.controlToken && creds);
  }, DAEMON_READY_WAIT);
}

async function waitForSessionCount(expected: number, opts: WaitForOptions): Promise<void> {
  await waitForCondition(async () => {
    const sessions = await listDaemonSessionsTyped();
    const daemonSessions = sessions.filter((s) => s.startedBy === 'daemon');
    return daemonSessions.length === expected;
  }, opts);
}

describe('daemon spawn/stop stress (slow lane)', () => {
  beforeAll(async () => {
    preparedDaemonHome = await prepareIsolatedDaemonTestHome({
      prefix: 'happier-cli-daemon-slow-',
      logCopyPrefix: 'daemon-slow',
    });
  });

  afterAll(async () => {
    await preparedDaemonHome?.restore();
    preparedDaemonHome = null;
  });

  beforeEach(async () => {
    const child = startDaemonProcessForStartSync();
    child.unref?.();
    await waitForDaemonReady();
  });

  afterEach(async () => {
    try {
      await stopDaemonHttp();
    } catch {
      // best-effort
    }
  });

  it('spawns and stops multiple sessions', { timeout: 10 * 60_000 }, async () => {
    const sessionCount = 20;
    const results = await Promise.all(
      Array.from({ length: sessionCount }, () => spawnDaemonSession('/tmp')),
    );

    results.forEach((result) => {
      expect(result.success, `stress spawn result=${JSON.stringify(result)}`).toBe(true);
      expect(result.sessionId).toBeDefined();
    });

    const sessionIds = results.map((r) => r.sessionId);
    await waitForSessionCount(sessionCount, SESSION_CONSISTENCY_WAIT);

    const stopResults = await Promise.all(sessionIds.map((sessionId) => stopDaemonSession(sessionId)));
    expect(stopResults.every((r) => r), 'Not all sessions reported stopped').toBe(true);
    await waitForSessionCount(0, {
      ...SESSION_CONSISTENCY_WAIT,
      label: 'all stress sessions stopped',
    });
  });
});
