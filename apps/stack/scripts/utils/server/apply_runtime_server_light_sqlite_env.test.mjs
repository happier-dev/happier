import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

import { applyRuntimeServerLightSqliteEnv } from './apply_runtime_server_light_sqlite_env.mjs';

test('applyRuntimeServerLightSqliteEnv uses the bounded server-light pool by default', () => {
  const env = {
    HAPPIER_SERVER_LIGHT_DATA_DIR: '/tmp/happier-data',
  };

  applyRuntimeServerLightSqliteEnv({ env, serverDir: '/tmp/happier-server' });

  assert.equal(
    env.DATABASE_URL,
    'file:/tmp/happier-data/happier-server-light.sqlite?socket_timeout=30&connection_limit=4',
  );
});

test('applyRuntimeServerLightSqliteEnv applies sqlite URL params from env when generating DATABASE_URL', () => {
  const env = {
    HAPPIER_SERVER_LIGHT_DATA_DIR: '/tmp/happier-data',
    HAPPIER_SQLITE_BUSY_TIMEOUT_MS: '500',
    HAPPIER_SQLITE_CONNECTION_LIMIT: '1',
  };

  applyRuntimeServerLightSqliteEnv({ env, serverDir: '/tmp/happier-server' });

  assert.equal(
    env.DATABASE_URL,
    'file:/tmp/happier-data/happier-server-light.sqlite?socket_timeout=1&connection_limit=1',
  );
});

test('applyRuntimeServerLightSqliteEnv preserves explicit DATABASE_URL passthrough', () => {
  const env = {
    HAPPIER_SERVER_LIGHT_DATA_DIR: '/tmp/happier-data',
    HAPPIER_SQLITE_BUSY_TIMEOUT_MS: '500',
    HAPPIER_SQLITE_CONNECTION_LIMIT: '1',
    DATABASE_URL: `file:${join('/custom', 'operator.sqlite')}?socket_timeout=9`,
  };

  applyRuntimeServerLightSqliteEnv({ env, serverDir: '/tmp/happier-server' });

  assert.equal(env.DATABASE_URL, `file:${join('/custom', 'operator.sqlite')}?socket_timeout=9`);
});

test('shared database preset loads host-owned source settings without replacing QA data state or migrating', async (t) => {
  const fixture = await createTempFixture(t);
  const sourceDir = fixture.path('dev', 'server-light');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(fixture.path('dev', 'env'), `HAPPIER_DB_PROVIDER=sqlite\nHAPPIER_SERVER_LIGHT_DATA_DIR=${sourceDir}\nDATABASE_URL=file:${sourceDir}/custom.sqlite?socket_timeout=17&connection_limit=3\nHAPPIER_SERVER_LIGHT_FILES_DIR=${sourceDir}/public\nHAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR=${sourceDir}/private\n`);
  await writeFile(join(sourceDir, 'handy-master-secret.txt'), 'fixture-only-master-secret');
  await writeFile(join(sourceDir, 'custom.sqlite'), 'fixture database path; not opened by this env test');
  const qaDir = fixture.path('qa', 'server-light');
  const env = { HAPPIER_SERVER_LIGHT_DATA_DIR: qaDir, HAPPIER_SERVER_LIGHT_FILES_DIR: join(qaDir, 'files'),
    HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'dev', HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: fixture.path('dev', 'env'),
    HAPPIER_SQLITE_AUTO_MIGRATE: '1', METRICS_ENABLED: 'true' };
  applyRuntimeServerLightSqliteEnv({ env, serverDir: '/server' });
  assert.equal(env.DATABASE_URL, `file:${sourceDir}/custom.sqlite?socket_timeout=17&connection_limit=3`);
  assert.equal(env.HANDY_MASTER_SECRET, 'fixture-only-master-secret');
  assert.equal(env.HAPPIER_SERVER_LIGHT_FILES_DIR, join(sourceDir, 'public'));
  assert.equal(env.HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR, join(sourceDir, 'private'));
  assert.equal(env.HAPPIER_SERVER_LIGHT_DATA_DIR, qaDir);
  assert.equal(env.HAPPIER_SQLITE_AUTO_MIGRATE, '0');
  assert.equal(env.HAPPIER_STACK_MIGRATE_MODE, 'skip');
  assert.equal(env.METRICS_ENABLED, 'false');
  const broken = { ...env, HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: fixture.path('missing', 'env') };
  assert.throws(() => applyRuntimeServerLightSqliteEnv({ env: broken, serverDir: '/server' }), /shared.*source/i);
});

test('shared database preset fails closed before SQLite can create a missing source database', async (t) => {
  const fixture = await createTempFixture(t);
  const sourceDir = fixture.path('dev', 'server-light');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(fixture.path('dev', 'env'), `HAPPIER_DB_PROVIDER=sqlite\nHAPPIER_SERVER_LIGHT_DATA_DIR=${sourceDir}\nHANDY_MASTER_SECRET=fixture-only-secret\n`);
  const env = { HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'dev', HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: fixture.path('dev', 'env') };
  assert.throws(() => applyRuntimeServerLightSqliteEnv({ env, serverDir: '/server' }), /shared.*existing source database.*unavailable/i);
  assert.equal(env.HANDY_MASTER_SECRET, undefined);
});
