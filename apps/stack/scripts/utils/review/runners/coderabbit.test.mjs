import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCodeRabbitRateLimitRetryMs } from './coderabbit.mjs';

test('parseCodeRabbitRateLimitRetryMs returns null when no rate limit message is present', () => {
  assert.equal(parseCodeRabbitRateLimitRetryMs('Review completed ✔'), null);
});

test('parseCodeRabbitRateLimitRetryMs parses the suggested retry delay', () => {
  const ms = parseCodeRabbitRateLimitRetryMs(
    '[2026-01-25T22:29:41.623Z] ❌ ERROR: Error: Rate limit exceeded, please try after 3 minutes and 2 seconds'
  );
  assert.ok(ms);
  // Allow +1s padding.
  assert.equal(ms, (3 * 60 + 2 + 1) * 1000);
});

test('parseCodeRabbitRateLimitRetryMs supports seconds-only windows', () => {
  const ms = parseCodeRabbitRateLimitRetryMs(
    '[2026-01-26T00:27:23.067Z] ❌ ERROR: Error: Rate limit exceeded, please try after 0 minutes and 31 seconds'
  );
  assert.ok(ms);
  assert.equal(ms, (31 + 1) * 1000);
});

