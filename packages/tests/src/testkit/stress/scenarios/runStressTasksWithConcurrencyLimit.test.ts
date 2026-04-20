import { describe, expect, it } from 'vitest';

import { runStressTasksWithConcurrencyLimit } from './runStressTasksWithConcurrencyLimit';

describe('runStressTasksWithConcurrencyLimit', () => {
  it('runs all items while respecting the configured concurrency ceiling and preserving result order', async () => {
    let active = 0;
    let maxActive = 0;

    const results = await runStressTasksWithConcurrencyLimit([0, 1, 2, 3, 4], 2, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return item * 10;
    });

    expect(results).toEqual([0, 10, 20, 30, 40]);
    expect(maxActive).toBe(2);
  });

  it('falls back to single-worker execution when the requested concurrency is invalid', async () => {
    const order: number[] = [];

    const results = await runStressTasksWithConcurrencyLimit([1, 2, 3], 0, async (item) => {
      order.push(item);
      return item;
    });

    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });
});
