import { afterEach, describe, expect, it, vi } from 'vitest';

import { TmuxUtilities } from './TmuxUtilities';
import { isTmuxAvailable } from './factory';

describe('isTmuxAvailable', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fails closed when the ambient tmux server probe hangs', async () => {
    vi.useFakeTimers();
    vi.spyOn(TmuxUtilities.prototype, 'executeTmuxCommand').mockImplementation(
      () => new Promise(() => undefined),
    );

    const availability = isTmuxAvailable();
    await vi.advanceTimersByTimeAsync(60_000);
    const available = await availability;

    expect(available).toBe(false);
  });
});
