import { describe, expect, it } from 'vitest';

import { waitFor } from '../../src/testkit/timing';

describe('testkit: timing.waitFor', () => {
  it('supports fail-fast mode for deterministic predicate errors', async () => {
    let attempts = 0;

    await expect(
      waitFor(
        async () => {
          attempts++;
          throw new Error('deterministic-boom');
        },
        { timeoutMs: 500, intervalMs: 1, failFast: true },
      ),
    ).rejects.toThrow('deterministic-boom');

    expect(attempts).toBe(1);
  });

  it('includes last predicate error context on timeout', async () => {
    await expect(
      waitFor(
        async () => {
          throw new Error('still-initializing');
        },
        { timeoutMs: 25, intervalMs: 1 },
      ),
    ).rejects.toThrow('still-initializing');
  });
});
