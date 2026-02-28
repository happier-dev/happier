import { describe, expect, it, vi } from 'vitest';

import { resolveSharedManagedOpenCodeServerBaseUrl } from './sharedManagedServer';

describe('resolveSharedManagedOpenCodeServerBaseUrl', () => {
  it('reuses an existing healthy managed server when pid is alive', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1234', pid: 111, startedAtMs: 1 })),
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

  it('starts a new managed server when no state exists', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => null),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => false),
      probeHealth: vi.fn(async () => false),
      startServer: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:9999', pid: 222 })),
      nowMs: () => 5,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.startServer).toHaveBeenCalledTimes(1);
    expect(deps.writeState).toHaveBeenCalledWith({ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 5 });
  });

  it('starts a new managed server when the recorded pid is dead', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1234', pid: 111, startedAtMs: 1 })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => false),
      probeHealth: vi.fn(async () => false),
      startServer: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:9999', pid: 222 })),
      nowMs: () => 7,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.startServer).toHaveBeenCalledTimes(1);
    expect(deps.writeState).toHaveBeenCalledWith({ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 7 });
  });
});
