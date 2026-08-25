import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ApiMachineClient } from '@/api/apiMachine';

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
 * `happier daemon status` and `happier doctor` could only ever answer "does a process with this
 * PID exist", which is why a daemon that served zero RPCs for 56 minutes read as healthy in four
 * separate sessions. The daemon itself knows whether its machine-control RPC registration
 * completed; the heartbeat is the only writer of the local state record after startup, so it is
 * where that fact is stamped, next to the `lastHeartbeatAt` that dates it.
 */
describe('startDaemonHeartbeatLoop machine-control readiness publication', () => {
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  let happyHomeDir: string;

  beforeEach(() => {
    happyHomeDir = join(tmpdir(), `happier-cli-heartbeat-readiness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  async function runOneHeartbeatTick(
    machineClient: ApiMachineClient | null,
  ): Promise<ReturnType<typeof vi.fn>> {
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
      getApiMachineForSessions: () => machineClient,
      controlPort: 8765,
      fileState: {
        pid: process.pid,
        httpPort: 8765,
        startedAt,
        startedWithCliVersion: '1.0.0',
        daemonLogPath: '/tmp/daemon.log',
      },
      currentCliVersion: '1.0.0',
      requestShutdown: vi.fn(),
      writeDaemonStateForCurrentOwner,
    });

    const tick: (() => Promise<void>) | undefined = (globalThis as any).__tick;
    expect(tick).toBeTypeOf('function');
    await tick!();
    return writeDaemonStateForCurrentOwner;
  }

  function createMachineClient(registrationReady: boolean): ApiMachineClient {
    return {
      isMachineControlRegistrationReady: () => registrationReady,
      getActiveRpcHandlerExecutions: () => [],
    } as unknown as ApiMachineClient;
  }

  it('publishes an outstanding machine-control registration as not ready', async () => {
    const writeDaemonStateForCurrentOwner = await runOneHeartbeatTick(createMachineClient(false));

    expect(writeDaemonStateForCurrentOwner).toHaveBeenCalledWith(
      expect.objectContaining({ machineControlReady: false }),
    );
  });

  it('publishes a completed machine-control registration as ready', async () => {
    const writeDaemonStateForCurrentOwner = await runOneHeartbeatTick(createMachineClient(true));

    expect(writeDaemonStateForCurrentOwner).toHaveBeenCalledWith(
      expect.objectContaining({ machineControlReady: true }),
    );
  });

  // Before the machine client exists the daemon has nothing to report, and inventing `false`
  // there would turn "not observed yet" into "confirmed broken" — the exact inversion two other
  // lanes in this program found being acted on destructively.
  it('publishes no readiness fact at all while there is no machine client to ask', async () => {
    const writeDaemonStateForCurrentOwner = await runOneHeartbeatTick(null);

    const published = writeDaemonStateForCurrentOwner.mock.calls.at(-1)?.[0] as
      Record<string, unknown> | undefined;
    expect(published).toBeDefined();
    expect(published).not.toHaveProperty('machineControlReady');
  });
});
