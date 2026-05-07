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
  assert.equal(inv.env.EXPO_ANDROID_PACKAGE, 'dev.happier.app.internaldev.devclient');
  assert.equal(inv.env.HAPPIER_STACK_CLEAR_ANDROID_NATIVE_BUILD_STATE, '1');
});

test('buildMobileDevClientInstallInvocation serializes Android Gradle work for native module build stability', () => {
  const inv = buildMobileDevClientInstallInvocation({
    rootDir: '/repo/apps/stack',
    argv: ['--install', '--platform=android'],
    baseEnv: {
      USER: 'leeroy',
      GRADLE_OPTS: '-Xmx1024m -Dorg.gradle.parallel=true -Dorg.gradle.workers.max=8',
    },
  });

  const gradleOpts = String(inv.env.GRADLE_OPTS ?? '');
  assert.match(gradleOpts, /(?:^|\s)-Dorg\.gradle\.daemon=false(?:\s|$)/);
  assert.match(gradleOpts, /(?:^|\s)-Dorg\.gradle\.parallel=false(?:\s|$)/);
  assert.match(gradleOpts, /(?:^|\s)-Dorg\.gradle\.workers\.max=1(?:\s|$)/);
  assert.match(gradleOpts, /(?:^|\s)-Xmx1024m(?:\s|$)/, 'expected unrelated Gradle opts to be preserved');
  assert.doesNotMatch(gradleOpts, /(?:^|\s)-Dorg\.gradle\.parallel=true(?:\s|$)/);
  assert.doesNotMatch(gradleOpts, /(?:^|\s)-Dorg\.gradle\.workers\.max=8(?:\s|$)/);
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
