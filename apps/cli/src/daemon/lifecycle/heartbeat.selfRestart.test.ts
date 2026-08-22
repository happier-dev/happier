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

vi.mock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({
  spawnDetachedDaemonStartSync: vi.fn(),
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
import { spawnDetachedDaemonStartSync } from '@/daemon/runtime/spawnDetachedDaemonStartSync';
import { spawnSleepyDetachedProcess } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';

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

  it('uses the daemon startup budget for replacement verification by default', async () => {
    vi.resetModules();

    const { DEFAULT_DAEMON_RESTART_VERIFY_TIMEOUT_MS } = await import('./heartbeat');

    expect(DEFAULT_DAEMON_RESTART_VERIFY_TIMEOUT_MS).toBe(60_000);
  });

  it('does not permanently lock the heartbeat loop if reading package.json throws', async () => {
    happyHomeDir = join(tmpdir(), `happier-cli-heartbeat-self-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    mkdirSync(join(happyHomeDir, 'logs'), { recursive: true });
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS = '25';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS = '5';

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

    vi.mocked(spawnDetachedDaemonStartSync).mockResolvedValue({ unref: vi.fn() } as any);
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
        runtimeId: 'runtime-heartbeat-restart',
        daemonLogPath: '/tmp/daemon.log',
      },
      currentCliVersion: '1.0.0',
      requestShutdown: vi.fn(),
      writeDaemonStateForCurrentOwner: vi.fn(() => true),
    });

    expect(setIntervalSpy).toHaveBeenCalled();
    expect(tick).toBeTypeOf('function');

    try {
      await tick!();
    } catch {
      // pre-fix behavior: first tick throws and leaves heartbeatRunning stuck true
    }

    await tick!();
    expect(spawnDetachedDaemonStartSync).not.toHaveBeenCalled();
  }, 15_000);

  it('uses start-sync and keeps the current daemon alive if replacement is not confirmed', async () => {
    happyHomeDir = join(tmpdir(), `happier-cli-heartbeat-self-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    mkdirSync(join(happyHomeDir, 'logs'), { recursive: true });
    process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '1';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS = '25';
    process.env.HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS = '5';

    vi.resetModules();

    let tick: (() => Promise<void>) | undefined;
    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockImplementation(((handler: (...args: any[]) => any) => {
        tick = handler as unknown as () => Promise<void>;
        return 1 as any;
      }) as any);

    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: '2.0.0' }) as any);
    vi.mocked(spawnDetachedDaemonStartSync).mockResolvedValue({ unref: vi.fn() } as any);
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
        runtimeId: 'runtime-heartbeat-restart',
        daemonLogPath: '/tmp/daemon.log',
      },
      currentCliVersion: '1.0.0',
      requestShutdown: vi.fn(),
      writeDaemonStateForCurrentOwner: vi.fn(() => true),
    });

    expect(setIntervalSpy).toHaveBeenCalled();
    expect(tick).toBeTypeOf('function');
    await tick!();

    expect(spawnDetachedDaemonStartSync).toHaveBeenCalledTimes(1);
    const firstSpawnCall = vi.mocked(spawnDetachedDaemonStartSync).mock.calls[0]?.[0] as
      | { env?: Record<string, string>; startupSource?: string }
      | undefined;
    expect(firstSpawnCall?.startupSource).toBe('self-restart');
    expect(firstSpawnCall?.env?.HAPPIER_DAEMON_RUNTIME_ID).toBe('runtime-heartbeat-restart');
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
    const replacement = spawnSleepyDetachedProcess();

    try {
      vi.resetModules();

      let tick: (() => Promise<void>) | undefined;
      const setIntervalSpy = vi
        .spyOn(global, 'setInterval')
        .mockImplementation(((handler: (...args: any[]) => any) => {
          tick = handler as unknown as () => Promise<void>;
          return 1 as any;
        }) as any);

      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: '2.0.0' }) as any);
      vi.mocked(spawnDetachedDaemonStartSync).mockResolvedValue({ unref: vi.fn() } as any);
      vi.mocked(readDaemonState)
        .mockResolvedValueOnce({
          pid: process.pid,
          httpPort: 7001,
          startedAt: Date.now(),
          startedWithCliVersion: '1.0.0',
        })
        .mockResolvedValue({
          pid: replacement.pid,
          httpPort: 7002,
          startedAt: Date.now(),
          startedWithCliVersion: '2.0.0',
          runtimeId: 'runtime-heartbeat-confirmed',
          controlToken: 'replacement-control-token',
        });
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
        if (
          url.hostname === '127.0.0.1'
          && url.port === '7002'
          && init?.method === 'POST'
          && (init.headers as Record<string, string> | undefined)?.['x-happier-daemon-token'] === 'replacement-control-token'
        ) {
          return new Response(JSON.stringify({ status: 'ok' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: false }), { status: 401 });
      }));

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
          runtimeId: 'runtime-heartbeat-confirmed',
        },
        currentCliVersion: '1.0.0',
        requestShutdown: vi.fn(),
      writeDaemonStateForCurrentOwner: vi.fn(() => true),
      });

      expect(setIntervalSpy).toHaveBeenCalled();
      expect(tick).toBeTypeOf('function');
      await tick!();

      expect(spawnDetachedDaemonStartSync).toHaveBeenCalledTimes(1);
      const confirmedSpawnCall = vi.mocked(spawnDetachedDaemonStartSync).mock.calls[0]?.[0] as
        | { env?: Record<string, string>; startupSource?: string }
        | undefined;
      expect(confirmedSpawnCall?.startupSource).toBe('self-restart');
      expect(confirmedSpawnCall?.env?.HAPPIER_DAEMON_RUNTIME_ID).toBe('runtime-heartbeat-confirmed');
      expect(exitSpy).toHaveBeenCalledWith(0);

      clearInterval(interval);
    } finally {
      await replacement.kill();
    }
  }, 15_000);
});
