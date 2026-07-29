import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { applyRuntimeServerLightSqliteEnv } from './apply_runtime_server_light_sqlite_env.mjs';

test('applyRuntimeServerLightSqliteEnv uses the bounded server-light pool by default', () => {
  const env = {
    HAPPIER_SERVER_LIGHT_DATA_DIR: '/tmp/happier-data',
  };

  applyRuntimeServerLightSqliteEnv({ env, serverDir: '/tmp/happier-server' });

  assert.equal(
    env.DATABASE_URL,
    'file:///tmp/happier-data/happier-server-light.sqlite?socket_timeout=30&connection_limit=4',
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
    'file:///tmp/happier-data/happier-server-light.sqlite?socket_timeout=1&connection_limit=1',
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
