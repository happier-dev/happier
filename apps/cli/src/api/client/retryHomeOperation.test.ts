import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpStatusError } from '@/api/client/httpStatusError';
import { retryHomeOperation } from './retryHomeOperation';

afterEach(() => vi.restoreAllMocks());

describe('post-claim Home recovery', () => {
  it('redelivers repeatable work until success within a cancellable operation without a separate deadline', async () => {
    const controller = new AbortController();
    const request = vi.fn().mockRejectedValueOnce(createHttpStatusError(503, 'Home unavailable')).mockResolvedValue('recorded');
    await expect(retryHomeOperation({ signal: controller.signal, pollIntervalMs: 0 }, request)).resolves.toBe('recorded');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 409])('does not replay an authoritative refusal (HTTP %s)', async status => {
    const refusal = createHttpStatusError(status, 'Home refused enrollment');
    // Substitute only the Home request boundary; the retry policy is real.
    const request = vi.fn(async () => { throw refusal; });
    await expect(retryHomeOperation({ deadlineMs: Date.now() + 60_000, pollIntervalMs: 1000 }, request))
      .rejects.toBe(refusal);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('uses the remaining lifetime and preserves the last Home failure when it expires', async () => {
    // Vitest's global fake timers do not advance node:timers/promises. Keep
    // that real boundary and control only the clock observed by the owner.
    let nowMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const unavailable = createHttpStatusError(503, 'Home unavailable');
    const request = vi.fn(async () => { nowMs += 2; throw unavailable; });
    await expect(retryHomeOperation({ deadlineMs: 3, pollIntervalMs: 1000 }, request))
      .rejects.toBe(unavailable);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('cancels recovery without dispatching another Home request', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => {
      controller.abort();
      throw createHttpStatusError(503, 'Home unavailable');
    });
    await expect(retryHomeOperation({ deadlineMs: Date.now() + 60_000,
      pollIntervalMs: 1000, signal: controller.signal }, request)).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
