import test from 'node:test';
import assert from 'node:assert/strict';

import { buildExpoDevEnv } from './expo_dev.mjs';

test('buildExpoDevEnv does not inject auth auto-restore env vars', () => {
  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_CLI_HOME_DIR: '/tmp/fake-cli-home',
    HAPPIER_HOME_DIR: '/tmp/fake-cli-home-legacy',
    HAPPIER_SERVER_URL: 'http://localhost:3010',
  };

  const env = buildExpoDevEnv({
    baseEnv,
    apiServerUrl: 'http://localhost:3010',
    wantDevClient: false,
    wantWeb: true,
    stackMode: true,
    stackName: 'qa-agent-x',
  });

  assert.equal(env.EXPO_PUBLIC_HAPPIER_SERVER_URL, 'http://localhost:3010');
  assert.equal(env.EXPO_PUBLIC_HAPPY_SERVER_URL, 'http://localhost:3010');
  assert.equal(env.EXPO_PUBLIC_SERVER_URL, 'http://localhost:3010');
  assert.equal(env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT, 'stack');
  assert.equal(env.EXPO_NO_BROWSER, '1');
  assert.equal(env.BROWSER, 'none');

  // Security: never pass CLI access keys or derived secrets through EXPO_PUBLIC_*.
  assert.equal(env.EXPO_PUBLIC_HAPPIER_STACK_AUTO_RESTORE_DEV_KEY, undefined);
  assert.equal(env.EXPO_PUBLIC_HAPPIER_STACK_DEV_AUTH_TOKEN, undefined);
  assert.equal(env.EXPO_PUBLIC_HAPPIER_STACK_DEV_AUTH_SECRET_KEY, undefined);
  assert.equal(env.EXPO_PUBLIC_HAPPIER_STACK_DEV_AUTH_ENCRYPTION_PUBLIC_KEY, undefined);
  assert.equal(env.EXPO_PUBLIC_HAPPIER_STACK_DEV_AUTH_ENCRYPTION_MACHINE_KEY, undefined);
});

test('buildExpoDevEnv forces stack context in stack mode even when base env sets a different context', () => {
  const baseEnv = {
    ...process.env,
    EXPO_PUBLIC_HAPPY_SERVER_CONTEXT: 'custom',
  };

  const env = buildExpoDevEnv({
    baseEnv,
    apiServerUrl: 'http://localhost:3013',
    wantDevClient: false,
    wantWeb: true,
    stackMode: true,
    stackName: 'qa-agent-2',
  });

  assert.equal(env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT, 'stack');
});

test('buildExpoDevEnv uses the Tailscale IP for dev-client local API URLs when provided', () => {
  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_LAN_IP: '192.168.0.50',
  };

  const env = buildExpoDevEnv({
    baseEnv,
    apiServerUrl: 'http://localhost:3013',
    wantDevClient: true,
    wantWeb: false,
    stackMode: true,
    stackName: 'qa-agent-2',
    expoTailscaleIp: '100.64.0.10',
  });

  assert.equal(env.EXPO_PUBLIC_HAPPIER_SERVER_URL, 'http://100.64.0.10:3013');
  assert.equal(env.EXPO_PUBLIC_HAPPY_SERVER_URL, 'http://100.64.0.10:3013');
  assert.equal(env.EXPO_PUBLIC_SERVER_URL, 'http://100.64.0.10:3013');
});

test('buildExpoDevEnv does not set EXPO_APP_SLUG in dev-client mode (slug must match EAS project)', () => {
  const baseEnv = {
    ...process.env,
    EXPO_APP_SLUG: undefined,
  };

  const env = buildExpoDevEnv({
    baseEnv,
    apiServerUrl: 'http://localhost:3013',
    wantDevClient: true,
    wantWeb: false,
    stackMode: true,
    stackName: 'qa-agent-2',
  });

  assert.equal(env.EXPO_APP_SLUG, undefined);
});
