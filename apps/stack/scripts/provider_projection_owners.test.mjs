import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLightMigrationBaseEnv, resolveDbProviderForLightFromEnv } from './auth.mjs';
import { probeExistingAccountCountForServerComponent } from './utils/stack/startup.mjs';

test('auth light provider projection rejects cross-flavor input through the canonical owner', () => {
  assert.equal(resolveDbProviderForLightFromEnv({}), 'sqlite');
  assert.equal(resolveDbProviderForLightFromEnv({ HAPPY_DB_PROVIDER: ' PGLITE ' }), 'pglite');
  assert.throws(
    () => resolveDbProviderForLightFromEnv({ HAPPIER_DB_PROVIDER: 'mysql' }),
    /unsupported DB provider/i,
  );
});

test('auth light migration projection removes inherited authority and file URL while retaining the canonical file provider', () => {
  const projected = buildLightMigrationBaseEnv(
    {
      DATABASE_URL: 'mysql://shell/db',
      HAPPIER_DB_PROVIDER: 'mysql',
      HAPPY_DB_PROVIDER: 'mysql',
      PATH: '/test/bin',
    },
    {
      DATABASE_URL: 'postgresql://persisted/db',
      HAPPIER_DB_PROVIDER: 'pglite',
      HAPPY_DB_PROVIDER: 'pglite',
      HAPPIER_SERVER_LIGHT_DATA_DIR: '/stack/light',
    },
  );
  assert.equal(projected.DATABASE_URL, undefined);
  assert.equal(projected.HAPPIER_DB_PROVIDER, 'pglite');
  assert.equal(projected.HAPPY_DB_PROVIDER, undefined);
  assert.equal(projected.HAPPIER_SERVER_LIGHT_DATA_DIR, '/stack/light');
  assert.equal(projected.PATH, '/test/bin');
});

test('startup account projection surfaces canonical provider rejection before probing', async () => {
  const result = await probeExistingAccountCountForServerComponent({
    serverComponentName: 'happier-server-light',
    serverDir: '/unused',
    env: { HAPPIER_DB_PROVIDER: 'postgres' },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /unsupported DB provider/i);
});
