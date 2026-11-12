import { afterEach, expect, it, vi } from 'vitest';
import { createPiSessionOpenLifecycle } from './operations.js';

afterEach(() => vi.useRealTimers());

it.each([false, true])('preserves the stalled inner phase when outer wait starts later: %s', async (innerFirst) => {
  vi.useFakeTimers();
  const lifecycle = createPiSessionOpenLifecycle();
  let enterProvider!: () => void;
  const providerReady = new Promise<void>((resolve) => { enterProvider = resolve; });
  let innerError: unknown;
  const runtime = (async () => {
    if (!innerFirst) await providerReady;
    return await lifecycle.waitFor(new Promise<void>(() => {}), 'provider session state')
      .catch((error: unknown) => { innerError = error; throw error; });
  })();
  const outcome = lifecycle.waitFor(runtime, undefined).catch((error: unknown) => error);
  enterProvider();
  await vi.advanceTimersByTimeAsync(300_000);
  const error = await outcome;
  expect(error).toMatchObject({ name: 'PiSessionOpenTimeoutError', phase: 'provider session state' });
  expect(error).toBe(innerError);
  lifecycle.dispose();
});
