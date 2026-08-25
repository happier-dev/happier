import { describe, expect, it, vi } from 'vitest';

import { mapWithConcurrency } from './concurrency.ts';

describe('bundled Plugin projection concurrency', () => {
  it('overlaps independent work without exceeding the configured bound', async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const started: number[] = [];

    const resultPromise = mapWithConcurrency([1, 2, 3], 2, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      started.push(value);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return value * 10;
    });

    await vi.waitFor(() => expect(started).toEqual([1, 2]));
    expect(maximumActive).toBe(2);
    releases.shift()?.();
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
    releases.splice(0).forEach((release) => release());

    await expect(resultPromise).resolves.toEqual([10, 20, 30]);
    expect(maximumActive).toBe(2);
  });
});
