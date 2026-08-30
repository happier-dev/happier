import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('one-off PGlite snapshot migration delegates to the canonical migration owner', async () => {
  const source = await readFile(new URL('./migrate.mjs', import.meta.url), 'utf-8');
  assert.match(source, /import \{ applyServerMigrations \} from '\.\/utils\/server\/server_migrations\.mjs'/);
  assert.match(source, /await applyServerMigrations\(\{[\s\S]*?dbProvider: 'pglite'/);
  assert.doesNotMatch(source, /bin: 'migrate:light:deploy'/);
});
