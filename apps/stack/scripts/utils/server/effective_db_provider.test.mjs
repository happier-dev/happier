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
  for (const input of ['', '   ', 'postgres', 'unsupported']) {
    const result = resolveEffectiveDbProvider({
      serverComponentName: 'happier-server-light',
      env: { HAPPIER_DB_PROVIDER: input },
    });
    assert.equal(result.ok, false, `input=${JSON.stringify(input)}`);
    assert.equal(result.reason, 'unsupported_db_provider');
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
  assert.throws(
    () => applyEffectiveDbProviderEnv({
      serverComponentName: 'happier-server',
      env: { HAPPIER_DB_PROVIDER: 'sqlite' },
    }),
    /unsupported DB provider/i,
  );
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

test('provider transition defaults only for a previous-valid incompatible provider', () => {
  assert.deepEqual(
    resolveEffectiveDbProviderTransition({
      previousServerComponentName: 'happier-server',
      nextServerComponentName: 'happier-server-light',
      env: { HAPPIER_DB_PROVIDER: 'mysql', DATABASE_URL: 'mysql://old/db' },
    }),
    { ok: true, provider: 'sqlite', databaseUrl: null, removeDatabaseUrl: true },
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

test('provider transition requires MySQL authority and removes only incompatible URLs', () => {
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
    false,
  );
  assert.equal(
    resolveEffectiveDbProviderTransition({
      previousServerComponentName: 'happier-server-light',
      nextServerComponentName: 'happier-server',
      env: { HAPPIER_DB_PROVIDER: 'sqlite', DATABASE_URL: 'mysql://stale/db' },
    }).removeDatabaseUrl,
    true,
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
