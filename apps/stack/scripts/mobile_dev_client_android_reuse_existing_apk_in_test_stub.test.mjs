import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
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
