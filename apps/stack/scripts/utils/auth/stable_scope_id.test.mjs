import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyStackActiveServerScopeEnv,
  buildStackStableScopeId,
  resolveStackActiveServerId,
} from './stable_scope_id.mjs';

test('buildStackStableScopeId is deterministic for stack + identity', () => {
  const a = buildStackStableScopeId({ stackName: 'main', cliIdentity: 'default' });
  const b = buildStackStableScopeId({ stackName: 'main', cliIdentity: 'default' });
  assert.equal(a, b);
  assert.equal(a, 'stack_main__id_default');
});

test('buildStackStableScopeId isolates identities within the same stack', () => {
  const a = buildStackStableScopeId({ stackName: 'dev-auth', cliIdentity: 'default' });
  const b = buildStackStableScopeId({ stackName: 'dev-auth', cliIdentity: 'account-b' });
  assert.notEqual(a, b);
});

test('resolveStackActiveServerId honors explicit env override when enabled', () => {
  const env = { HAPPIER_ACTIVE_SERVER_ID: 'custom_scope_1' };
  const id = resolveStackActiveServerId({ env, stackName: null, cliIdentity: null });
  assert.equal(id, 'custom_scope_1');
});

test('applyStackActiveServerScopeEnv overwrites leaked active server id for stack scope', () => {
  const env = {
    HAPPIER_ACTIVE_SERVER_ID: 'stack_other__id_default',
  };
  const next = applyStackActiveServerScopeEnv({ env, stackName: 'dev-auth', cliIdentity: 'default' });
  assert.equal(next.HAPPIER_ACTIVE_SERVER_ID, 'stack_dev-auth__id_default');
});

test('applyStackActiveServerScopeEnv unsets active scope when stable scope is disabled', () => {
  const env = {
    HAPPIER_STACK_STACK: 'main',
    HAPPIER_STACK_DISABLE_STABLE_SCOPE: '1',
    HAPPIER_ACTIVE_SERVER_ID: 'stack_main__id_default',
  };
  const next = applyStackActiveServerScopeEnv({ env, stackName: 'main', cliIdentity: 'default' });
  assert.equal(next.HAPPIER_ACTIVE_SERVER_ID, undefined);
});

test('applyStackActiveServerScopeEnv sets generated stable scope id by default', () => {
  const env = { HAPPIER_STACK_STACK: 'feature-123' };
  const next = applyStackActiveServerScopeEnv({ env, stackName: 'feature-123', cliIdentity: 'account-b' });
  assert.equal(next.HAPPIER_ACTIVE_SERVER_ID, 'stack_feature-123__id_account-b');
});
