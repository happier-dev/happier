import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getCliHomeDirFromEnvOrDefault,
  getServerLightDataDirFromEnvOrDefault,
} from './dirs.mjs';

test('getCliHomeDirFromEnvOrDefault expands ~/ overrides against HOME', () => {
  assert.equal(
    getCliHomeDirFromEnvOrDefault({
      stackBaseDir: '/stack/base',
      env: {
        HOME: '/scoped/home',
        HAPPIER_STACK_CLI_HOME_DIR: '~/cli-home',
      },
    }),
    '/scoped/home/cli-home',
  );
});

test('getServerLightDataDirFromEnvOrDefault expands ~/ overrides against HOME', () => {
  assert.equal(
    getServerLightDataDirFromEnvOrDefault({
      stackBaseDir: '/stack/base',
      env: {
        HOME: '/scoped/home',
        HAPPIER_SERVER_LIGHT_DATA_DIR: '~/server-light',
      },
    }),
    '/scoped/home/server-light',
  );
});
