import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCodexReviewArgs,
  detectCodexUnsupportedModelError,
  extractCodexReviewFromJsonl,
  isCodexModelKnownUnsupported,
  markCodexModelUnsupported,
} from './codex.mjs';

test('buildCodexReviewArgs uses --base and avoids --cd', () => {
  const args = buildCodexReviewArgs({ baseRef: 'upstream/main', jsonMode: false });
  assert.equal(args.includes('--cd'), false);
  assert.deepEqual(args, [
    'exec',
    'review',
    '--dangerously-bypass-approvals-and-sandbox',
    '-c',
    'mcp_servers={}',
    '--base',
    'upstream/main',
  ]);
});

test('buildCodexReviewArgs uses --experimental-json when jsonMode is true', () => {
  const args = buildCodexReviewArgs({ baseRef: 'upstream/main', jsonMode: true });
  assert.deepEqual(args, [
    'exec',
    'review',
    '--dangerously-bypass-approvals-and-sandbox',
    '-c',
    'mcp_servers={}',
    '--base',
    'upstream/main',
    '--json',
  ]);
});

test('buildCodexReviewArgs appends a prompt when provided', () => {
  const args = buildCodexReviewArgs({ baseRef: null, jsonMode: false, prompt: 'be thorough' });
  assert.deepEqual(args, ['exec', 'review', '--dangerously-bypass-approvals-and-sandbox', '-c', 'mcp_servers={}', 'be thorough']);
});

test('buildCodexReviewArgs includes --model when provided', () => {
  const args = buildCodexReviewArgs({ baseRef: 'upstream/main', jsonMode: false, model: 'codex-5.3' });
  assert.deepEqual(args, [
    'exec',
    'review',
    '--dangerously-bypass-approvals-and-sandbox',
    '-c',
    'mcp_servers={}',
    '--base',
    'upstream/main',
    '--model',
    'codex-5.3',
  ]);
});

test('buildCodexReviewArgs defaults to --uncommitted for targetless review', () => {
  const args = buildCodexReviewArgs({ baseRef: '', jsonMode: false, prompt: '   ' });
  assert.deepEqual(args, [
    'exec',
    'review',
    '--dangerously-bypass-approvals-and-sandbox',
    '-c',
    'mcp_servers={}',
    '--uncommitted',
  ]);
});

test('buildCodexReviewArgs ignores prompt when baseRef target is provided', () => {
  const args = buildCodexReviewArgs({ baseRef: 'upstream/main', jsonMode: false, prompt: 'be thorough' });
  assert.equal(args.includes('be thorough'), false);
  assert.equal(args.includes('--uncommitted'), false);
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

test('extractCodexReviewFromJsonl returns null for invalid/no-match lines', () => {
  const result = extractCodexReviewFromJsonl('not-json\n{"type":"Progress","payload":{"x":1}}\n');
  assert.equal(result, null);
});

test('detectCodexUnsupportedModelError detects the ChatGPT-account unsupported-model failure', () => {
  assert.equal(
    detectCodexUnsupportedModelError({
      stdout: '',
      stderr: `ERROR: {"detail":"The 'codex-5.3' model is not supported when using Codex with a ChatGPT account."}`,
    }),
    true,
  );
  assert.equal(detectCodexUnsupportedModelError({ stdout: 'ok', stderr: '' }), false);
});

test('markCodexModelUnsupported / isCodexModelKnownUnsupported track unsupported models', () => {
  const model = `test-model-${process.hrtime.bigint()}`;
  assert.equal(isCodexModelKnownUnsupported(model), false);
  markCodexModelUnsupported(model);
  assert.equal(isCodexModelKnownUnsupported(model), true);
  assert.equal(isCodexModelKnownUnsupported(` ${model} `), true);
});
