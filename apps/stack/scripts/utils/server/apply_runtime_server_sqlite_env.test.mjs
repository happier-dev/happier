import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { applyRuntimeServerSqliteEnv } from './apply_runtime_server_sqlite_env.mjs';

test('applyRuntimeServerSqliteEnv uses the bounded local pool by default', () => {
  const env = {
    HAPPIER_SERVER_LIGHT_DATA_DIR: '/tmp/happier-data',
  };

  applyRuntimeServerSqliteEnv({ env, serverDir: '/tmp/happier-server' });

  assert.equal(
    env.DATABASE_URL,
    'file:///tmp/happier-data/happier-server-light.sqlite?socket_timeout=30&connection_limit=1',
  );
});

test('applyRuntimeServerSqliteEnv applies sqlite URL params from env when generating DATABASE_URL', () => {
  const env = {
    HAPPIER_SERVER_LIGHT_DATA_DIR: '/tmp/happier-data',
    HAPPIER_SQLITE_BUSY_TIMEOUT_MS: '500',
    HAPPIER_SQLITE_CONNECTION_LIMIT: '1',
  };

  applyRuntimeServerSqliteEnv({ env, serverDir: '/tmp/happier-server' });

  assert.equal(
    env.DATABASE_URL,
    'file:///tmp/happier-data/happier-server-light.sqlite?socket_timeout=1&connection_limit=1',
  );
});

test('applyRuntimeServerSqliteEnv preserves explicit DATABASE_URL passthrough', () => {
  const env = {
    HAPPIER_SERVER_LIGHT_DATA_DIR: '/tmp/happier-data',
    HAPPIER_SQLITE_BUSY_TIMEOUT_MS: '500',
    HAPPIER_SQLITE_CONNECTION_LIMIT: '1',
    DATABASE_URL: `file:${join('/custom', 'operator.sqlite')}?socket_timeout=9`,
  };

  applyRuntimeServerSqliteEnv({ env, serverDir: '/tmp/happier-server' });

  assert.equal(env.DATABASE_URL, `file:${join('/custom', 'operator.sqlite')}?socket_timeout=9`);
});
