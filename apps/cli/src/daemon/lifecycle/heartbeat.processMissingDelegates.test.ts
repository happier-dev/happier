import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('startDaemonHeartbeatLoop process-missing delegation', () => {
  beforeEach(() => {
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('delegates missing pids to onChildExited when provided', async () => {
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

    const pid = 111111;
    const pidToTrackedSession = new Map<number, any>([[pid, { pid, happySessionId: 'sess-1' }]]);

    const originalKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === pid && signal === 0) {
        throw new Error('ESRCH');
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExitedMock = vi.fn();
    const onChildExited = (targetPid: number, exit: any) => {
      onChildExitedMock(targetPid, exit);
      pidToTrackedSession.delete(targetPid);
    };

    const { startDaemonHeartbeatLoop } = await import('./heartbeat');
    startDaemonHeartbeatLoop({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      onChildExited,
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

    expect(onChildExitedMock).toHaveBeenCalledTimes(1);
    expect(onChildExitedMock).toHaveBeenCalledWith(pid, expect.objectContaining({ reason: 'process-missing' }));
    expect(pidToTrackedSession.has(pid)).toBe(false);
  });
});

