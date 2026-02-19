import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from './utils/cli/args.mjs';
import { applyAuthForceEnv, resolveAuthForceFlag } from './utils/auth/auth_force_flag.mjs';

test('resolveAuthForceFlag is false by default', () => {
  const { flags, kv } = parseArgs(['cmd']);
  assert.equal(resolveAuthForceFlag({ flags, kv }), false);
});

test('resolveAuthForceFlag is true when --force flag is present', () => {
  const { flags, kv } = parseArgs(['cmd', '--force']);
  assert.equal(resolveAuthForceFlag({ flags, kv }), true);
});

test('applyAuthForceEnv sets HAPPIER_AUTH_FORCE=1 when forced', () => {
  const out = applyAuthForceEnv({ SOME: 'x' }, true);
  assert.equal(out.HAPPIER_AUTH_FORCE, '1');
  assert.equal(out.SOME, 'x');
});

test('applyAuthForceEnv preserves env when not forced', () => {
  const out = applyAuthForceEnv({ SOME: 'x' }, false);
  assert.equal(out.HAPPIER_AUTH_FORCE, undefined);
  assert.equal(out.SOME, 'x');
});

