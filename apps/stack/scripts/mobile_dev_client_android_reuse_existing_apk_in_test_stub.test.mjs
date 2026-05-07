import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { createMobileDevClientTestFixture } from './testkit/mobile_dev_client_testkit.mjs';

test('hstack mobile-dev-client --platform=android --reuse installs existing APK without rebuilding (test stub)', async (t) => {
  const fixture = await createMobileDevClientTestFixture(t, {
    importMetaUrl: import.meta.url,
    prefix: 'hstack-mobile-dev-client-reuse-apk-',
    includeRepoDir: true,
    includeHomeDir: true,
    includeStorageDir: true,
  });

  const apkRel = join('dist', 'ui-mobile', 'happier-dev-client-android.apk');
  const apkAbs = join(fixture.repoDir, apkRel);
  await mkdir(join(fixture.repoDir, 'dist', 'ui-mobile'), { recursive: true });
  await writeFile(apkAbs, 'apk-bytes', 'utf-8');

  await fixture.writeAdbDevicesBin();
  await fixture.writeXcrunListBin();

  const env = fixture.buildEnv();
  const res = await fixture.run(['--install', '--platform=android', '--reuse'], { env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  const parsed = JSON.parse(res.stdout.trim() || '{}');
  assert.equal(parsed.platform, 'android');
  assert.equal(parsed.strategy, 'reuse_apk');

  const step0 = parsed.steps?.[0];
  assert.equal(step0?.cmd, 'adb');
  assert.deepEqual(step0?.args?.slice(0, 3), ['install', '-r', apkAbs]);
  const step0ArgsText = Array.isArray(step0?.args) ? step0.args.join(' ') : '';
  assert.ok(step0ArgsText.includes('ABC123') || step0ArgsText.includes('install'), 'expected adb install step to exist');
});

test('hstack mobile-dev-client --profile=publicdev --reuse prefers the profile-scoped cached APK over the shared dist artifact (test stub)', async (t) => {
  const fixture = await createMobileDevClientTestFixture(t, {
    importMetaUrl: import.meta.url,
    prefix: 'hstack-mobile-dev-client-reuse-publicdev-cache-',
    includeRepoDir: true,
    includeHomeDir: true,
    includeStorageDir: true,
  });

  const distApkAbs = join(fixture.repoDir, 'dist', 'ui-mobile', 'happier-dev-client-android.apk');
  await mkdir(dirname(distApkAbs), { recursive: true });
  await writeFile(distApkAbs, 'dist-apk-bytes', 'utf-8');

  const cachedApkAbs = join(fixture.homeDir, 'mobile-dev-client', 'publicdev', 'android', 'happier-dev-client-android.apk');
  await mkdir(dirname(cachedApkAbs), { recursive: true });
  await writeFile(cachedApkAbs, 'cached-publicdev-apk-bytes', 'utf-8');

  await fixture.writeAdbDevicesBin();
  await fixture.writeXcrunListBin();

  const env = fixture.buildEnv();
  const res = await fixture.run(['--install', '--platform=android', '--profile=publicdev', '--reuse'], { env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  const parsed = JSON.parse(res.stdout.trim() || '{}');
  assert.equal(parsed.platform, 'android');
  assert.equal(parsed.strategy, 'reuse_apk');

  const step0 = parsed.steps?.[0];
  assert.equal(step0?.cmd, 'adb');
  assert.deepEqual(step0?.args, ['install', '-r', cachedApkAbs]);
});

test('hstack mobile-dev-client --profile=publicdev --reuse does not treat the shared dist APK as reusable first-use state (test stub)', async (t) => {
  const fixture = await createMobileDevClientTestFixture(t, {
    importMetaUrl: import.meta.url,
    prefix: 'hstack-mobile-dev-client-reuse-publicdev-dist-only-',
    includeRepoDir: true,
    includeHomeDir: true,
    includeStorageDir: true,
  });

  const distApkAbs = join(fixture.repoDir, 'dist', 'ui-mobile', 'happier-dev-client-android.apk');
  await mkdir(dirname(distApkAbs), { recursive: true });
  await writeFile(distApkAbs, 'dist-internaldev-apk-bytes', 'utf-8');

  await fixture.writeAdbDevicesBin();
  await fixture.writeXcrunListBin();

  const env = fixture.buildEnv();
  const res = await fixture.run(['--install', '--platform=android', '--profile=publicdev', '--reuse'], { env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  const parsed = JSON.parse(res.stdout.trim() || '{}');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.platform, 'android');
  assert.equal(parsed.strategy, 'reuse_apk');
  assert.deepEqual(parsed.missing, ['apk']);
  assert.deepEqual(parsed.steps, []);
});
