// @happier-test-preparation source
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

import { applyRuntimeServerDatabaseEnv } from './apply_runtime_server_database_env.mjs';
import { resolveServerMigrationsEnabled } from '@happier-dev/cli-common/firstPartyRuntime/selfHostServerEnv';
import { resolveServerRuntimeLaunchSpec } from '../../runtime/launch/resolveServerRuntimeLaunchSpec.mjs';
import { spawnRuntimeServerAfterMigration } from '../../runtime/launch/runServerRuntimeMigration.mjs';

test('applyRuntimeServerDatabaseEnv uses the single-connection server-light pool by default', () => {
  const env = {
    HAPPIER_SERVER_LIGHT_DATA_DIR: '/tmp/happier-data',
  };

  applyRuntimeServerDatabaseEnv({ env, serverDir: '/tmp/happier-server' });

  assert.equal(
    env.DATABASE_URL,
    'file:/tmp/happier-data/happier-server-light.sqlite?socket_timeout=30&connection_limit=1',
  );
});

test('applyRuntimeServerDatabaseEnv applies sqlite URL params from env when generating DATABASE_URL', () => {
  const env = {
    HAPPIER_SERVER_LIGHT_DATA_DIR: '/tmp/happier-data',
    HAPPIER_SQLITE_BUSY_TIMEOUT_MS: '500',
    HAPPIER_SQLITE_CONNECTION_LIMIT: '1',
  };

  applyRuntimeServerDatabaseEnv({ env, serverDir: '/tmp/happier-server' });

  assert.equal(
    env.DATABASE_URL,
    'file:/tmp/happier-data/happier-server-light.sqlite?socket_timeout=1&connection_limit=1',
  );
});

test('applyRuntimeServerDatabaseEnv preserves explicit DATABASE_URL passthrough', () => {
  const env = {
    HAPPIER_SERVER_LIGHT_DATA_DIR: '/tmp/happier-data',
    HAPPIER_SQLITE_BUSY_TIMEOUT_MS: '500',
    HAPPIER_SQLITE_CONNECTION_LIMIT: '1',
    DATABASE_URL: `file:${join('/custom', 'operator.sqlite')}?socket_timeout=9`,
  };

  applyRuntimeServerDatabaseEnv({ env, serverDir: '/tmp/happier-server' });

  assert.equal(env.DATABASE_URL, `file:${join('/custom', 'operator.sqlite')}?socket_timeout=9`);
});

test('shared database preset loads host-owned source settings without replacing QA data state or migrating', async (t) => {
  const fixture = await createTempFixture(t);
  const sourceDir = fixture.path('dev', 'server-light');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(fixture.path('dev', 'env'), `HAPPIER_DB_PROVIDER=sqlite\nHAPPIER_SERVER_LIGHT_DATA_DIR=${sourceDir}\nDATABASE_URL=file:${sourceDir}/custom.sqlite?socket_timeout=17&connection_limit=3\nHAPPIER_SERVER_LIGHT_FILES_DIR=${sourceDir}/public\nHAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR=${sourceDir}/private\n`);
  await writeFile(join(sourceDir, 'handy-master-secret.txt'), 'fixture-only-master-secret');
  const sourceDb = new DatabaseSync(join(sourceDir, 'custom.sqlite'));
  sourceDb.exec("CREATE TABLE _prisma_migrations (migration_name TEXT, checksum TEXT, finished_at TEXT, rolled_back_at TEXT);"
    + "INSERT INTO _prisma_migrations VALUES ('20260101000000_fixture', '', 'done', NULL)");
  sourceDb.close();
  const serverDir = fixture.path('consumer-server');
  const migrationDir = join(serverDir, 'prisma/sqlite/migrations/20260101000000_fixture');
  await mkdir(migrationDir, { recursive: true });
  await writeFile(join(migrationDir, 'migration.sql'), 'SELECT 1;\n');
  const qaDir = fixture.path('qa', 'server-light');
  const env = { HAPPIER_SERVER_LIGHT_DATA_DIR: qaDir, HAPPIER_SERVER_LIGHT_FILES_DIR: join(qaDir, 'files'),
    HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'dev', HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: fixture.path('dev', 'env'),
    HAPPIER_SQLITE_AUTO_MIGRATE: '1', METRICS_ENABLED: 'true' };
  applyRuntimeServerDatabaseEnv({ env, serverDir: '/server' });
  assert.equal(env.DATABASE_URL, `file:${sourceDir}/custom.sqlite?socket_timeout=17&connection_limit=3`);
  assert.equal(env.HANDY_MASTER_SECRET, 'fixture-only-master-secret');
  assert.equal(env.HAPPIER_SERVER_LIGHT_FILES_DIR, join(sourceDir, 'public'));
  assert.equal(env.HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR, join(sourceDir, 'private'));
  assert.equal(env.HAPPIER_SERVER_LIGHT_DATA_DIR, qaDir);
  assert.equal(env.HAPPIER_SQLITE_AUTO_MIGRATE, '0');
  assert.equal(env.HAPPIER_STACK_MIGRATE_MODE, 'skip');
  assert.equal(env.METRICS_ENABLED, 'false');
  assert.equal(resolveServerMigrationsEnabled(env), false);
  for (const migration of [{ mode: 'in-process' }, { mode: 'external', command: '/server/scripts/migrate.mjs', cwd: '/server' }]) {
    const serverLaunchSpec = resolveServerRuntimeLaunchSpec({
      sourceRuntimeLaunch: { entrypoint: join(serverDir, 'main.mjs'), serverDir, migration },
      migrationsEnabled: resolveServerMigrationsEnabled(env),
    });
    const server = { pid: 123 };
    // Process creation is the system boundary; admission and migration execution stay real.
    assert.equal(await spawnRuntimeServerAfterMigration({ serverLaunchSpec, env, children: [],
      spawnProcImpl: label => { assert.equal(label, 'server'); return server; },
    }), server);
  }
  const broken = { ...env, HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: fixture.path('missing', 'env') };
  assert.throws(() => applyRuntimeServerDatabaseEnv({ env: broken, serverDir: '/server' }), /shared.*source/i);
});

test('shared database preset fails closed before SQLite can create a missing source database', async (t) => {
  const fixture = await createTempFixture(t);
  const sourceDir = fixture.path('dev', 'server-light');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(fixture.path('dev', 'env'), `HAPPIER_DB_PROVIDER=sqlite\nHAPPIER_SERVER_LIGHT_DATA_DIR=${sourceDir}\nHANDY_MASTER_SECRET=fixture-only-secret\n`);
  const env = { HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'dev', HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: fixture.path('dev', 'env') };
  assert.throws(() => applyRuntimeServerDatabaseEnv({ env, serverDir: '/server' }), /shared.*existing source database.*unavailable/i);
  assert.equal(env.HANDY_MASTER_SECRET, undefined);
});

test('shared source provider switches at runtime while files, secret and QA state retain their owners', async (t) => {
  const fixture = await createTempFixture(t);
  const sourceDir = fixture.path('dev', 'server-light');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, 'handy-master-secret.txt'), 'fixture-only-secret');
  const sourceEnvPath = fixture.path('dev', 'env');
  const databaseUrl = 'postgresql://fixture:fixture-password@private-host/dev';
  await writeFile(sourceEnvPath, `HAPPIER_DB_PROVIDER=postgresql\nDATABASE_URL=${databaseUrl}\nDIRECT_URL=direct-connection\nHAPPIER_SERVER_LIGHT_DATA_DIR=${sourceDir}\n`);
  const qaDir = fixture.path('qa', 'server-light');
  const env = { HAPPIER_DB_PROVIDER: 'sqlite', DATABASE_URL: 'file:/stale/qa.sqlite',
    HAPPIER_SERVER_LIGHT_DATA_DIR: qaDir, HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'dev',
    HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: sourceEnvPath,
    RUN_MIGRATIONS: 'true', HAPPIER_STACK_PRISMA_MIGRATE: '1' };
  applyRuntimeServerDatabaseEnv({ env, serverDir: '/server' });
  assert.equal(env.HAPPIER_DB_PROVIDER, 'postgres');
  assert.equal(env.DATABASE_URL, databaseUrl);
  assert.equal(env.DIRECT_URL, undefined);
  assert.equal(env.HAPPIER_SERVER_LIGHT_DATA_DIR, qaDir);
  assert.equal(env.HAPPIER_SERVER_LIGHT_FILES_DIR, join(sourceDir, 'files'));
  assert.equal(env.HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR, join(sourceDir, 'private-files'));
  assert.equal(env.HANDY_MASTER_SECRET, 'fixture-only-secret');
  assert.equal(env.HAPPIER_STACK_MIGRATE_MODE, 'skip');
  assert.equal(resolveServerMigrationsEnabled(env), false);
  assert.equal(env.HAPPIER_SQLITE_MIGRATIONS_DIR, undefined);

  await writeFile(join(sourceDir, 'happier-server-light.sqlite'), 'fixture rollback file');
  await writeFile(sourceEnvPath, `HAPPIER_DB_PROVIDER=sqlite\nHAPPIER_SERVER_LIGHT_DATA_DIR=${sourceDir}\n`);
  applyRuntimeServerDatabaseEnv({ env, serverDir: '/server' });
  assert.equal(env.HAPPIER_DB_PROVIDER, 'sqlite');
  assert.equal(resolveServerMigrationsEnabled(env), false);
  assert.ok(env.DATABASE_URL.startsWith(`file:${sourceDir}/happier-server-light.sqlite?`));
  assert.equal(env.HANDY_MASTER_SECRET, 'fixture-only-secret');
});

test('shared source refuses provider/URL disagreement without exposing credentials or mutating env', async (t) => {
  const fixture = await createTempFixture(t);
  await mkdir(fixture.path('dev'), { recursive: true });
  for (const [provider, url] of [['postgres', 'file:/retained.sqlite'], ['sqlite', 'postgresql://fixture:private-password@host/dev'], ['postgres', ''], ['mysql', 'mysql://host/dev']]) {
    await writeFile(fixture.path('dev', 'env'), `HAPPIER_DB_PROVIDER=${provider}\nDATABASE_URL=${url}\nHANDY_MASTER_SECRET=fixture-only-secret\n`);
    const env = { HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'dev', HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: fixture.path('dev', 'env') };
    const before = { ...env };
    assert.throws(() => applyRuntimeServerDatabaseEnv({ env, serverDir: '/server' }), error => {
      assert.match(error.message, /shared-db/);
      assert.doesNotMatch(error.message, /private-password|fixture-only-secret/);
      return true;
    });
    assert.deepEqual(env, before);
  }
});

test('shared Postgres projects S3 and the at-rest secret without requiring source-host files', async (t) => {
  const fixture = await createTempFixture(t);
  await mkdir(fixture.path('dev'), { recursive: true });
  const source = {
    HAPPIER_DB_PROVIDER: 'postgres', DATABASE_URL: 'postgresql://fixture:fixture@host/dev',
    HANDY_MASTER_SECRET: 'fixture-only-secret', HAPPIER_SERVER_LIGHT_DATA_DIR: '/unavailable/source-host/data',
    HAPPIER_FILES_BACKEND: 's3', S3_HOST: 'blob.tailnet.test', S3_PORT: '9000', S3_USE_SSL: 'false',
    S3_BUCKET: 'public', S3_PRIVATE_BUCKET: 'private', S3_PUBLIC_URL: 'https://blob.tailnet.test:9443/public',
    S3_REGION: 'us-east-1', S3_ACCESS_KEY: 'fixture-access', S3_SECRET_KEY: 'fixture-secret',
  };
  await writeFile(fixture.path('dev', 'env'), Object.entries(source).map(([key, value]) => `${key}=${value}`).join('\n'));
  const env = {
    HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'dev', HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: fixture.path('dev', 'env'),
    HAPPIER_SERVER_LIGHT_DATA_DIR: fixture.path('qa'), HAPPIER_SERVER_LIGHT_FILES_DIR: '/stale/files',
    HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR: '/stale/private-files', S3_HOST: 'stale-host', HAPPIER_FILES_BACKEND: 'local',
  };
  applyRuntimeServerDatabaseEnv({ env, serverDir: '/server' });
  assert.equal(env.DATABASE_URL, source.DATABASE_URL);
  assert.equal(env.HANDY_MASTER_SECRET, source.HANDY_MASTER_SECRET);
  assert.equal(env.HAPPIER_FILES_BACKEND, 's3');
  for (const [key, value] of Object.entries(source).filter(([key]) => key.startsWith('S3_'))) assert.equal(env[key], value);
  assert.equal(env.HAPPIER_SERVER_LIGHT_FILES_DIR, undefined);
  assert.equal(env.HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR, undefined);
  assert.equal(env.HAPPIER_SERVER_LIGHT_DATA_DIR, fixture.path('qa'));
  assert.equal(env.HAPPIER_STACK_MIGRATE_MODE, 'skip');

  // A deliberate rollback to local storage must not retain the prior S3 owner.
  const localSource = Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith('S3_')));
  localSource.HAPPIER_FILES_BACKEND = 'local';
  localSource.S3_HOST = 'stale-source-host';
  await writeFile(fixture.path('dev', 'env'), Object.entries(localSource).map(([key, value]) => `${key}=${value}`).join('\n'));
  applyRuntimeServerDatabaseEnv({ env, serverDir: '/server' });
  assert.equal(env.S3_HOST, undefined);
  assert.equal(env.S3_SECRET_KEY, undefined);
  assert.equal(env.HAPPIER_FILES_BACKEND, 'local');
  assert.equal(env.HAPPIER_SERVER_LIGHT_FILES_DIR, '/unavailable/source-host/data/files');
});

test('shared database consumers follow source socket clustering and clear stale adapter settings', async (t) => {
  const fixture = await createTempFixture(t);
  await mkdir(fixture.path('dev'), { recursive: true });
  const sourceEnvPath = fixture.path('dev', 'env');
  const source = { HAPPIER_DB_PROVIDER: 'postgres', DATABASE_URL: 'postgresql://db.test/shared',
    HANDY_MASTER_SECRET: randomUUID() };
  const redisUrl = new URL('redis://source.test:6379');
  redisUrl.password = randomUUID();
  for (const [name, socketEnv, enabled] of [
    ['Redis Streams source replaces consumer cluster', { HAPPIER_SOCKET_ADAPTER: 'redis-streams', REDIS_URL: redisUrl.href }, true],
    ['source adapter aliases use canonical configuration parsing', { HAPPY_SOCKET_ADAPTER: ' REDIS_STREAMS ', REDIS_URL: ` ${redisUrl.href} ` }, true],
    ['memory source clears consumer cluster even with a leftover source URL', { HAPPIER_SOCKET_ADAPTER: 'memory', REDIS_URL: redisUrl.href }, false],
    ['source without a Redis URL clears consumer cluster', { HAPPIER_SOCKET_ADAPTER: 'redis-streams' }, false],
    ['unconfigured source clears consumer cluster', {}, false],
  ]) {
    await t.test(name, async () => {
      await writeFile(sourceEnvPath, Object.entries({ ...source, ...socketEnv }).map(([key, value]) => `${key}=${value}`).join('\n'));
      const env = { HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'dev', HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: sourceEnvPath,
        HAPPIER_SOCKET_ADAPTER: 'redis-streams', REDIS_URL: 'redis://stale-consumer.test:6379' };
      applyRuntimeServerDatabaseEnv({ env, serverDir: '/server' });
      assert.equal(env.HAPPIER_SOCKET_ADAPTER, enabled ? 'redis-streams' : undefined);
      // Assert equality without putting connection credentials in failure diagnostics.
      assert.equal(env.REDIS_URL === (enabled ? redisUrl.href : undefined), true);
    });
  }
});

test('operator-provided Postgres URL is validated without SQLite defaults', () => {
  const env = { HAPPIER_DB_PROVIDER: 'postgres', DATABASE_URL: 'postgresql://host/dev', HAPPIER_SERVER_LIGHT_DATA_DIR: '/retained' };
  applyRuntimeServerDatabaseEnv({ env, serverDir: '/server' });
  assert.equal(env.DATABASE_URL, 'postgresql://host/dev');
  assert.equal(env.HAPPIER_SQLITE_AUTO_MIGRATE, undefined);
  assert.equal(env.HAPPIER_SQLITE_MIGRATIONS_DIR, undefined);
  assert.equal(resolveServerMigrationsEnabled(env), true);
  assert.throws(() => applyRuntimeServerDatabaseEnv({ env: { ...env, DATABASE_URL: 'file:/retained.sqlite' }, serverDir: '/server' }), /postgres.*DATABASE_URL/i);
});
