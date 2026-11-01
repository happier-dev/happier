import test from 'node:test';
import assert from 'node:assert/strict';

import { buildServerRuntimeEnv } from './server_env.mjs';

test('server projection consumes the canonical decision without reselecting ambient origins', () => {
  const selected = ['https:', '', 'selected.example.test'].join('/');
  const ambient = ['https:', '', 'ambient.example.test'].join('/');
  const env = buildServerRuntimeEnv({
    baseEnv: { HAPPIER_CANONICAL_SERVER_URL: ambient, HAPPIER_PUBLIC_SERVER_URL: ambient },
    serverPort: 43123,
    canonicalServerUrl: selected,
    publicServerUrl: ambient,
  });
  assert.equal(env.HAPPIER_CANONICAL_SERVER_URL === selected, true,
    'the environment adapter must project the URL owner decision, not decide again');
  assert.equal(env.HAPPIER_PUBLIC_SERVER_URL === ambient, true);
});

test('Stack server environments replace inherited Session classification without reclassifying the caller', () => {
  const baseEnv = {
    HAPPIER_STACK_STACK: 'dev-owned-server',
    HAPPIER_STACK_ENV_FILE: '/stack-fixture/env',
    HAPPIER_STACK_PROCESS_KIND: 'session',
  };
  const env = buildServerRuntimeEnv({ baseEnv, serverPort: 3005, publicServerUrl: 'http://localhost:3005' });
  assert.equal(env.HAPPIER_STACK_PROCESS_KIND, 'infra');
  assert.equal(baseEnv.HAPPIER_STACK_PROCESS_KIND, 'session');
  const stackless = buildServerRuntimeEnv({ baseEnv: {}, serverPort: 3005, publicServerUrl: 'http://localhost:3005' });
  assert.equal(stackless.HAPPIER_STACK_PROCESS_KIND, undefined);
});

test('buildServerRuntimeEnv injects separate canonical identity and public ingress URLs', () => {
  const env = buildServerRuntimeEnv({
    baseEnv: {
      HAPPIER_STACK_STACK: 'dev-built',
      METRICS_ENABLED: 'true',
    },
    serverPort: 3005,
    canonicalServerUrl: 'http://localhost:3005',
    publicServerUrl: 'https://relay.example.test',
    serveUi: true,
    uiRequired: false,
    uiBuildDir: '/tmp/ui',
    uiBuildDirExists: true,
  });

  assert.equal(env.PORT, '3005');
  assert.equal(env.HAPPIER_CANONICAL_SERVER_URL, 'http://localhost:3005');
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

test('buildServerRuntimeEnv keeps the explicit stack webapp origin for the server process', () => {
  const env = buildServerRuntimeEnv({
    baseEnv: { HAPPIER_WEBAPP_URL: 'http://happier-qa.localhost:19364' },
    serverPort: 3005,
    publicServerUrl: 'http://happier-qa.localhost:3005',
  });

  assert.equal(env.HAPPIER_WEBAPP_URL, 'http://happier-qa.localhost:19364');
});

test('buildServerRuntimeEnv uses the server origin when this process serves the UI', () => {
  const env = buildServerRuntimeEnv({
    baseEnv: {},
    serverPort: 3005,
    publicServerUrl: 'http://happier-qa.localhost:3005',
    serveUi: true,
  });

  assert.equal(env.HAPPIER_WEBAPP_URL, 'http://happier-qa.localhost:3005');
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
