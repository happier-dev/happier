import test from 'node:test';
import assert from 'node:assert/strict';

import { applyTuiStackAuthScopeEnv } from './stack_scope_env.mjs';

test('applyTuiStackAuthScopeEnv overrides HAPPIER_ACTIVE_SERVER_ID per stack', () => {
  const env = applyTuiStackAuthScopeEnv({
    env: { HAPPIER_ACTIVE_SERVER_ID: 'main', HAPPIER_STACK_CLI_IDENTITY: 'default' },
    stackName: 'repo-dev-a1cc5e0671',
  });
  assert.equal(env.HAPPIER_ACTIVE_SERVER_ID, 'stack_repo-dev-a1cc5e0671__id_default');
});

test('applyTuiStackAuthScopeEnv deletes HAPPIER_ACTIVE_SERVER_ID when stable scope is disabled', () => {
  const env = applyTuiStackAuthScopeEnv({
    env: { HAPPIER_ACTIVE_SERVER_ID: 'main', HAPPIER_STACK_DISABLE_STABLE_SCOPE: '1' },
    stackName: 'repo-dev-a1cc5e0671',
  });
  assert.equal(env.HAPPIER_ACTIVE_SERVER_ID, undefined);
});

