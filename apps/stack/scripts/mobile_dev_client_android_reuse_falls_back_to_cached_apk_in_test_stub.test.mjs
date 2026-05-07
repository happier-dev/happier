import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { createMobileDevClientTestFixture } from './testkit/mobile_dev_client_testkit.mjs';

test('hstack mobile-dev-client --platform=android --reuse falls back to cached APK when dist artifact is missing (test stub)', async (t) => {
  const fixture = await createMobileDevClientTestFixture(t, {
    importMetaUrl: import.meta.url,
    prefix: 'hstack-mobile-dev-client-reuse-cache-',
    includeRepoDir: true,
    includeHomeDir: true,
    includeStorageDir: true,
  });

  const cachedApkAbs = join(fixture.homeDir, 'mobile-dev-client', 'internaldev', 'android', 'happier-dev-client-android.apk');
  await mkdir(dirname(cachedApkAbs), { recursive: true });
  await writeFile(cachedApkAbs, 'apk-bytes', 'utf-8');

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
  assert.deepEqual(step0?.args, ['install', '-r', cachedApkAbs]);
});
