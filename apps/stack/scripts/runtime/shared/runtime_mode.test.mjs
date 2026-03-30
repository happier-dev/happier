import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveStackRuntimeMode } from './runtime_mode.mjs';

test('resolveStackRuntimeMode defaults to source mode', () => {
  const resolved = resolveStackRuntimeMode({ argv: [], env: {} });

  assert.equal(resolved.mode, 'source');
  assert.equal(resolved.source, 'default');
});

test('resolveStackRuntimeMode reads prefer mode from stack env', () => {
  const resolved = resolveStackRuntimeMode({
    argv: [],
    env: { HAPPIER_STACK_RUNTIME_MODE: 'prefer' },
  });

  assert.equal(resolved.mode, 'prefer');
  assert.equal(resolved.source, 'env');
});

test('resolveStackRuntimeMode lets --runtime override source env mode', () => {
  const resolved = resolveStackRuntimeMode({
    argv: ['--runtime'],
    env: { HAPPIER_STACK_RUNTIME_MODE: 'source' },
  });

  assert.equal(resolved.mode, 'require');
  assert.equal(resolved.source, 'flag');
});

test('resolveStackRuntimeMode lets --source override prefer env mode', () => {
  const resolved = resolveStackRuntimeMode({
    argv: ['--source'],
    env: { HAPPIER_STACK_RUNTIME_MODE: 'prefer' },
  });

  assert.equal(resolved.mode, 'source');
  assert.equal(resolved.source, 'flag');
});

test('resolveStackRuntimeMode rejects conflicting launch flags', () => {
  assert.throws(
    () => resolveStackRuntimeMode({ argv: ['--runtime', '--source'], env: {} }),
    /cannot be used together/i,
  );
});
