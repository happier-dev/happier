import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDaemonAuthScopeDiagnostic } from './format_daemon_auth_scope_diagnostic.mjs';

test('formatDaemonAuthScopeDiagnostic includes required fields', () => {
  const out = formatDaemonAuthScopeDiagnostic({
    activeServerId: 'stack_test__id_default',
    activeCredentialPath: '/tmp/cli/servers/stack_test__id_default/access.key',
    tokenSub: 'acct_123',
    repairedFromPath: null,
  });
  assert.ok(out.includes('activeServerId=stack_test__id_default'));
  assert.ok(out.includes('activeCredential='));
  assert.ok(out.includes('tokenSub=acct_123'));
  assert.ok(!out.includes('repairedFrom='));
});

test('formatDaemonAuthScopeDiagnostic includes repairedFrom when provided', () => {
  const out = formatDaemonAuthScopeDiagnostic({
    activeServerId: 'stack_test__id_default',
    activeCredentialPath: '/tmp/cli/servers/stack_test__id_default/access.key',
    tokenSub: null,
    repairedFromPath: '/tmp/cli/servers/env_hash/access.key',
  });
  assert.ok(out.includes('repairedFrom='));
});

