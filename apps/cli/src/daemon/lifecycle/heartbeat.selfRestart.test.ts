import { afterEach, describe, expect, it, vi } from 'vitest';
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

import { readFileSync } from 'fs';

import { readDaemonState } from '@/persistence';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

import { startDaemonHeartbeatLoop } from './heartbeat';

describe('startDaemonHeartbeatLoop daemon self-restart', () => {
  afterEach(() => {
    delete process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL;
    delete process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS;
    delete process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does not permanently lock the heartbeat loop if reading package.json throws', async () => {
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS = '25';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS = '5';

    vi.useFakeTimers();

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
      .mockReturnValue(JSON.stringify({ version: '2.0.0' }) as any);

    vi.mocked(spawnHappyCLI).mockReturnValue({ unref: vi.fn() } as any);
    vi.mocked(readDaemonState).mockResolvedValue({
      pid: process.pid,
      httpPort: 4001,
      startedAt: Date.now(),
      startedWithCliVersion: '1.0.0',
      lastHeartbeatAt: Date.now(),
    });

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

    const secondTick = tick!();
    await vi.advanceTimersByTimeAsync(60);
    await secondTick;

    expect(spawnHappyCLI).toHaveBeenCalledWith(
      ['daemon', 'start-sync'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
  }, 15_000);

  it('uses start-sync and keeps the current daemon alive if replacement is not confirmed', async () => {
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS = '25';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS = '5';

    vi.useFakeTimers();

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

    await vi.advanceTimersByTimeAsync(60);

    expect(spawnHappyCLI).toHaveBeenCalledWith(
      ['daemon', 'start-sync'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(exitSpy).not.toHaveBeenCalled();

    clearInterval(interval);
  }, 15_000);

  it('exits only after replacement daemon with current CLI version is confirmed', async () => {
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS = '40';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS = '5';

    vi.useFakeTimers();

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

    await vi.advanceTimersByTimeAsync(80);

    expect(spawnHappyCLI).toHaveBeenCalledWith(
      ['daemon', 'start-sync'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);

    clearInterval(interval);
  }, 15_000);
});
