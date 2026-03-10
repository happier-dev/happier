import { describe, expect, it, vi } from 'vitest';

import { resolveSharedManagedOpenCodeServerBaseUrl, stopSharedManagedOpenCodeServerFromState } from './sharedManagedServer';

describe('resolveSharedManagedOpenCodeServerBaseUrl', () => {
  it('reuses an existing healthy managed server when pid is alive', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1234', pid: 111, startedAtMs: 1, status: 'ready' as const })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => true),
      startServer: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:9999', pid: 222 })),
      nowMs: () => 5,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:1234', didStart: false });
    expect(deps.startServer).not.toHaveBeenCalled();
    expect(deps.writeState).not.toHaveBeenCalled();
  });

  it('does not probe health for non-loopback state baseUrl (prevents SSRF if state file is tampered)', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://example.com:1234', pid: 111, startedAtMs: 1, status: 'ready' as const })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => {
        throw new Error('probeHealth should not be called for non-loopback baseUrl');
      }),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode', cmd: 'opencode serve --port 1234' })),
      killPid: vi.fn(() => true),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      nowMs: () => 5,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.probeHealth).not.toHaveBeenCalled();
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.startServer).toHaveBeenCalledTimes(1);
  });

  it('starts a new managed server when no state exists', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => null),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => false),
      probeHealth: vi.fn(async () => false),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      nowMs: () => 5,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.startServer).toHaveBeenCalledTimes(1);
    expect(deps.writeState.mock.calls).toEqual([
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 5, status: 'starting' }],
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 5, status: 'ready' }],
    ]);
  });

  it('starts a new managed server when the recorded pid is dead', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1234', pid: 111, startedAtMs: 1, status: 'ready' as const })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => false),
      probeHealth: vi.fn(async () => false),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      nowMs: () => 7,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.startServer).toHaveBeenCalledTimes(1);
    expect(deps.writeState.mock.calls).toEqual([
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 7, status: 'starting' }],
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 7, status: 'ready' }],
    ]);
  });

  it('kills an unhealthy recorded managed server when it looks like opencode serve', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1234', pid: 111, startedAtMs: 1, status: 'ready' as const })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode', cmd: 'opencode serve --port 1234' })),
      killPid: vi.fn(() => true),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      nowMs: () => 9,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.killPid).toHaveBeenCalledWith(111);
    expect(deps.startServer).toHaveBeenCalledTimes(1);
    expect(deps.writeState.mock.calls).toEqual([
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 9, status: 'starting' }],
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 9, status: 'ready' }],
    ]);
  });

  it('restarts a failed managed server when the recorded pid is still alive but unhealthy', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'failed' as const,
        lastFailureAtMs: 2,
      })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode', cmd: 'opencode serve --port 1234' })),
      killPid: vi.fn(() => true),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      nowMs: () => 9,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.killPid).toHaveBeenCalledWith(111);
    expect(deps.startServer).toHaveBeenCalledTimes(1);
    expect(deps.writeState.mock.calls).toEqual([
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 9, status: 'starting' }],
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 9, status: 'ready' }],
    ]);
  });

  it('starts a new managed server after a failed startup when the recorded pid no longer looks like opencode', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'failed' as const,
        lastFailureAtMs: 2,
      })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => ({ name: 'python3', cmd: 'python worker.py' })),
      killPid: vi.fn(() => true),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      nowMs: () => 9,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.startServer).toHaveBeenCalledTimes(1);
    expect(deps.writeState.mock.calls).toEqual([
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 9, status: 'starting' }],
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 9, status: 'ready' }],
    ]);
  });

  it('starts a new managed server after a failed startup when the recorded pid is no longer alive', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'failed' as const,
        lastFailureAtMs: 2,
      })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => false),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => null),
      killPid: vi.fn(() => true),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      nowMs: () => 9,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.startServer).toHaveBeenCalledTimes(1);
    expect(deps.writeState.mock.calls).toEqual([
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 9, status: 'starting' }],
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 9, status: 'ready' }],
    ]);
  });

  it('starts a new managed server even when a stale opencode pid cannot be killed', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'failed' as const,
        lastFailureAtMs: 2,
      })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode', cmd: 'opencode serve --port 1234' })),
      killPid: vi.fn(() => {
        throw new Error('stuck process');
      }),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      nowMs: () => 9,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.killPid).toHaveBeenCalledWith(111);
    expect(deps.startServer).toHaveBeenCalledTimes(1);
    expect(deps.writeState.mock.calls).toEqual([
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 9, status: 'starting' }],
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 9, status: 'ready' }],
    ]);
  });

  it('reuses a previously failed managed server when the pid is alive and health probe now succeeds', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'failed' as const,
        lastFailureAtMs: 2,
      })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => true),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode', cmd: 'opencode serve --port 1234' })),
      killPid: vi.fn(() => true),
      startServer: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:9999', pid: 222 })),
      nowMs: () => 9,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:1234', didStart: false });
    expect(deps.startServer).not.toHaveBeenCalled();
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.writeState).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:1234',
      pid: 111,
      startedAtMs: 1,
      status: 'ready',
    });
  });

  it('records a failed provisional state when startup fails after spawn', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => null),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => false),
      probeHealth: vi.fn(async () => false),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        throw new Error('startup timeout');
      }),
      nowMs: () => 5,
    };

    await expect(resolveSharedManagedOpenCodeServerBaseUrl(deps)).rejects.toThrow(/startup timeout/);
    expect(deps.writeState.mock.calls).toEqual([
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 5, status: 'starting' }],
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 5, status: 'failed', lastFailureAtMs: 5 }],
    ]);
  });
});

describe('stopSharedManagedOpenCodeServerFromState', () => {
  it('kills the managed server when health probe succeeds', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1234', pid: 111, startedAtMs: 1, status: 'ready' as const })),
      removeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => true),
      getProcessInfo: vi.fn(async () => null),
      killPid: vi.fn(() => true),
    };

    const out = await stopSharedManagedOpenCodeServerFromState(deps);

    expect(out).toEqual({ didKill: true });
    expect(deps.killPid).toHaveBeenCalledWith(111);
    expect(deps.removeState).toHaveBeenCalledTimes(1);
  });

  it('kills the managed server when health probe fails but pid looks like opencode serve', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1234', pid: 222, startedAtMs: 1, status: 'failed' as const })),
      removeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode', cmd: 'opencode serve --port 1234' })),
      killPid: vi.fn(() => true),
    };

    const out = await stopSharedManagedOpenCodeServerFromState(deps);

    expect(out).toEqual({ didKill: true });
    expect(deps.killPid).toHaveBeenCalledWith(222);
    expect(deps.removeState).toHaveBeenCalledTimes(1);
  });

  it('does not kill when health probe fails and pid does not look like opencode', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1234', pid: 333, startedAtMs: 1, status: 'failed' as const })),
      removeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => ({ name: 'node', cmd: 'node some-other-server.js' })),
      killPid: vi.fn(() => false),
    };

    const out = await stopSharedManagedOpenCodeServerFromState(deps);

    expect(out).toEqual({ didKill: false });
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.removeState).toHaveBeenCalledTimes(1);
  });

  it('does not fail when the managed server pid resists shutdown', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1234', pid: 444, startedAtMs: 1, status: 'ready' as const })),
      removeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => true),
      getProcessInfo: vi.fn(async () => null),
      killPid: vi.fn(() => {
        throw new Error('stuck process');
      }),
    };

    const out = await stopSharedManagedOpenCodeServerFromState(deps);

    expect(out).toEqual({ didKill: false });
    expect(deps.killPid).toHaveBeenCalledWith(444);
    expect(deps.removeState).toHaveBeenCalledTimes(1);
  });

  it('does not probe health for non-loopback baseUrl while stopping (prevents SSRF if state file is tampered)', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://example.com:1234', pid: 222, startedAtMs: 1, status: 'failed' as const })),
      removeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => {
        throw new Error('probeHealth should not be called for non-loopback baseUrl');
      }),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode', cmd: 'opencode serve --port 1234' })),
      killPid: vi.fn(() => true),
    };

    const out = await stopSharedManagedOpenCodeServerFromState(deps);

    expect(out).toEqual({ didKill: true });
    expect(deps.probeHealth).not.toHaveBeenCalled();
    expect(deps.killPid).toHaveBeenCalledWith(222);
    expect(deps.removeState).toHaveBeenCalledTimes(1);
  });
});
