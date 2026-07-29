import { afterEach, describe, expect, it, vi } from 'vitest';

import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('daemonControlPostJson diagnostics', () => {
  it('wraps network errors with endpoint context', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom');
      }),
    );

    await expect(
      daemonControlPostJson({
        port: 47001,
        path: '/stop',
        body: {},
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/port=47001.*path=\/stop/i);
  });

  it('keeps /spawn-session requests alive longer than the generic control timeout', async () => {
    vi.useFakeTimers();

    let aborted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('This operation was aborted'));
          },
          { once: true },
        );
      })),
    );

    const pending = daemonControlPostJson({
      port: 47002,
      path: '/spawn-session',
      body: {},
    });
    const observed = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(observed).resolves.toBeInstanceOf(Error);
    await expect(pending).rejects.toThrow(/port=47002.*path=\/spawn-session/i);
    expect(aborted).toBe(true);
  });
});
