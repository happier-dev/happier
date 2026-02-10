import test from 'node:test';
import assert from 'node:assert/strict';

import { buildClaudeReviewArgs, detectClaudeAuthError } from './claude.mjs';

test('buildClaudeReviewArgs includes non-interactive flags', () => {
  const args = buildClaudeReviewArgs();
  assert.deepEqual(args, [
    '--print',
    '--input-format',
    'text',
    '--output-format',
    'text',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--permission-mode',
    'bypassPermissions',
    '--allowed-tools',
    'Bash(git:*),Bash(rg:*),Bash(cat:*),Bash(sed:*),Bash(ls:*),Bash(wc:*),Bash(head:*),Bash(tail:*)',
  ]);
});

test('buildClaudeReviewArgs includes --model when provided', () => {
  const args = buildClaudeReviewArgs({ model: 'opus' });
  assert.equal(args.includes('--model'), true);
  const idx = args.indexOf('--model');
  assert.equal(args[idx + 1], 'opus');
});

test('detectClaudeAuthError matches login/auth failures', () => {
  const stdout = 'Authentication required. Run `claude login` to continue.';
  assert.equal(detectClaudeAuthError({ stdout, stderr: '' }), true);
});

test('detectClaudeAuthError matches rate-limit failures', () => {
  const stderr = 'HTTP 429: rate limit exceeded';
  assert.equal(detectClaudeAuthError({ stdout: '', stderr }), true);
});

test('detectClaudeAuthError returns false for normal output', () => {
  assert.equal(detectClaudeAuthError({ stdout: 'Review completed', stderr: '' }), false);
});

test('detectClaudeAuthError does not treat reviewer prose as a runtime rate-limit failure', () => {
  const stdout = 'If gh release upload fails due to a transient network issue or rate limit, the job fails.';
  assert.equal(detectClaudeAuthError({ stdout, stderr: '' }), false);
});
