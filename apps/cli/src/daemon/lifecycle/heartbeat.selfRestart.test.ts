import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
  };
});

vi.mock('@/persistence', () => ({
  readDaemonState: vi.fn(),
  writeDaemonState: vi.fn(),
}));

vi.mock('@/utils/spawnHappyCLI', () => ({
  spawnHappyCLI: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { readFileSync } from 'fs';

import { readDaemonState } from '@/persistence';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

describe('startDaemonHeartbeatLoop daemon self-restart', () => {
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  let happyHomeDir: string | null = null;

  afterEach(() => {
    delete process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL;
    delete process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS;
    delete process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS;
    if (happyHomeDir && existsSync(happyHomeDir)) {
      rmSync(happyHomeDir, { recursive: true, force: true });
    }
    happyHomeDir = null;
    if (originalHappyHomeDir === undefined) {
      delete process.env.HAPPIER_HOME_DIR;
    } else {
      process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does not permanently lock the heartbeat loop if reading package.json throws', async () => {
    happyHomeDir = join(tmpdir(), `happier-cli-heartbeat-self-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    mkdirSync(join(happyHomeDir, 'logs'), { recursive: true });
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS = '25';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS = '5';

    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    vi.resetModules();

    let tick: (() => Promise<void>) | undefined;
    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockImplementation(((handler: (...args: any[]) => any) => {
        tick = handler as unknown as () => Promise<void>;
        return 1 as any;
      }) as any);

    vi.mocked(readFileSync)
      .mockImplementationOnce(() => {
        throw new Error('boom');
      })
      .mockReturnValue(JSON.stringify({ version: '1.0.0' }) as any);

    vi.mocked(spawnHappyCLI).mockReturnValue({ unref: vi.fn() } as any);
    vi.mocked(readDaemonState).mockResolvedValue({
      pid: process.pid,
      httpPort: 4001,
      startedAt: Date.now(),
      startedWithCliVersion: '1.0.0',
      lastHeartbeatAt: Date.now(),
    });

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
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        daemonLogPath: '/tmp/daemon.log',
      },
      currentCliVersion: '1.0.0',
      requestShutdown: vi.fn(),
    });

    expect(setIntervalSpy).toHaveBeenCalled();
    expect(tick).toBeTypeOf('function');

    try {
      await tick!();
    } catch {
      // pre-fix behavior: first tick throws and leaves heartbeatRunning stuck true
    }

    await tick!();
    expect(spawnHappyCLI).not.toHaveBeenCalled();
  }, 15_000);

  it('uses start-sync and keeps the current daemon alive if replacement is not confirmed', async () => {
    happyHomeDir = join(tmpdir(), `happier-cli-heartbeat-self-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    mkdirSync(join(happyHomeDir, 'logs'), { recursive: true });
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS = '25';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS = '5';

    vi.useFakeTimers();
    vi.resetModules();

    let tick: (() => Promise<void>) | undefined;
    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockImplementation(((handler: (...args: any[]) => any) => {
        tick = handler as unknown as () => Promise<void>;
        return 1 as any;
      }) as any);

    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: '2.0.0' }) as any);
    vi.mocked(spawnHappyCLI).mockReturnValue({ unref: vi.fn() } as any);
    vi.mocked(readDaemonState).mockResolvedValue({
      pid: process.pid,
      httpPort: 4001,
      startedAt: Date.now(),
      startedWithCliVersion: '1.0.0',
      lastHeartbeatAt: Date.now(),
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');

    const interval = startDaemonHeartbeatLoop({
      pidToTrackedSession: new Map(),
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
    expect(tick).toBeTypeOf('function');
    const tickPromise = tick!();
    // Ensure the async tick has a chance to schedule its internal timers before we flush them.
    await Promise.resolve();
    await vi.runAllTimersAsync();
    await tickPromise;

    expect(spawnHappyCLI).toHaveBeenCalledWith(
      ['daemon', 'start-sync'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(exitSpy).not.toHaveBeenCalled();

    clearInterval(interval);
  }, 15_000);

  it('exits only after replacement daemon with current CLI version is confirmed', async () => {
    happyHomeDir = join(tmpdir(), `happier-cli-heartbeat-self-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    mkdirSync(join(happyHomeDir, 'logs'), { recursive: true });
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS = '40';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS = '5';

    vi.useFakeTimers();
    vi.resetModules();

    let tick: (() => Promise<void>) | undefined;
    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockImplementation(((handler: (...args: any[]) => any) => {
        tick = handler as unknown as () => Promise<void>;
        return 1 as any;
      }) as any);

    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: '2.0.0' }) as any);
    vi.mocked(spawnHappyCLI).mockReturnValue({ unref: vi.fn() } as any);
    vi.mocked(readDaemonState)
      .mockResolvedValueOnce({
        pid: process.pid,
        httpPort: 7001,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
      })
      .mockResolvedValue({
        pid: process.pid + 1000,
        httpPort: 7002,
        startedAt: Date.now(),
        startedWithCliVersion: '2.0.0',
      });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');

    const interval = startDaemonHeartbeatLoop({
      pidToTrackedSession: new Map(),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      controlPort: 5555,
      fileState: {
        pid: process.pid,
        httpPort: 5555,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
      },
      currentCliVersion: '1.0.0',
      requestShutdown: vi.fn(),
    });

    expect(setIntervalSpy).toHaveBeenCalled();
    expect(tick).toBeTypeOf('function');
    const tickPromise = tick!();
    // Ensure the async tick has a chance to schedule its internal timers before we flush them.
    await Promise.resolve();
    await vi.runAllTimersAsync();
    await tickPromise;

    expect(spawnHappyCLI).toHaveBeenCalledWith(
      ['daemon', 'start-sync'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);

    clearInterval(interval);
  }, 15_000);
});
