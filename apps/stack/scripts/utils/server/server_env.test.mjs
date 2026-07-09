import test from 'node:test';
import assert from 'node:assert/strict';

import { buildServerRuntimeEnv } from './server_env.mjs';

test('buildServerRuntimeEnv injects the canonical public server url into both server env variables', () => {
  const env = buildServerRuntimeEnv({
    baseEnv: {
      HAPPIER_STACK_STACK: 'dev-built',
      METRICS_ENABLED: 'true',
    },
    serverPort: 3005,
    publicServerUrl: 'https://relay.example.test',
    serveUi: true,
    uiRequired: false,
    uiBuildDir: '/tmp/ui',
    uiBuildDirExists: true,
  });

  assert.equal(env.PORT, '3005');
  assert.equal(env.HAPPIER_PUBLIC_SERVER_URL, 'https://relay.example.test');
  assert.equal(env.PUBLIC_URL, 'https://relay.example.test');
  assert.equal(env.METRICS_ENABLED, 'true');
  assert.equal(env.HAPPIER_SERVER_UI_REQUIRED, '0');
  assert.equal(env.HAPPIER_SERVER_LOG_LEVEL, 'warn');
});

test('buildServerRuntimeEnv honors explicit server logging env', () => {
  const env = buildServerRuntimeEnv({
    baseEnv: {
      HAPPIER_SERVER_LOG_LEVEL: 'debug',
    },
    serverPort: 3005,
    publicServerUrl: 'https://relay.example.test',
  });

  assert.equal(env.HAPPIER_SERVER_LOG_LEVEL, 'debug');
});

test('buildServerRuntimeEnv supports stack-specific server log override', () => {
  const env = buildServerRuntimeEnv({
    baseEnv: {
      HAPPIER_STACK_SERVER_LOG_LEVEL: 'error',
      LOG_LEVEL: 'trace',
    },
    serverPort: 3005,
    publicServerUrl: 'https://relay.example.test',
  });

  assert.equal(env.LOG_LEVEL, 'trace');
  assert.equal(env.HAPPIER_SERVER_LOG_LEVEL, 'error');
});
