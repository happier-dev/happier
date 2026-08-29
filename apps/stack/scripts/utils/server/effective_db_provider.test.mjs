import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyEffectiveDbProviderEnv,
  isCanonicalManagedPostgresAuthority,
  resolveEffectiveDbProvider,
  resolveEffectiveDbProviderTransition,
} from './effective_db_provider.mjs';

test('resolveEffectiveDbProvider defaults missing light metadata to sqlite', () => {
  assert.deepEqual(
    resolveEffectiveDbProvider({ serverComponentName: 'happier-server-light', env: {} }),
    { ok: true, provider: 'sqlite', source: 'default' },
  );
});

test('resolveEffectiveDbProvider keeps explicit empty and unsupported values invalid', () => {
  for (const input of ['', '   ', 'unsupported']) {
    const result = resolveEffectiveDbProvider({
      serverComponentName: 'happier-server-light',
      env: { HAPPIER_DB_PROVIDER: input },
    });
    assert.equal(result.ok, false, `input=${JSON.stringify(input)}`);
    assert.equal(result.reason, 'unsupported_db_provider');
  }
});

test('resolveEffectiveDbProvider allows every database independently of the behavior preset', () => {
  for (const serverComponentName of ['happier-server', 'happier-server-light']) {
    for (const provider of ['postgres', 'mysql', 'pglite', 'sqlite']) {
      assert.deepEqual(
        resolveEffectiveDbProvider({ serverComponentName, env: { HAPPIER_DB_PROVIDER: provider } }),
        { ok: true, provider, source: 'HAPPIER_DB_PROVIDER' },
      );
    }
  }
});

test('resolveEffectiveDbProvider applies full defaults, aliases, and primary-key precedence', () => {
  assert.deepEqual(
    resolveEffectiveDbProvider({ serverComponentName: 'happier-server', env: {} }),
    { ok: true, provider: 'postgres', source: 'default' },
  );
  assert.deepEqual(
    resolveEffectiveDbProvider({
      serverComponentName: 'happier-server',
      env: { HAPPY_DB_PROVIDER: ' PostgreSQL ' },
    }),
    { ok: true, provider: 'postgres', source: 'HAPPY_DB_PROVIDER' },
  );
  const primaryEmpty = resolveEffectiveDbProvider({
    serverComponentName: 'happier-server',
    env: { HAPPIER_DB_PROVIDER: '', HAPPY_DB_PROVIDER: 'postgresql' },
  });
  assert.equal(primaryEmpty.ok, false);
  assert.equal(primaryEmpty.source, 'HAPPIER_DB_PROVIDER');
  assert.equal(primaryEmpty.input, '');
});

test('applyEffectiveDbProviderEnv materializes the canonical provider and rejects invalid input', () => {
  const env = { HAPPY_DB_PROVIDER: ' PostgreSQL ' };
  assert.equal(applyEffectiveDbProviderEnv({ serverComponentName: 'happier-server', env }), 'postgres');
  assert.equal(env.HAPPIER_DB_PROVIDER, 'postgres');
  assert.equal(applyEffectiveDbProviderEnv({
    serverComponentName: 'happier-server',
    env: { HAPPIER_DB_PROVIDER: 'sqlite' },
  }), 'sqlite');
});

test('provider transition preserves compatible providers and exact MySQL authority', () => {
  const databaseUrl = 'mysql://operator:secret@db.example.test:3306/happier';
  assert.deepEqual(
    resolveEffectiveDbProviderTransition({
      previousServerComponentName: 'happier-server',
      nextServerComponentName: 'happier-server',
      env: { HAPPIER_DB_PROVIDER: 'mysql', DATABASE_URL: databaseUrl },
    }),
    { ok: true, provider: 'mysql', databaseUrl, removeDatabaseUrl: false },
  );
});

test('provider transition preserves a provider while changing behavior presets', () => {
  assert.deepEqual(
    resolveEffectiveDbProviderTransition({
      previousServerComponentName: 'happier-server',
      nextServerComponentName: 'happier-server-light',
      env: { HAPPIER_DB_PROVIDER: 'mysql', DATABASE_URL: 'mysql://old/db' },
    }),
    { ok: true, provider: 'mysql', databaseUrl: 'mysql://old/db', removeDatabaseUrl: false },
  );
  for (const provider of ['', 'unknown']) {
    const result = resolveEffectiveDbProviderTransition({
      previousServerComponentName: 'happier-server-light',
      nextServerComponentName: 'happier-server',
      env: { HAPPIER_DB_PROVIDER: provider },
    });
    assert.equal(result.ok, false, `provider=${JSON.stringify(provider)}`);
    assert.equal(result.reason, 'unsupported_db_provider');
  }
});

test('provider transition validates explicit external authority and removes incompatible URLs', () => {
  assert.deepEqual(
    resolveEffectiveDbProviderTransition({
      previousServerComponentName: 'happier-server',
      nextServerComponentName: 'happier-server',
      env: { HAPPIER_DB_PROVIDER: 'mysql' },
    }),
    { ok: false, reason: 'missing_mysql_database_url', provider: 'mysql' },
  );
  assert.equal(
    resolveEffectiveDbProviderTransition({
      previousServerComponentName: 'happier-server-light',
      nextServerComponentName: 'happier-server',
      env: { HAPPIER_DB_PROVIDER: 'sqlite', DATABASE_URL: 'postgresql://operator/db' },
    }).removeDatabaseUrl,
    true,
  );
  assert.equal(
    resolveEffectiveDbProviderTransition({
      previousServerComponentName: 'happier-server-light',
      nextServerComponentName: 'happier-server',
      env: { HAPPIER_DB_PROVIDER: 'sqlite', DATABASE_URL: 'mysql://stale/db' },
    }).removeDatabaseUrl,
    true,
  );
  assert.deepEqual(
    resolveEffectiveDbProviderTransition({
      previousServerComponentName: 'happier-server',
      nextServerComponentName: 'happier-server-light',
      env: { HAPPIER_DB_PROVIDER: 'postgres' },
    }),
    { ok: false, reason: 'missing_postgres_database_url', provider: 'postgres' },
  );
  const postgresUrl = 'postgresql://operator/db';
  assert.deepEqual(
    resolveEffectiveDbProviderTransition({
      previousServerComponentName: 'happier-server',
      nextServerComponentName: 'happier-server-light',
      env: { HAPPIER_DB_PROVIDER: 'postgres', DATABASE_URL: postgresUrl },
    }),
    { ok: true, provider: 'postgres', databaseUrl: postgresUrl, removeDatabaseUrl: false },
  );
});

test('managed Postgres authority requires the exact canonical local credential and port shape', () => {
  const env = {
    HAPPIER_STACK_PG_PORT: '5439',
    HAPPIER_STACK_PG_USER: 'handy',
    HAPPIER_STACK_PG_PASSWORD: 'secret',
    HAPPIER_STACK_PG_DATABASE: 'handy',
  };
  assert.equal(isCanonicalManagedPostgresAuthority({
    databaseUrl: 'postgresql://handy:secret@127.0.0.1:5439/handy',
    env,
  }), true);
  assert.equal(isCanonicalManagedPostgresAuthority({
    databaseUrl: 'postgresql://operator:secret@db.example/happier',
    env,
  }), false);
});
