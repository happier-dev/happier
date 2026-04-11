import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveStackHappierPassthroughInvocation } from './stack_happier_passthrough_command.mjs';

test('resolveStackHappierPassthroughInvocation strips spaced wrapper identity args when no separator is used', () => {
  const invocation = resolveStackHappierPassthroughInvocation({
    passthrough: ['--identity', 'account-b', '--json'],
  });

  assert.equal(invocation.identity, 'account-b');
  assert.deepEqual(invocation.childArgs, ['--json']);
});

test('resolveStackHappierPassthroughInvocation strips inline wrapper identity args when no separator is used', () => {
  const invocation = resolveStackHappierPassthroughInvocation({
    passthrough: ['--identity=account-b', '--json'],
  });

  assert.equal(invocation.identity, 'account-b');
  assert.deepEqual(invocation.childArgs, ['--json']);
});

test('resolveStackHappierPassthroughInvocation preserves child identity args after separator', () => {
  const invocation = resolveStackHappierPassthroughInvocation({
    passthrough: ['--identity=account-b', '--', '--identity', 'child-account', '--json'],
  });

  assert.equal(invocation.identity, 'account-b');
  assert.deepEqual(invocation.childArgs, ['--identity', 'child-account', '--json']);
});
