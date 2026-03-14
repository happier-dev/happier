import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultDevClientIdentity, defaultStackReleaseIdentity } from '../utils/mobile/identifiers.mjs';
import { resolveStackMobileInstallPlan } from './stack_mobile_install_command.mjs';

test('resolveStackMobileInstallPlan defaults to the production stack release install flow', () => {
  const plan = resolveStackMobileInstallPlan({
    stackName: 'pr272-107',
    passthrough: ['--device=iPhone 13'],
    existing: {},
    user: 'Leeroy',
  });

  const expectedIdentity = defaultStackReleaseIdentity({ stackName: 'pr272-107', user: 'Leeroy' });
  assert.equal(plan.appEnv, 'production');
  assert.deepEqual(plan.identity, expectedIdentity);
  assert.deepEqual(plan.extraEnv, {});
  assert.ok(plan.args.includes('--app-env=production'));
  assert.ok(plan.args.includes('--configuration=Release'));
  assert.ok(plan.args.includes('--device=iPhone 13'));
  assert.deepEqual(plan.envUpdates, [
    { key: 'HAPPIER_STACK_MOBILE_RELEASE_IOS_APP_NAME', value: expectedIdentity.iosAppName },
    { key: 'HAPPIER_STACK_MOBILE_RELEASE_IOS_BUNDLE_ID', value: expectedIdentity.iosBundleId },
    { key: 'HAPPIER_STACK_MOBILE_RELEASE_SCHEME', value: expectedIdentity.scheme },
  ]);
});

test('resolveStackMobileInstallPlan supports a development install with Expo native-debug update flags', () => {
  const plan = resolveStackMobileInstallPlan({
    stackName: 'repo-main',
    passthrough: ['--app-env=development'],
    existing: {},
    user: 'Leeroy',
  });

  const expectedIdentity = defaultDevClientIdentity({ user: 'Leeroy' });
  assert.equal(plan.appEnv, 'development');
  assert.deepEqual(plan.identity, expectedIdentity);
  assert.deepEqual(plan.extraEnv, {
    HAPPIER_EXPO_DEVCLIENT_LAUNCH_MODE: 'most-recent',
    HAPPIER_EXPO_DEVCLIENT_SILENT_LAUNCH: 'true',
    HAPPIER_EXPO_USE_NATIVE_DEBUG: 'true',
    EX_UPDATES_NATIVE_DEBUG: '1',
  });
  assert.ok(plan.args.includes('--app-env=development'));
  assert.ok(plan.args.includes('--configuration=Debug'));
  assert.deepEqual(plan.envUpdates, [
    { key: 'HAPPIER_STACK_MOBILE_DEVELOPMENT_IOS_APP_NAME', value: expectedIdentity.iosAppName },
    { key: 'HAPPIER_STACK_MOBILE_DEVELOPMENT_IOS_BUNDLE_ID', value: expectedIdentity.iosBundleId },
    { key: 'HAPPIER_STACK_MOBILE_DEVELOPMENT_SCHEME', value: expectedIdentity.scheme },
  ]);
});
