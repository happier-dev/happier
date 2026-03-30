import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  buildServerProfilesSeedEntries,
  buildTokenStorageCredentialKeys,
} from '../../../../.project/scripts/qa/wsreplMatrixCredentials.mjs';

function sha256Base64Url(value) {
  const hash = crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest();
  return hash.toString('base64url');
}

test('buildTokenStorageCredentialKeys covers TokenStorage primary + legacy scopes for localhost', () => {
  const serverUrl = 'http://localhost:53288';
  const keys = buildTokenStorageCredentialKeys({ serverUrl, stackName: 'repo-dev-a1cc5e0671' });

  assert.ok(keys.includes('auth_credentials__srv_default'));
  assert.ok(keys.includes('auth_credentials__srv_localhost-53288'));
  // TokenStorage scope tokens are sanitized (non [a-z0-9._-] -> '_' and collapsed), so `__id_default`
  // becomes `_id_default`.
  assert.ok(keys.includes('auth_credentials__srv_stack_repo-dev-a1cc5e0671_id_default'));

  assert.ok(keys.includes(`auth_credentials__srv_${sha256Base64Url('http://localhost:53288')}`));
  // TokenStorage still probes a legacy hash scope that treats 127.0.0.1 distinct from localhost.
  assert.ok(keys.includes(`auth_credentials__srv_${sha256Base64Url('http://127.0.0.1:53288')}`));
});

test('buildServerProfilesSeedEntries seeds MMKV server-profiles state and tab-scoped activeServerId', () => {
  const serverUrl = 'http://127.0.0.1:53288';
  const seeded = buildServerProfilesSeedEntries({ serverUrl, nowMs: 1234 });

  assert.equal(seeded.serverId, '127.0.0.1-53288');
  assert.deepEqual(seeded.sessionStorageEntries, [['activeServerId', '127.0.0.1-53288']]);

  const storageEntry = seeded.localStorageEntries.find(([k]) => k.endsWith('\\server-state-v1')) ?? null;
  assert.ok(storageEntry, 'expected a server-state-v1 entry under mmkv.server-profiles');
  const [, value] = storageEntry;
  const parsed = JSON.parse(value);
  assert.equal(parsed.activeServerId, '127.0.0.1-53288');
  assert.equal(parsed.activeServerIdIsExplicit, true);
  assert.equal(parsed.servers['127.0.0.1-53288'].serverUrl, 'http://127.0.0.1:53288');
});
