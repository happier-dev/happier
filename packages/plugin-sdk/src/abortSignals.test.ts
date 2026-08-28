import { describe, expect, it } from 'vitest';

import { mergeAbortSignals } from './async/index.public.js';

function createTrackedAbortSignal(): Readonly<{
  signal: AbortSignal;
  abort(reason: unknown): void;
  listenerCount(): number;
}> {
  let aborted = false;
  let abortReason: unknown;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const signal = {
    get aborted() {
      return aborted;
    },
    get reason() {
      return abortReason;
    },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (type === 'abort' && listener) listeners.add(listener);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (type === 'abort' && listener) listeners.delete(listener);
    },
  } as unknown as AbortSignal;

  return Object.freeze({
    signal,
    abort(reason: unknown) {
      if (aborted) return;
      aborted = true;
      abortReason = reason;
      const event = new Event('abort');
      for (const listener of [...listeners]) {
        if (typeof listener === 'function') listener.call(signal, event);
        else listener.handleEvent(event);
      }
    },
    listenerCount: () => listeners.size,
  });
}

describe('mergeAbortSignals', () => {
  it('preserves zero and one source signals without allocating a composition', () => {
    const signal = new AbortController().signal;

    expect(mergeAbortSignals([]).signal).toBeUndefined();
    expect(mergeAbortSignals([signal]).signal).toBe(signal);
  });

  it('uses the first abort reason and detaches every source listener without AbortSignal.any', () => {
    const first = createTrackedAbortSignal();
    const second = createTrackedAbortSignal();
    const firstReason = new Error('first-abort');
    const secondReason = new Error('second-abort');
    const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', {
      configurable: true,
      value: undefined,
    });

    try {
      const merged = mergeAbortSignals([first.signal, second.signal]);
      expect(merged.signal?.aborted).toBe(false);
      expect(first.listenerCount()).toBe(1);
      expect(second.listenerCount()).toBe(1);

      first.abort(firstReason);

      expect(merged.signal?.aborted).toBe(true);
      expect(merged.signal?.reason).toBe(firstReason);
      expect(first.listenerCount()).toBe(0);
      expect(second.listenerCount()).toBe(0);

      second.abort(secondReason);
      expect(merged.signal?.reason).toBe(firstReason);
    } finally {
      if (anyDescriptor) Object.defineProperty(AbortSignal, 'any', anyDescriptor);
      else Reflect.deleteProperty(AbortSignal, 'any');
    }
  });

  it('aborts immediately from an already-aborted source without observing later sources', () => {
    const first = createTrackedAbortSignal();
    const second = createTrackedAbortSignal();
    const firstReason = new Error('already-aborted');
    first.abort(firstReason);

    const merged = mergeAbortSignals([first.signal, second.signal]);

    expect(merged.signal?.aborted).toBe(true);
    expect(merged.signal?.reason).toBe(firstReason);
    expect(second.listenerCount()).toBe(0);
  });

  it('allows a successfully settled owner to detach source listeners explicitly', () => {
    const first = createTrackedAbortSignal();
    const second = createTrackedAbortSignal();
    const merged = mergeAbortSignals([first.signal, second.signal]);

    expect(first.listenerCount()).toBe(1);
    expect(second.listenerCount()).toBe(1);

    merged.dispose();

    expect(merged.signal.aborted).toBe(false);
    expect(first.listenerCount()).toBe(0);
    expect(second.listenerCount()).toBe(0);
  });
});
