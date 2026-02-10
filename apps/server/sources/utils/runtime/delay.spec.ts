import { describe, expect, it } from 'vitest';

import { delay } from './delay';

class FakeAbortSignal {
  aborted = false;
  readonly listeners = new Set<() => void>();

  addEventListener(_type: 'abort', listener: () => void) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'abort', listener: () => void) {
    this.listeners.delete(listener);
  }

  abort() {
    this.aborted = true;
    for (const listener of Array.from(this.listeners)) listener();
  }
}

describe('delay', () => {
  it('removes abort listener when timer completes normally', async () => {
    const signal = new FakeAbortSignal();
    await delay(1, signal as unknown as AbortSignal);
    expect(signal.listeners.size).toBe(0);
  });
});

