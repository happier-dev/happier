import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { parseRateLimitCatalog, toUpperSnakeCase } from './generateRateLimitReference.mjs';

const CATALOG = join(
  import.meta.dirname, '..', '..', 'server', 'sources', 'app', 'api', 'utils', 'apiRateLimitCatalog.ts',
);

test('id-to-env-key derivation matches the server implementation', () => {
  // The cases that actually differ between naive and correct implementations:
  // dots become underscores, and camelCase splits.
  assert.equal(toUpperSnakeCase('account.profile'), 'ACCOUNT_PROFILE');
  assert.equal(toUpperSnakeCase('session.messages.byLocalId'), 'SESSION_MESSAGES_BY_LOCAL_ID');
  assert.equal(toUpperSnakeCase('connectedServices.deviceAuth.poll'), 'CONNECTED_SERVICES_DEVICE_AUTH_POLL');
  assert.equal(toUpperSnakeCase('oauthExternal.authParams'), 'OAUTH_EXTERNAL_AUTH_PARAMS');
});

test('the catalog parses to every endpoint with its real defaults', () => {
  const entries = parseRateLimitCatalog(readFileSync(CATALOG, 'utf8'));
  assert.ok(entries.length >= 30, `expected the full catalog, parsed ${entries.length}`);

  const pairing = entries.find((e) => e.id === 'auth.pairing.request');
  assert.deepEqual(
    { max: pairing.defaultMax, window: pairing.defaultWindow, keyMode: pairing.keyMode, env: pairing.maxEnvKey },
    { max: 30, window: '1 minute', keyMode: 'ip', env: 'HAPPIER_AUTH_PAIRING_REQUEST_RATE_LIMIT_MAX' },
  );
});

test('a catalog whose shape changed fails rather than publishing an empty table', () => {
  assert.throws(() => parseRateLimitCatalog('export const SOMETHING_ELSE = {};'), /Could not locate/);
});
