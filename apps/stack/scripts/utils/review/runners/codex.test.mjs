import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCodexReviewArgs, extractCodexReviewFromJsonl } from './codex.mjs';

test('buildCodexReviewArgs uses --base and avoids --cd', () => {
  const args = buildCodexReviewArgs({ baseRef: 'upstream/main', jsonMode: false });
  assert.equal(args.includes('--cd'), false);
  assert.deepEqual(args, ['exec', 'review', '--dangerously-bypass-approvals-and-sandbox', '--base', 'upstream/main']);
});

test('buildCodexReviewArgs uses --experimental-json when jsonMode is true', () => {
  const args = buildCodexReviewArgs({ baseRef: 'upstream/main', jsonMode: true });
  assert.deepEqual(args, ['exec', 'review', '--dangerously-bypass-approvals-and-sandbox', '--base', 'upstream/main', '--json']);
});

test('buildCodexReviewArgs appends a prompt when provided', () => {
  const args = buildCodexReviewArgs({ baseRef: null, jsonMode: false, prompt: 'be thorough' });
  assert.deepEqual(args, ['exec', 'review', '--dangerously-bypass-approvals-and-sandbox', 'be thorough']);
});

test('extractCodexReviewFromJsonl finds review_output in multiple event shapes', () => {
  const out1 = extractCodexReviewFromJsonl(
    JSON.stringify({ msg: { ExitedReviewMode: { review_output: { a: 1 } } } }) + '\n'
  );
  assert.deepEqual(out1, { a: 1 });

  const out2 = extractCodexReviewFromJsonl(JSON.stringify({ type: 'ExitedReviewMode', review_output: { b: 2 } }) + '\n');
  assert.deepEqual(out2, { b: 2 });

  const out3 = extractCodexReviewFromJsonl(
    JSON.stringify({ event: { type: 'ExitedReviewMode', reviewOutput: { c: 3 } } }) + '\n'
  );
  assert.deepEqual(out3, { c: 3 });
});
