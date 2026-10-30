import test from 'node:test';
import assert from 'node:assert/strict';

import { runReviewersSafe } from './run_reviewers_safe.mjs';

test('runReviewersSafe converts thrown errors into onError results', async () => {
  const reviewers = ['ok', 'boom', 'ok2'];

  const res = await runReviewersSafe({
    reviewers,
    runReviewer: async (r) => {
      if (r === 'boom') throw new Error('kaboom');
      return { reviewer: r, ok: true };
    },
    onError: (reviewer, error) => ({ reviewer, ok: false, message: String(error?.message ?? error) }),
  });

  assert.deepEqual(res.map((r) => r.reviewer), reviewers);
  assert.deepEqual(res[0], { reviewer: 'ok', ok: true });
  assert.equal(res[1].ok, false);
  assert.match(res[1].message, /kaboom/);
  assert.deepEqual(res[2], { reviewer: 'ok2', ok: true });
});

