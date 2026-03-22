import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createReviewCommandFixture,
  findSingleReviewerResult,
  parseJsonStdout,
  runHstackForReview,
} from './testkit/review_command_testkit.mjs';

test('review maps --codex-model=codex-5.3 to gpt-5.3-codex', async (t) => {
  const { baseSha, env } = await createReviewCommandFixture(t, {
    labelPrefix: 'test-codex-model-alias',
    reviewers: ['codex'],
  });

  const res = runHstackForReview({
    env,
    args: [
      'tools',
      'review',
      'cli',
      '--reviewers=codex',
      '--depth=normal',
      `--base-ref=${baseSha}`,
      '--type=uncommitted',
      '--codex-model=codex-5.3',
      '--run-label=test-codex-model-alias',
      '--json',
    ],
  });

  const out = parseJsonStdout(res);
  const rr = findSingleReviewerResult(out, 'codex');
  const args = JSON.parse(String(rr.stdout ?? '').trim());
  const idx = args.indexOf('--model');
  assert.ok(idx >= 0, '[test] expected codex --model');
  assert.equal(args[idx + 1], 'gpt-5.3-codex');
});
