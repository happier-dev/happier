import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { RaceWithTimeoutResult } from './timeout.js';

type TimeoutModule = Readonly<{
  raceWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<RaceWithTimeoutResult<T>>;
  sleep(ms: number): Promise<void>;
  sleepWithSignal(ms: number, signal?: AbortSignal | null): Promise<void>;
}>;

async function loadTimeout(): Promise<TimeoutModule> {
  const loaded = await import('./timeout.js').catch((error: unknown) => error);
  expect(loaded).not.toBeInstanceOf(Error);
  return loaded as TimeoutModule;
}

describe('async timeout helpers', () => {
  it('publishes timeout helpers through the canonical async subpath', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports?: Record<string, unknown> };

    expect(packageJson.exports).toHaveProperty('./async', {
      types: './dist/async/index.d.ts',
      default: './dist/async/index.js',
    });
  });

  it('returns timeout without waiting for the underlying promise to settle', async () => {
    vi.useFakeTimers();
    try {
      const timeout = await loadTimeout();
      const never = new Promise<string>(() => undefined);
      const outcomePromise = timeout.raceWithTimeout(never, 25);

      await vi.advanceTimersByTimeAsync(25);

      await expect(outcomePromise).resolves.toEqual({ type: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies resolved and rejected promises', async () => {
    const timeout = await loadTimeout();
    const error = new Error('boom');

    await expect(timeout.raceWithTimeout(Promise.resolve('ok'), 1_000)).resolves.toEqual({
      type: 'resolved',
      value: 'ok',
    });
    await expect(timeout.raceWithTimeout(Promise.reject(error), 1_000)).resolves.toEqual({
      type: 'rejected',
      error,
    });
  });

  it('sleeps for the requested duration', async () => {
    vi.useFakeTimers();
    try {
      const timeout = await loadTimeout();
      let finished = false;
      const sleeping = timeout.sleep(10).then(() => {
        finished = true;
      });

      await vi.advanceTimersByTimeAsync(9);
      expect(finished).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await sleeping;
      expect(finished).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps sleep timers refed so polling waits keep short-lived processes alive', async () => {
    const timeout = await loadTimeout();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    try {
      await timeout.sleep(1);
      const timer = setTimeoutSpy.mock.results[0]?.value as NodeJS.Timeout | undefined;

      expect(timer?.hasRef?.()).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('keeps abort-aware sleep timers refed so cancellable polling waits keep short-lived processes alive', async () => {
    const timeout = await loadTimeout();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const controller = new AbortController();

    try {
      const sleeping = timeout.sleepWithSignal(10_000, controller.signal);
      const timer = setTimeoutSpy.mock.results[0]?.value as NodeJS.Timeout | undefined;

      expect(timer?.hasRef?.()).toBe(true);

      controller.abort(new Error('cancelled'));
      await expect(sleeping).rejects.toThrow('cancelled');
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('rejects abort-aware sleep without waiting for the timer', async () => {
    vi.useFakeTimers();
    try {
      const timeout = await loadTimeout();
      const controller = new AbortController();
      const sleeping = timeout.sleepWithSignal(1_000, controller.signal);

      controller.abort(new Error('cancelled'));

      await expect(sleeping).rejects.toThrow('cancelled');
    } finally {
      vi.useRealTimers();
    }
  });
});
