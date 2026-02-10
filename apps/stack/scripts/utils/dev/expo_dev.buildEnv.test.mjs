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

  assert.equal(env.EXPO_PUBLIC_HAPPY_SERVER_URL, 'http://localhost:3010');
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

