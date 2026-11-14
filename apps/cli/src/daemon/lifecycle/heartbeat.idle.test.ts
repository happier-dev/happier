import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('daemon heartbeat idle cost', () => {
  const originalHome = process.env.HAPPIER_HOME_DIR;
  let home: string;

  beforeEach(() => {
    home = join(tmpdir(), `happier-heartbeat-idle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = home;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(home)) rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHome;
  });

  it('writes no daemon state and retires ended-runner state only at startup over 5 idle minutes', async () => {
    // Drive each 30 s tick to completion (its file I/O is real), as the other heartbeat tests do.
    let tick: (() => Promise<void>) | null = null;
    vi.spyOn(global, 'setInterval').mockImplementation(((handler: () => Promise<void>) => { tick = handler; return 1; }) as never);
    const { startDaemonHeartbeatLoop } = await import('./heartbeat');
    const writeDaemonStateForCurrentOwner = vi.fn(() => true);
    const retireEndedRunnerOwnedState = vi.fn(async () => {});
    const handle = startDaemonHeartbeatLoop({
      trackedSessionsByKey: new Map(),
      spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => null,
      retireEndedRunnerOwnedState,
      fileState: { pid: process.pid, httpPort: 8765, startedAt: Date.now(), startedWithCliVersion: '1.0.0' },
      // The version poll is kept (L5 AMENDMENT_REQUIRED); its self-restart is a boundary stub here.
      currentCliVersion: '0.0.0-never-installed',
      requestSelfRestart: vi.fn(async () => ({ status: 'exited' as const })) as never,
      writeDaemonStateForCurrentOwner,
    } as never);
    try {
      // 5 idle minutes = 10 heartbeat ticks.
      for (let index = 0; index < 10; index++) await tick!();
      expect({
        stateWrites: writeDaemonStateForCurrentOwner.mock.calls.length,
        endedRunnerRetirements: retireEndedRunnerOwnedState.mock.calls.length,
      }).toEqual({ stateWrites: 0, endedRunnerRetirements: 1 });
    } finally {
      expect(handle).toBe(1);
    }
  });
});
