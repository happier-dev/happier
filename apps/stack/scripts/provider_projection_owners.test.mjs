import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDbProviderFromEnv } from './auth.mjs';
import { probeExistingAccountCountForServerComponent } from './utils/stack/startup.mjs';

test('auth provider projection delegates preset defaults and accepts cross-preset providers', () => {
  assert.equal(resolveDbProviderFromEnv({ serverComponentName: 'happier-server-light', env: {} }), 'sqlite');
  assert.equal(resolveDbProviderFromEnv({ serverComponentName: 'happier-server-light', env: { HAPPY_DB_PROVIDER: ' PGLITE ' } }), 'pglite');
  assert.equal(resolveDbProviderFromEnv({ serverComponentName: 'happier-server-light', env: { HAPPIER_DB_PROVIDER: 'mysql' } }), 'mysql');
});

test('startup account projection admits cross-preset providers before probing', async () => {
  const result = await probeExistingAccountCountForServerComponent({
    serverComponentName: 'happier-server-light',
    serverDir: '/unused',
    env: { HAPPIER_DB_PROVIDER: 'postgres' },
  });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error, /unsupported DB provider/i);
});
