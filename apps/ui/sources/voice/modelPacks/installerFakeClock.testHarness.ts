import { vi } from 'vitest';

// Transient-failure retries back off on the clock. Tests fake only timers and keep advancing them while
// real microtasks and IO callbacks run, so dynamic imports and native-boundary mocks still settle.
export function useInstallerFakeClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

export async function settleWithFakeClock<T>(pending: Promise<T>): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | null = null;
  void pending.then((value) => { outcome = { ok: true, value }; }, (error: unknown) => { outcome = { ok: false, error }; });
  while (!outcome) {
    await vi.advanceTimersByTimeAsync(1_000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const settled = outcome as { ok: true; value: T } | { ok: false; error: unknown };
  if (!settled.ok) throw settled.error;
  return settled.value;
}
