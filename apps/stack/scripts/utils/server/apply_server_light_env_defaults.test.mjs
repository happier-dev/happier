import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { applyServerLightEnvDefaults } from './apply_server_light_env_defaults.mjs';

test('applyServerLightEnvDefaults defaults server-light to sqlite without a pglite db dir', () => {
  const serverEnv = {};
  applyServerLightEnvDefaults({ baseEnv: {}, serverEnv, baseDir: '/stack/demo' });

  assert.equal(serverEnv.HAPPIER_DB_PROVIDER, 'sqlite');
  assert.equal(serverEnv.HAPPIER_SERVER_LIGHT_DATA_DIR, join('/stack/demo', 'server-light'));
  assert.equal(serverEnv.HAPPIER_SERVER_LIGHT_FILES_DIR, join('/stack/demo', 'server-light', 'files'));
  assert.equal(serverEnv.HAPPIER_SERVER_LIGHT_DB_DIR, undefined);
});

test('applyServerLightEnvDefaults preserves explicit pglite opt-in db dir', () => {
  const serverEnv = {};
  applyServerLightEnvDefaults({
    baseEnv: { HAPPIER_DB_PROVIDER: 'pglite' },
    serverEnv,
    baseDir: '/stack/demo',
  });

  assert.equal(serverEnv.HAPPIER_DB_PROVIDER, 'pglite');
  assert.equal(serverEnv.HAPPIER_SERVER_LIGHT_DB_DIR, join('/stack/demo', 'server-light', 'pglite'));
});

test('applyServerLightEnvDefaults fails closed for explicit empty and unsupported providers', () => {
  for (const provider of ['', '   ', 'unsupported']) {
    assert.throws(
      () => applyServerLightEnvDefaults({
        baseEnv: { HAPPIER_DB_PROVIDER: provider },
        serverEnv: {},
        baseDir: '/stack/demo',
      }),
      /unsupported db provider/i,
      `provider=${JSON.stringify(provider)}`,
    );
  }
});

test('applyServerLightEnvDefaults preserves external DB authority independently of the preset', () => {
  const serverEnv = { DATABASE_URL: 'postgresql://operator/db' };
  applyServerLightEnvDefaults({
    baseEnv: { HAPPIER_DB_PROVIDER: 'postgres', DATABASE_URL: serverEnv.DATABASE_URL },
    serverEnv,
    baseDir: '/stack/demo',
  });
  assert.equal(serverEnv.HAPPIER_DB_PROVIDER, 'postgres');
  assert.equal(serverEnv.DATABASE_URL, 'postgresql://operator/db');
});
