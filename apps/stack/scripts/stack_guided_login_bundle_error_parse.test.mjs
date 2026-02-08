import test from 'node:test';
import assert from 'node:assert/strict';

import { parseExpoBundleErrorPayload } from './utils/auth/stack_guided_login.mjs';

test('parseExpoBundleErrorPayload extracts resolver errors from Metro JSON payloads', () => {
  const payload = JSON.stringify({
    type: 'UnableToResolveError',
    message: 'Unable to resolve module ../ops from /tmp/taskSessionLink.ts',
  });
  const parsed = parseExpoBundleErrorPayload(payload);
  assert.equal(parsed.type, 'UnableToResolveError');
  assert.match(parsed.message, /Unable to resolve module/i);
  assert.equal(parsed.isResolverError, true);
});

test('parseExpoBundleErrorPayload returns null for non-json payloads', () => {
  const parsed = parseExpoBundleErrorPayload('<html>500</html>');
  assert.equal(parsed, null);
});
