import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMobileDevClientInstallInvocation } from './dev_client_install_invocation.mjs';

test('buildMobileDevClientInstallInvocation forwards --port to mobile.mjs args', async () => {
  const invocation = buildMobileDevClientInstallInvocation({
    rootDir: '/repo/apps/stack',
    argv: ['--install', '--port=14362'],
    baseEnv: { USER: 'leeroy' },
  });

  assert.ok(Array.isArray(invocation.nodeArgs), 'expected nodeArgs array');
  assert.ok(invocation.nodeArgs.includes('--port=14362'), 'expected --port to be forwarded to mobile.mjs');
});

test('buildMobileDevClientInstallInvocation omits --port when not provided', async () => {
  const invocation = buildMobileDevClientInstallInvocation({
    rootDir: '/repo/apps/stack',
    argv: ['--install'],
    baseEnv: { USER: 'leeroy' },
  });

  assert.ok(Array.isArray(invocation.nodeArgs), 'expected nodeArgs array');
  assert.ok(!invocation.nodeArgs.some((a) => String(a).startsWith('--port=')), 'expected no --port arg by default');
});

