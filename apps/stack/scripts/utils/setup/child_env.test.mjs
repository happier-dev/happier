import { strict as assert } from 'node:assert';
import test from 'node:test';

import { buildSetupChildEnv } from './child_env.mjs';

test('buildSetupChildEnv preserves base env and sets setup child marker', () => {
  const env = buildSetupChildEnv({
    baseEnv: { FOO: 'bar' },
  });

  assert.equal(env.HAPPIER_STACK_SETUP_CHILD, '1');
  assert.equal(env.FOO, 'bar');
});

test('buildSetupChildEnv sets workspace dir when provided', () => {
  const env = buildSetupChildEnv({
    baseEnv: { FOO: 'bar' },
    workspaceDirWanted: '/tmp/custom/workspace',
  });

  assert.equal(env.HAPPIER_STACK_SETUP_CHILD, '1');
  assert.equal(env.FOO, 'bar');
  assert.equal(env.HAPPIER_STACK_WORKSPACE_DIR, '/tmp/custom/workspace');
});

test('buildSetupChildEnv does not clear existing workspace dir when not explicitly set', () => {
  const env = buildSetupChildEnv({
    baseEnv: {
      HAPPIER_STACK_SETUP_CHILD: '0',
      HAPPIER_STACK_WORKSPACE_DIR: '/tmp/base/workspace',
    },
  });

  assert.equal(env.HAPPIER_STACK_SETUP_CHILD, '1');
  assert.equal(env.HAPPIER_STACK_WORKSPACE_DIR, '/tmp/base/workspace');
});
