import test from 'node:test';
import assert from 'node:assert/strict';
import { runSlicedJobs } from './sliced_runner.mjs';

test('runSlicedJobs preserves order and respects concurrency', async () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ index: i + 1 }));

  let active = 0;
  let maxActive = 0;
  let startedParallel = 0;
  let releaseParallel;
  const parallelGate = new Promise((resolve) => {
    releaseParallel = resolve;
  });

  const results = await runSlicedJobs({
    items,
    limit: 2,
    run: async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (item.index > 1) {
        startedParallel += 1;
        if (startedParallel === 2) {
          releaseParallel();
        }
        await parallelGate;
      }
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
