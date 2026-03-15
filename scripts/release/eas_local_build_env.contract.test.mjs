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

test('EAS local Android builds prefer IPv4 JVM networking by default (Docker/Dagger reliability)', () => {
  const env = createEasLocalBuildEnv({ baseEnv: {}, platform: 'android' });
  assert.match(env.JAVA_TOOL_OPTIONS, /-Djava\.net\.preferIPv4Stack=true/);
  assert.match(env.JAVA_TOOL_OPTIONS, /-Djava\.net\.preferIPv4Addresses=true/);
});

test('EAS local Android builds do not force IPv4 preference when disabled', () => {
  const env = createEasLocalBuildEnv({
    baseEnv: { HAPPIER_EAS_ANDROID_PREFER_IPV4: '0' },
    platform: 'android',
  });
  assert.ok(!('JAVA_TOOL_OPTIONS' in env));
});

test('EAS local Android builds append IPv4 preferences to existing JAVA_TOOL_OPTIONS', () => {
  const env = createEasLocalBuildEnv({
    baseEnv: { JAVA_TOOL_OPTIONS: '-Xmx2g' },
    platform: 'android',
  });
  assert.match(env.JAVA_TOOL_OPTIONS, /-Xmx2g/);
  assert.match(env.JAVA_TOOL_OPTIONS, /-Djava\.net\.preferIPv4Stack=true/);
  assert.match(env.JAVA_TOOL_OPTIONS, /-Djava\.net\.preferIPv4Addresses=true/);
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

test('EAS local builds disable Sentry auto upload when SENTRY_AUTH_TOKEN is missing (external contributors)', () => {
  const env = createEasLocalBuildEnv({ baseEnv: {}, platform: 'android' });
  assert.equal(env.SENTRY_DISABLE_AUTO_UPLOAD, 'true');
});

test('EAS local builds do not disable Sentry auto upload when SENTRY_AUTH_TOKEN is present', () => {
  const env = createEasLocalBuildEnv({ baseEnv: { SENTRY_AUTH_TOKEN: 'token' }, platform: 'android' });
  assert.ok(!('SENTRY_DISABLE_AUTO_UPLOAD' in env));
});

test('EAS local builds do not override explicit SENTRY_DISABLE_AUTO_UPLOAD setting', () => {
  const env = createEasLocalBuildEnv({
    baseEnv: { SENTRY_DISABLE_AUTO_UPLOAD: 'false' },
    platform: 'android',
  });
  assert.equal(env.SENTRY_DISABLE_AUTO_UPLOAD, 'false');
});
