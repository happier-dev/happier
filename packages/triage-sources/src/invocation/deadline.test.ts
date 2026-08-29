import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createBoundedInvocation,
} from '../runtime.js';

describe('createBoundedInvocation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('distinguishes its deadline from caller cancellation', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const timed = createBoundedInvocation({ callerSignal: caller.signal, timeoutMs: 25 });

    await vi.advanceTimersByTimeAsync(25);

    expect(timed.signal.aborted).toBe(true);
    expect(timed.signal.reason).toMatchObject({ name: 'TimeoutError' });
    timed.dispose();

    const cancelled = new AbortController();
    const bounded = createBoundedInvocation({ callerSignal: cancelled.signal, timeoutMs: 25 });
    const reason = new Error('caller left');
    cancelled.abort(reason);

    expect(bounded.signal.aborted).toBe(true);
    expect(bounded.signal.reason).toBe(reason);
    bounded.dispose();
  });

  it('disposes its timer after normal completion', async () => {
    vi.useFakeTimers();
    const bounded = createBoundedInvocation({ timeoutMs: 25 });

    bounded.dispose();
    await vi.advanceTimersByTimeAsync(25);

    expect(bounded.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('adds no timer when the caller supplies no external deadline', () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const invocation = createBoundedInvocation({ callerSignal: caller.signal });

    expect(invocation.signal).toBe(caller.signal);
    expect(vi.getTimerCount()).toBe(0);

    const reason = new Error('caller stopped');
    caller.abort(reason);
    expect(invocation.signal.reason).toBe(reason);
    invocation.dispose();
  });
});
