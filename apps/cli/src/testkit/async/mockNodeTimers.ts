import { vi } from 'vitest';

// ESM bindings captured from node:timers before useFakeTimers stay on the real
// clock. Bridge this OS boundary to the clock that the test installs globally.
vi.mock('node:timers', async importOriginal => ({
  ...await importOriginal<typeof import('node:timers')>(),
  setTimeout: (callback: () => void, delay?: number) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(handle),
}));
