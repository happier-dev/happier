import test from 'node:test';
import assert from 'node:assert/strict';
import { runSlicedJobs } from './sliced_runner.mjs';

test('runSlicedJobs preserves order and respects concurrency', async () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ index: i + 1 }));

  let active = 0;
  let maxActive = 0;

  const results = await runSlicedJobs({
    items,
    limit: 2,
    run: async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      return { index: item.index };
    },
  });

  assert.equal(maxActive, 2);
  assert.deepEqual(
    results.map((r) => r.index),
    items.map((i) => i.index)
  );
});

test('runSlicedJobs can abort early after the first item', async () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ index: i + 1 }));
  const seen = [];

  const results = await runSlicedJobs({
    items,
    limit: 3,
    run: async (item) => {
      seen.push(item.index);
      return { index: item.index, abort: item.index === 1 };
    },
    shouldAbortEarly: (res) => Boolean(res?.abort),
  });

  assert.deepEqual(seen, [1]);
  assert.deepEqual(results.map((r) => r.index), [1]);
});

