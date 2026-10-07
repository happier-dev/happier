import assert from 'node:assert/strict';
import test from 'node:test';

import { createTuiSummaryRefresh } from './summary_refresh.mjs';

test('timer and action refreshes share an in-flight summary read and render', async () => {
  let releaseRead;
  const read = new Promise((resolve) => { releaseRead = resolve; });
  let activeReads = 0;
  let peakReads = 0;
  let rendered = 0;
  const refresh = createTuiSummaryRefresh(async () => {
    activeReads += 1;
    peakReads = Math.max(peakReads, activeReads);
    await read;
    activeReads -= 1;
    rendered += 1;
  });

  const timerRefresh = refresh();
  const actionRefresh = refresh();
  await Promise.resolve();
  releaseRead();
  await Promise.all([timerRefresh, actionRefresh]);
  assert.equal(peakReads, 1, 'a slow read must not multiply network and filesystem work');
  assert.equal(rendered, 1);

  await refresh();
  assert.equal(rendered, 2, 'the next tick still reads and renders current state');
});

test('a failed refresh rejects its observers and leaves the next refresh runnable', async () => {
  const failure = new Error('summary read unavailable');
  let unavailable = true;
  let rendered = false;
  const refresh = createTuiSummaryRefresh(async () => {
    if (unavailable) throw failure;
    rendered = true;
  });
  const outcomes = await Promise.allSettled([refresh(), refresh()]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['rejected', 'rejected']);
  for (const outcome of outcomes) assert.equal(outcome.reason, failure);
  unavailable = false;
  await refresh();
  assert.equal(rendered, true);
});
