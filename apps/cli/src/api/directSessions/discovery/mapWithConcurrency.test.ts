import { describe, expect, it } from 'vitest';

import { mapWithConcurrency } from './mapWithConcurrency';

describe('mapWithConcurrency', () => {
  it('preserves item order while respecting the requested concurrency', async () => {
    let active = 0;
    let maxActive = 0;

    const result = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return value * 2;
    });

    expect(result).toEqual([2, 4, 6, 8]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
