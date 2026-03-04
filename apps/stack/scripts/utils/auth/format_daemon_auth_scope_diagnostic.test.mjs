import test from 'node:test';
import assert from 'node:assert/strict';
import * as diag from './format_daemon_auth_scope_diagnostic.mjs';

test('formatDaemonAuthScopeDiagnostic includes required fields', () => {
  const out = diag.formatDaemonAuthScopeDiagnostic({
    activeServerId: 'stack_test__id_default',
    activeCredentialPath: '/tmp/cli/servers/stack_test__id_default/access.key',
    tokenSub: 'acct_123',
    tokenSubBeforeRepair: null,
    repairedFromPath: null,
    repairedFromSub: null,
  });
  assert.ok(out.includes('activeServerId=stack_test__id_default'));
  assert.ok(out.includes('activeCredential='));
  assert.ok(out.includes('tokenSub=acct_123'));
  assert.ok(!out.includes('repairedFrom='));
});

test('formatDaemonAuthScopeDiagnostic includes repairedFrom when provided', () => {
  const out = diag.formatDaemonAuthScopeDiagnostic({
    activeServerId: 'stack_test__id_default',
    activeCredentialPath: '/tmp/cli/servers/stack_test__id_default/access.key',
    tokenSub: null,
    tokenSubBeforeRepair: null,
    repairedFromPath: '/tmp/cli/servers/env_hash/access.key',
    repairedFromSub: 'acct_999',
  });
  assert.ok(out.includes('repairedFrom='));
  assert.ok(out.includes('repairedFromSub=acct_999'));
});

test('formatDaemonAuthScopeDiagnostic labels tokenSubBeforeRepair explicitly', () => {
  const out = diag.formatDaemonAuthScopeDiagnostic({
    activeServerId: 'stack_test__id_default',
    activeCredentialPath: '/tmp/cli/servers/stack_test__id_default/access.key',
    tokenSub: 'acct_new',
    tokenSubBeforeRepair: 'acct_old',
    repairedFromPath: null,
    repairedFromSub: null,
  });
  assert.ok(out.includes('tokenSubBeforeRepair=acct_old'));
});

test('formatDaemonCredentialsTokenSubChangedWarning sanitizes tokenSub values for logs', () => {
  assert.equal(typeof diag.formatDaemonCredentialsTokenSubChangedWarning, 'function');
  const out = diag.formatDaemonCredentialsTokenSubChangedWarning({
    tokenSubBeforeRepair: 'acct_old\nINJECT',
    tokenSub: 'acct_new\t\tOK',
  });
  assert.equal(typeof out, 'string');
  assert.ok(out.includes('acct_old INJECT'));
  assert.ok(out.includes('acct_new OK'));
  assert.equal(out.includes('\n'), false);
  assert.equal(out.includes('\t'), false);
});
