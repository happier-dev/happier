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

/**
 * The heartbeat republishes the whole daemon state record on every tick. Anything it does not
 * carry over from `fileState` is erased from `daemon.state.json` a heartbeat after startup, so
 * the running-bundle identity that `happier doctor` reports would only ever be readable in the
 * first few seconds of a daemon's life.
 */
describe('startDaemonHeartbeatLoop daemon state republication', () => {
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  let happyHomeDir: string;

  beforeEach(() => {
    happyHomeDir = join(tmpdir(), `happier-cli-heartbeat-identity-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL;
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

  it('preserves the running runtime identity written at startup', async () => {
    const startedAt = Date.now();
    vi.mocked(readDaemonState).mockResolvedValue({
      pid: process.pid,
      httpPort: 8765,
      startedAt,
      startedWithCliVersion: '1.0.0',
      lastHeartbeatAt: startedAt,
    });

    vi.spyOn(global, 'setInterval').mockImplementation(((handler: (...args: any[]) => any) => {
      (globalThis as any).__tick = handler;
      return 1 as any;
    }) as any);

    const writeDaemonStateForCurrentOwner = vi.fn(() => true);
    const { startDaemonHeartbeatLoop } = await import('./heartbeat');

    startDaemonHeartbeatLoop({
      pidToTrackedSession: new Map(),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      controlPort: 8765,
      fileState: {
        pid: process.pid,
        httpPort: 8765,
        startedAt,
        startedWithCliVersion: '1.0.0',
        startedWithRuntimeEntrypoint: '/repo/apps/cli/dist/index.mjs',
        startedWithRuntimeBuiltAt: '2026-08-24T14:05:22.396Z',
        daemonLogPath: '/tmp/daemon.log',
      },
      currentCliVersion: '1.0.0',
      requestShutdown: vi.fn(),
      writeDaemonStateForCurrentOwner,
    });

    const tick: (() => Promise<void>) | undefined = (globalThis as any).__tick;
    expect(tick).toBeTypeOf('function');
    await tick!();

    expect(writeDaemonStateForCurrentOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        startedWithRuntimeEntrypoint: '/repo/apps/cli/dist/index.mjs',
        startedWithRuntimeBuiltAt: '2026-08-24T14:05:22.396Z',
      }),
    );
  });
});
