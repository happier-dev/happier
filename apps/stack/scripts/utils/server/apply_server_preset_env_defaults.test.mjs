import assert from 'node:assert/strict';
import test from 'node:test';

import { applyServerPresetEnvDefaults } from './apply_server_preset_env_defaults.mjs';

test('applyServerPresetEnvDefaults expands ~/ local path overrides against HOME', () => {
  const serverEnv = {};

  applyServerPresetEnvDefaults({
    serverComponentName: 'happier-server-light',
    baseEnv: {
      HOME: '/scoped/home',
      HAPPIER_SERVER_LIGHT_DATA_DIR: '~/server-light',
      HAPPIER_SERVER_LIGHT_FILES_DIR: '~/server-light/files-override',
      HAPPIER_SERVER_LIGHT_DB_DIR: '~/server-light/db-override',
    },
    serverEnv,
    baseDir: '/stack/base',
  });

  assert.deepEqual(serverEnv, {
    HAPPIER_DB_PROVIDER: 'sqlite',
    HAPPY_DB_PROVIDER: 'sqlite',
    HAPPIER_SERVER_LIGHT_DATA_DIR: '/scoped/home/server-light',
    HAPPIER_SERVER_LIGHT_FILES_DIR: '/scoped/home/server-light/files-override',
    HAPPIER_SERVER_LIGHT_DB_DIR: '/scoped/home/server-light/db-override',
  });
});

test('applyServerPresetEnvDefaults writes every normalized provider independently of the light preset', () => {
  for (const [input, expected] of [
    [' PGLITE ', 'pglite'],
    [' SQLITE ', 'sqlite'],
    [' POSTGRESQL ', 'postgres'],
    [' MYSQL ', 'mysql'],
  ]) {
    const serverEnv = {};

    applyServerPresetEnvDefaults({
      serverComponentName: 'happier-server-light',
      baseEnv: { HAPPIER_DB_PROVIDER: input },
      serverEnv,
      baseDir: '/stack/base',
    });

    assert.equal(serverEnv.HAPPIER_DB_PROVIDER, expected);
  }
});

test('applyServerPresetEnvDefaults rejects an unsupported explicit DB provider', () => {
  assert.throws(
    () => applyServerPresetEnvDefaults({
      serverComponentName: 'happier-server-light',
      baseEnv: { HAPPIER_DB_PROVIDER: 'unsupported' },
      serverEnv: {},
      baseDir: '/stack/base',
    }),
    /unsupported DB provider/i,
  );
});

test('applyServerPresetEnvDefaults clears provider-incompatible inherited DATABASE_URL', () => {
  const serverEnv = { DATABASE_URL: 'mysql://exported-shell/db' };
  applyServerPresetEnvDefaults({
    serverComponentName: 'happier-server-light',
    baseEnv: { HAPPIER_DB_PROVIDER: 'sqlite', DATABASE_URL: 'mysql://exported-shell/db' },
    serverEnv,
    baseDir: '/stack/base',
  });
  assert.equal(Object.hasOwn(serverEnv, 'DATABASE_URL'), false);
});

test('applyServerPresetEnvDefaults preserves provider-compatible external database authority', () => {
  const postgresUrl = 'postgresql://operator:secret@db.example.test:5432/happier';
  const serverEnv = { DATABASE_URL: postgresUrl };
  applyServerPresetEnvDefaults({
    serverComponentName: 'happier-server-light',
    baseEnv: { HAPPIER_DB_PROVIDER: 'postgres', DATABASE_URL: postgresUrl },
    serverEnv,
    baseDir: '/stack/base',
  });
  assert.equal(serverEnv.DATABASE_URL, postgresUrl);
});

test('applyServerPresetEnvDefaults provisions embedded database paths under the full preset', () => {
  const serverEnv = {};
  applyServerPresetEnvDefaults({
    serverComponentName: 'happier-server',
    baseEnv: { HAPPIER_DB_PROVIDER: 'sqlite' },
    serverEnv,
    baseDir: '/stack/base',
  });
  assert.equal(serverEnv.HAPPIER_SERVER_LIGHT_DATA_DIR, '/stack/base/server-light');
  assert.equal(serverEnv.HAPPIER_SERVER_LIGHT_FILES_DIR, undefined);
});
