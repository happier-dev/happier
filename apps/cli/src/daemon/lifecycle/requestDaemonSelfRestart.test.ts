import { describe, expect, it, vi } from 'vitest';

import type { DaemonLocallyPersistedState } from '@/persistence';

function makeState(overrides: Partial<DaemonLocallyPersistedState> = {}): DaemonLocallyPersistedState {
  return {
    pid: process.pid + 100,
    httpPort: 5001,
    startedAt: Date.now(),
    startedWithCliVersion: '2.0.0',
    controlToken: 'control-token',
    ...overrides,
  };
}

describe('requestDaemonSelfRestart', () => {
  it('confirms replacement daemon pings with close-socket control headers', async () => {
    const observedHeaders: unknown[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      observedHeaders.push(init?.headers);
      return {
        ok: true,
        text: async () => JSON.stringify({ success: true }),
      } as Response;
    });

    const { waitForReplacementDaemon } = await import('./requestDaemonSelfRestart');

    try {
      await expect(waitForReplacementDaemon({
        ownPid: process.pid + 10_000,
        expectedCliVersion: '2.0.0',
        timeoutMs: 25,
        pollMs: 1,
        readDaemonStateImpl: vi.fn(async () => makeState({
          pid: process.pid,
          httpPort: 5001,
          startedWithCliVersion: '2.0.0',
          runtimeId: 'runtime-1',
          controlToken: 'control-token',
        })),
      })).resolves.toBe(true);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect((observedHeaders[0] as Record<string, string>).Connection).toBe('close');
      expect((observedHeaders[0] as Record<string, string>)['x-happier-daemon-token']).toBe('control-token');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('spawns a takeover replacement with the inherited runtime id and exits only after confirmation', async () => {
    const spawnDetachedDaemonStartSync = vi.fn(async () => ({ unref: vi.fn() }));
    const readDaemonState = vi.fn(async () => makeState({ runtimeId: 'runtime-1' }));
    const confirmReplacementState = vi.fn(async () => true);
    const exitProcess = vi.fn();

    const { requestDaemonSelfRestart } = await import('./requestDaemonSelfRestart');

    const result = await requestDaemonSelfRestart({
      runtimeId: 'runtime-1',
      expectedCliVersion: '2.0.0',
      ownPid: process.pid,
      timeoutMs: 25,
      pollMs: 1,
      spawnDetachedDaemonStartSyncImpl: spawnDetachedDaemonStartSync,
      readDaemonStateImpl: readDaemonState,
      confirmReplacementStateImpl: confirmReplacementState,
      exitProcess,
      env: { KEEP_ME: '1' },
    });

    expect(spawnDetachedDaemonStartSync).toHaveBeenCalledWith(expect.objectContaining({
      startupSource: 'self-restart',
      env: expect.objectContaining({
        KEEP_ME: '1',
        HAPPIER_DAEMON_RUNTIME_ID: 'runtime-1',
        HAPPIER_DAEMON_TAKEOVER: '1',
      }),
    }));
    expect(exitProcess).toHaveBeenCalledWith(0);
    expect(result.status).toBe('exited');
  });

  it('keeps the current daemon alive when the replacement is not confirmed', async () => {
    const spawnDetachedDaemonStartSync = vi.fn(async () => ({ unref: vi.fn() }));
    const readDaemonState = vi.fn(async () => makeState({ pid: process.pid, startedWithCliVersion: '1.0.0' }));
    const exitProcess = vi.fn();

    const { requestDaemonSelfRestart } = await import('./requestDaemonSelfRestart');

    const result = await requestDaemonSelfRestart({
      runtimeId: 'runtime-1',
      expectedCliVersion: '2.0.0',
      ownPid: process.pid,
      timeoutMs: 5,
      pollMs: 1,
      spawnDetachedDaemonStartSyncImpl: spawnDetachedDaemonStartSync,
      readDaemonStateImpl: readDaemonState,
      exitProcess,
      env: {},
    });

    expect(spawnDetachedDaemonStartSync).toHaveBeenCalledTimes(1);
    expect(exitProcess).not.toHaveBeenCalled();
    expect(result.status).toBe('replacement_not_confirmed');
  });

  it('requires authenticated ping details before confirming a runtime-id replacement', async () => {
    const spawnDetachedDaemonStartSync = vi.fn(async () => ({ unref: vi.fn() }));
    const readDaemonState = vi.fn(async () => makeState({
      pid: process.pid + 100,
      startedWithCliVersion: '2.0.0',
      runtimeId: 'runtime-1',
      controlToken: undefined,
    }));
    const confirmReplacementState = vi.fn(async () => true);
    const exitProcess = vi.fn();

    const { requestDaemonSelfRestart } = await import('./requestDaemonSelfRestart');

    const result = await requestDaemonSelfRestart({
      runtimeId: 'runtime-1',
      expectedCliVersion: '2.0.0',
      ownPid: process.pid,
      timeoutMs: 5,
      pollMs: 1,
      spawnDetachedDaemonStartSyncImpl: spawnDetachedDaemonStartSync,
      readDaemonStateImpl: readDaemonState,
      confirmReplacementStateImpl: confirmReplacementState,
      exitProcess,
      env: {},
    });

    expect(confirmReplacementState).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
    expect(result.status).toBe('replacement_not_confirmed');
  });
});
