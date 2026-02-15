import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(() => JSON.stringify({ version: '1.0.0' }) as any),
  };
});

vi.mock('@/persistence', () => ({
  readDaemonState: vi.fn(),
  writeDaemonState: vi.fn(),
}));

import { readDaemonState } from '@/persistence';

describe('startDaemonHeartbeatLoop execution run marker gc', () => {
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  let happyHomeDir: string;

  beforeEach(() => {
    happyHomeDir = join(tmpdir(), `happier-cli-heartbeat-gc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
    process.env.HAPPIER_DAEMON_EXECUTION_RUN_TERMINAL_TTL_MS = '1';
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL;
    delete process.env.HAPPIER_DAEMON_EXECUTION_RUN_TERMINAL_TTL_MS;
    if (existsSync(happyHomeDir)) {
      rmSync(happyHomeDir, { recursive: true, force: true });
    }
    if (originalHappyHomeDir === undefined) {
      delete process.env.HAPPIER_HOME_DIR;
    } else {
      process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('removes stale terminal execution run markers during heartbeat', async () => {
    vi.mocked(readDaemonState).mockResolvedValue({
      pid: process.pid,
      httpPort: 4001,
      startedAt: Date.now(),
      startedWithCliVersion: '1.0.0',
      lastHeartbeatAt: Date.now(),
    });

    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((handler: (...args: any[]) => any) => {
      (globalThis as any).__tick = handler;
      return 1 as any;
    }) as any);

    const { writeExecutionRunMarker, listExecutionRunMarkers } = await import('@/daemon/executionRunRegistry');
    await writeExecutionRunMarker({
      pid: process.pid,
      happySessionId: 'sess-1',
      runId: 'run_terminal_old',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'review',
      backendId: 'claude',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
      status: 'succeeded',
      startedAtMs: Date.now() - 10_000,
      updatedAtMs: Date.now() - 9_000,
      finishedAtMs: Date.now() - 8_000,
    });

    // Ensure marker exists before heartbeat runs.
    expect((await listExecutionRunMarkers()).some((m) => m.runId === 'run_terminal_old')).toBe(true);

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');

    startDaemonHeartbeatLoop({
      pidToTrackedSession: new Map([[process.pid, { pid: process.pid, happySessionId: 'sess-1', machineId: 'm1' } as any]]),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      controlPort: 8765,
      fileState: {
        pid: process.pid,
        httpPort: 8765,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        daemonLogPath: '/tmp/daemon.log',
      },
      currentCliVersion: '1.0.0',
      requestShutdown: vi.fn(),
    });

    expect(setIntervalSpy).toHaveBeenCalled();
    const tick: (() => Promise<void>) | undefined = (globalThis as any).__tick;
    expect(tick).toBeTypeOf('function');

    await tick!();

    const after = await listExecutionRunMarkers();
    expect(after.some((m) => m.runId === 'run_terminal_old')).toBe(false);
  });
});
