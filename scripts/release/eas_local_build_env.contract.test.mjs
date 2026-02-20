import test from 'node:test';
import assert from 'node:assert/strict';

import { createEasLocalBuildEnv } from '../pipeline/expo/eas-local-build-env.mjs';

test('EAS local builds disable expo doctor step by default', () => {
  const env = createEasLocalBuildEnv({ baseEnv: {}, platform: 'ios' });
  assert.equal(env.EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP, '1');
  assert.equal(env.FASTLANE_XCODEBUILD_SETTINGS_TIMEOUT, '30');
});

test('EAS local builds do not override explicit expo doctor setting', () => {
  const env = createEasLocalBuildEnv({
    baseEnv: { EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP: '0', FASTLANE_XCODEBUILD_SETTINGS_TIMEOUT: '5' },
    platform: 'ios',
  });
  assert.equal(env.EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP, '0');
  assert.equal(env.FASTLANE_XCODEBUILD_SETTINGS_TIMEOUT, '5');
});

test('EAS local builds do not set fastlane xcode settings timeout for android', () => {
  const env = createEasLocalBuildEnv({ baseEnv: {}, platform: 'android' });
  assert.equal(env.EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP, '1');
  assert.ok(!('FASTLANE_XCODEBUILD_SETTINGS_TIMEOUT' in env));
});

test('EAS local iOS builds reorder PATH so /usr/bin precedes /opt/homebrew/bin (rsync compatibility)', () => {
  const baseEnv = {
    PATH: '/Users/leeroy/.nvm/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  };
  const env = createEasLocalBuildEnv({ baseEnv, platform: 'ios' });
  assert.equal(
    env.PATH,
    '/Users/leeroy/.nvm/bin:/usr/bin:/opt/homebrew/bin:/bin:/usr/sbin:/sbin',
  );
});

test('EAS local iOS builds do not reorder PATH when /usr/bin already precedes /opt/homebrew/bin', () => {
  const baseEnv = {
    PATH: '/Users/leeroy/.nvm/bin:/usr/bin:/opt/homebrew/bin:/bin',
  };
  const env = createEasLocalBuildEnv({ baseEnv, platform: 'ios' });
  assert.equal(env.PATH, baseEnv.PATH);
});
