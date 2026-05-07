import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createMobileDevClientTestFixture } from './testkit/mobile_dev_client_testkit.mjs';

test('hstack mobile-dev-client --platform=android falls back to pipeline (test stub) when Android SDK is not configured', async (t) => {
  const fixture = await createMobileDevClientTestFixture(t, {
    importMetaUrl: import.meta.url,
    prefix: 'hstack-mobile-dev-client-stub-',
    includeRepoDir: true,
    includeHomeDir: true,
    includeStorageDir: true,
  });
  await fixture.writeNoopBin('dagger');
  await fixture.writeNoopBin('docker');
  await fixture.writeNoopBin('adb');
  await fixture.writeExpoStub();

  const env = fixture.buildEnv();
  const res = await fixture.run(['--install', '--platform', 'android'], { env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  const parsed = JSON.parse(res.stdout.trim() || '{}');
  assert.equal(parsed.platform, 'android');
  assert.equal(parsed.strategy, 'eas_local_dagger');
  assert.ok(Array.isArray(parsed.steps) && parsed.steps.length > 0, 'expected a non-empty plan');
  const step0 = String(parsed.steps[0]?.args?.join?.(' ') ?? '');
  assert.ok(step0.includes('scripts/pipeline/run.mjs'), `expected first step to run pipeline entrypoint\nstdout:\n${res.stdout}`);
  assert.ok(step0.includes('expo-native-build'), `expected first step to run expo-native-build\nstdout:\n${res.stdout}`);
  assert.ok(step0.includes('--profile internaldev-dev-client'), `expected internal dev-client EAS profile\nstdout:\n${res.stdout}`);

  assert.ok(parsed.steps.length >= 3, `expected plan to include build + cache copy + adb install steps\nstdout:\n${res.stdout}`);
  const cachedApkAbs = join(fixture.homeDir, 'mobile-dev-client', 'internaldev', 'android', 'happier-dev-client-android.apk');
  const artifactAbs = join(fixture.repoDir, 'dist', 'ui-mobile', 'happier-dev-client-android.apk');
  const step1Args = Array.isArray(parsed.steps?.[1]?.args) ? parsed.steps[1].args : [];
  assert.ok(step1Args.some((a) => String(a).includes('copy_artifact.mjs')), `expected step 1 to invoke copy_artifact.mjs\nstdout:\n${res.stdout}`);
  assert.ok(step1Args.includes('--from') && step1Args.includes(artifactAbs), `expected step 1 to copy from built artifact\nstdout:\n${res.stdout}`);
  assert.ok(step1Args.includes('--to') && step1Args.includes(cachedApkAbs), `expected step 1 to copy to cached APK path\nstdout:\n${res.stdout}`);
});

test('hstack mobile-dev-client --profile=publicdev uses the public dev-client EAS profile for Android fallback', async (t) => {
  const fixture = await createMobileDevClientTestFixture(t, {
    importMetaUrl: import.meta.url,
    prefix: 'hstack-mobile-dev-client-publicdev-stub-',
    includeRepoDir: true,
    includeHomeDir: true,
    includeStorageDir: true,
  });
  await fixture.writeNoopBin('dagger');
  await fixture.writeNoopBin('docker');
  await fixture.writeNoopBin('adb');
  await fixture.writeExpoStub();

  const env = fixture.buildEnv();
  const res = await fixture.run(['--install', '--platform=android', '--profile=publicdev'], { env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  const parsed = JSON.parse(res.stdout.trim() || '{}');
  assert.equal(parsed.platform, 'android');
  assert.equal(parsed.strategy, 'eas_local_dagger');
  const step0 = String(parsed.steps?.[0]?.args?.join?.(' ') ?? '');
  assert.ok(step0.includes('expo-native-build'), `expected first step to run expo-native-build\nstdout:\n${res.stdout}`);
  assert.ok(step0.includes('--profile publicdev-dev-client'), `expected public dev-client EAS profile\nstdout:\n${res.stdout}`);
  const cachedApkAbs = join(fixture.homeDir, 'mobile-dev-client', 'publicdev', 'android', 'happier-dev-client-android.apk');
  const step1Args = Array.isArray(parsed.steps?.[1]?.args) ? parsed.steps[1].args : [];
  assert.ok(step1Args.includes('--to') && step1Args.includes(cachedApkAbs), `expected publicdev cached APK path\nstdout:\n${res.stdout}`);
});
