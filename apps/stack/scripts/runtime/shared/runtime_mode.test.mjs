import test from 'node:test';
import assert from 'node:assert/strict';

import { hasExplicitStackRuntimeModeArg, resolveStackRuntimeMode } from './runtime_mode.mjs';

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

test('resolveStackRuntimeMode follows an active source-backed runtime before stack env mode', () => {
  const resolved = resolveStackRuntimeMode({
    argv: [],
    env: { HAPPIER_STACK_RUNTIME_MODE: 'require' },
    activeRuntimeState: { runtimeSnapshotId: null },
  });

  assert.equal(resolved.mode, 'source');
  assert.equal(resolved.source, 'active-runtime');
});

test('resolveStackRuntimeMode lets explicit runtime mode override an active source-backed runtime', () => {
  const resolved = resolveStackRuntimeMode({
    argv: ['--runtime'],
    env: { HAPPIER_STACK_RUNTIME_MODE: 'require' },
    activeRuntimeState: { runtimeSnapshotId: null },
  });

  assert.equal(resolved.mode, 'require');
  assert.equal(resolved.source, 'flag');
});

test('resolveStackRuntimeMode rejects conflicting launch flags', () => {
  assert.throws(
    () => resolveStackRuntimeMode({ argv: ['--runtime', '--source'], env: {} }),
    /cannot be used together/i,
  );
});

test('hasExplicitStackRuntimeModeArg detects source/runtime flags', () => {
  assert.equal(hasExplicitStackRuntimeModeArg([]), false);
  assert.equal(hasExplicitStackRuntimeModeArg(['status', '--json']), false);
  assert.equal(hasExplicitStackRuntimeModeArg(['status', '--runtime', '--json']), true);
  assert.equal(hasExplicitStackRuntimeModeArg(['status', '--source', '--json']), true);
});
