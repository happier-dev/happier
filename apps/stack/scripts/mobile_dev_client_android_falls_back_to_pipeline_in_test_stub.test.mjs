import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { getStackRootFromMeta, runNodeCapture } from './testkit/auth_testkit.mjs';

test('hstack mobile-dev-client --platform=android falls back to pipeline (test stub) when Android SDK is not configured', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const devClientScript = join(rootDir, 'scripts', 'mobile_dev_client.mjs');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-mobile-dev-client-stub-'));
  try {
    const repoDir = join(tmp, 'repo');
    const storageDir = join(tmp, 'storage');
    const binDir = join(tmp, 'bin');
    await mkdir(binDir, { recursive: true });

    const daggerStub = join(binDir, 'dagger');
    const dockerStub = join(binDir, 'docker');
    const adbStub = join(binDir, 'adb');
    await writeFile(daggerStub, '#!/bin/bash\nexit 0\n', 'utf-8');
    await writeFile(dockerStub, '#!/bin/bash\nexit 0\n', 'utf-8');
    await writeFile(adbStub, '#!/bin/bash\nexit 0\n', 'utf-8');
    if (process.platform !== 'win32') {
      await chmod(daggerStub, 0o755);
      await chmod(dockerStub, 0o755);
      await chmod(adbStub, 0o755);
    }

    // Minimal Expo stub so this test remains fast even if the test-stub mode is broken.
    const uiDir = join(repoDir, 'apps', 'ui');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await writeFile(expoBin, `#!${process.execPath}\nprocess.exit(0);\n`, 'utf-8');
    if (process.platform !== 'win32') {
      await chmod(expoBin, 0o755);
    }

    await mkdir(join(storageDir, 'main'), { recursive: true });

    const env = {
      ...process.env,
      // Keep our stubs ahead of any Homebrew-installed binaries that env.mjs might prepend.
      PATH: `${binDir}:${dirname(process.execPath)}:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin`,
      HSTACK_MOBILE_DEV_CLIENT_TEST_STUB: '1',
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: 'main',
      HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL: '0',
      HAPPIER_STACK_TAILSCALE_SERVE: '0',
      // Keep env.mjs from selecting a real stack env file (fast + hermetic).
      HAPPIER_STACK_ENV_FILE: join(tmp, 'nonexistent-env'),
    };

    const res = await runNodeCapture([devClientScript, '--install', '--platform', 'android'], { cwd: rootDir, env });
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

    const parsed = JSON.parse(res.stdout.trim() || '{}');
    assert.equal(parsed.platform, 'android');
    assert.equal(parsed.strategy, 'eas_local_dagger');
    assert.ok(Array.isArray(parsed.steps) && parsed.steps.length > 0, 'expected a non-empty plan');
    const step0 = String(parsed.steps[0]?.args?.join?.(' ') ?? '');
    assert.ok(step0.includes('scripts/pipeline/run.mjs'), `expected first step to run pipeline entrypoint\nstdout:\n${res.stdout}`);
    assert.ok(step0.includes('expo-native-build'), `expected first step to run expo-native-build\nstdout:\n${res.stdout}`);

    assert.ok(parsed.steps.length >= 3, `expected plan to include build + cache copy + adb install steps\nstdout:\n${res.stdout}`);
    const cachedApkAbs = join(tmp, 'home', 'mobile-dev-client', 'android', 'happier-dev-client-android.apk');
    const artifactAbs = join(repoDir, 'dist', 'ui-mobile', 'happier-dev-client-android.apk');
    const step1Args = Array.isArray(parsed.steps?.[1]?.args) ? parsed.steps[1].args : [];
    assert.ok(step1Args.some((a) => String(a).includes('copy_artifact.mjs')), `expected step 1 to invoke copy_artifact.mjs\nstdout:\n${res.stdout}`);
    assert.ok(step1Args.includes('--from') && step1Args.includes(artifactAbs), `expected step 1 to copy from built artifact\nstdout:\n${res.stdout}`);
    assert.ok(step1Args.includes('--to') && step1Args.includes(cachedApkAbs), `expected step 1 to copy to cached APK path\nstdout:\n${res.stdout}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
