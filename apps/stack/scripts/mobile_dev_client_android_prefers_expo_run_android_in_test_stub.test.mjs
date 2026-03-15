import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getStackRootFromMeta, runNodeCapture } from './testkit/auth_testkit.mjs';

test('hstack mobile-dev-client --platform=android prefers expo run:android (test stub) when Android SDK is configured', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const devClientScript = join(rootDir, 'scripts', 'mobile_dev_client.mjs');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-mobile-dev-client-stub-'));
  try {
    const binDir = join(tmp, 'bin');
    await mkdir(binDir, { recursive: true });

    const adbStub = join(binDir, 'adb');
    const javaStub = join(binDir, 'java');
    await writeFile(adbStub, '#!/bin/bash\nexit 0\n', 'utf-8');
    await writeFile(javaStub, '#!/bin/bash\nexit 0\n', 'utf-8');
    if (process.platform !== 'win32') {
      await chmod(adbStub, 0o755);
      await chmod(javaStub, 0o755);
    }

    const env = {
      ...process.env,
      PATH: `${binDir}:/usr/bin:/bin`,
      ANDROID_HOME: join(tmp, 'android-home'),
      HSTACK_MOBILE_DEV_CLIENT_TEST_STUB: '1',
      HAPPIER_STACK_ENV_FILE: join(tmp, 'nonexistent-env'),
    };

    const res = await runNodeCapture([devClientScript, '--install', '--platform=android'], { cwd: rootDir, env });
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

    const parsed = JSON.parse(res.stdout.trim() || '{}');
    assert.equal(parsed.platform, 'android');
    assert.equal(parsed.strategy, 'expo_run_android');
    const step0Args = Array.isArray(parsed.steps?.[0]?.args) ? parsed.steps[0].args.join(' ') : '';
    assert.ok(step0Args.includes('scripts/mobile.mjs'), `expected plan to run hstack mobile\nstdout:\n${res.stdout}`);
    assert.ok(step0Args.includes('--run-android'), `expected plan to include --run-android\nstdout:\n${res.stdout}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
