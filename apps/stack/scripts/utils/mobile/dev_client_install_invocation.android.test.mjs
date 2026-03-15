import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMobileDevClientInstallInvocation } from './dev_client_install_invocation.mjs';

test('buildMobileDevClientInstallInvocation builds an Android run invocation when --platform=android is set', () => {
  const inv = buildMobileDevClientInstallInvocation({
    rootDir: '/repo/apps/stack',
    argv: ['--install', '--platform=android', '--port=14362', '--device=ABC123'],
    baseEnv: { USER: 'leeroy' },
  });

  assert.ok(inv.nodeArgs.includes('--prebuild'), 'expected invocation to include --prebuild');
  assert.ok(inv.nodeArgs.includes('--run-android'), 'expected invocation to include --run-android');
  assert.ok(!inv.nodeArgs.includes('--run-ios'), 'expected invocation to not include --run-ios');

  const platformIdx = inv.nodeArgs.indexOf('--platform=android');
  assert.ok(platformIdx >= 0, `expected prebuild to be android-scoped\nnodeArgs:\n${inv.nodeArgs.join(' ')}`);

  assert.ok(inv.nodeArgs.includes('--port=14362'), `expected --port to be forwarded\nnodeArgs:\n${inv.nodeArgs.join(' ')}`);
  assert.ok(inv.nodeArgs.includes('--device=ABC123'), `expected --device to be forwarded\nnodeArgs:\n${inv.nodeArgs.join(' ')}`);
});

test('buildMobileDevClientInstallInvocation accepts space-separated --platform android', () => {
  const inv = buildMobileDevClientInstallInvocation({
    rootDir: '/repo/apps/stack',
    argv: ['--install', '--platform', 'android', '--port', '14362', '--device', 'ABC123'],
    baseEnv: { USER: 'leeroy' },
  });

  assert.ok(inv.nodeArgs.includes('--prebuild'), 'expected invocation to include --prebuild');
  assert.ok(inv.nodeArgs.includes('--run-android'), 'expected invocation to include --run-android');
  assert.ok(!inv.nodeArgs.includes('--run-ios'), 'expected invocation to not include --run-ios');
  assert.ok(inv.nodeArgs.includes('--platform=android'), `expected prebuild to be android-scoped\nnodeArgs:\n${inv.nodeArgs.join(' ')}`);
  assert.ok(inv.nodeArgs.includes('--port=14362'), `expected --port to be forwarded\nnodeArgs:\n${inv.nodeArgs.join(' ')}`);
  assert.ok(inv.nodeArgs.includes('--device=ABC123'), `expected --device to be forwarded\nnodeArgs:\n${inv.nodeArgs.join(' ')}`);
});
