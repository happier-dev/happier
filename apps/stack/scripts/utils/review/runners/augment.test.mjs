import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAugmentReviewArgs, detectAugmentAuthError } from './augment.mjs';

test('detectAugmentAuthError matches 401 login guidance', () => {
  const stdout = "❌ Authentication failed: HTTP error: 401 Unauthorized\n   Run 'auggie login' to authenticate first.";
  assert.equal(detectAugmentAuthError({ stdout, stderr: '' }), true);
});

test('buildAugmentReviewArgs builds auggie --print args with optional settings', () => {
  const args = buildAugmentReviewArgs({
    prompt: 'Review the code',
    workspaceRoot: '/repo',
    cacheDir: '/cache',
    model: 'gpt-5.2',
    rulesFiles: ['/rules/a.md', '/rules/b.md'],
    retryTimeoutSec: 123,
    maxTurns: 9,
  });

  assert.equal(args[0], '--print');
  assert.ok(args.includes('--quiet'));
  assert.ok(args.includes('--dont-save-session'));
  assert.ok(args.includes('--ask'));
  assert.ok(args.includes('--workspace-root'));
  assert.ok(args.includes('/repo'));
  assert.ok(args.includes('--augment-cache-dir'));
  assert.ok(args.includes('/cache'));
  assert.ok(args.includes('--model'));
  assert.ok(args.includes('gpt-5.2'));
  assert.ok(args.includes('--retry-timeout'));
  assert.ok(args.includes('123'));
  assert.ok(args.includes('--max-turns'));
  assert.ok(args.includes('9'));

  const joined = args.join(' ');
  assert.match(joined, /--rules \/rules\/a\.md/);
  assert.match(joined, /--rules \/rules\/b\.md/);
  assert.equal(args.at(-1), 'Review the code');
});

