import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveAndroidDevClientInstallStrategy } from './dev_client_android_strategy.mjs';

async function writeStubBin(binDir, name, body = '#!/bin/bash\nexit 0\n') {
  const p = join(binDir, name);
  await writeFile(p, body, 'utf-8');
  if (process.platform !== 'win32') {
    await chmod(p, 0o755);
  }
  return p;
}

test('resolveAndroidDevClientInstallStrategy prefers expo run:android when Android SDK env is present', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-android-strategy-'));
  try {
    const binDir = join(tmp, 'bin');
    await mkdir(binDir, { recursive: true });
    await writeStubBin(binDir, 'adb');
    await writeStubBin(binDir, 'java');

    const env = {
      PATH: `${binDir}:/usr/bin:/bin`,
      ANDROID_HOME: join(tmp, 'android-home'),
    };

    const res = await resolveAndroidDevClientInstallStrategy({ env });
    assert.equal(res.kind, 'expo_run_android');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('resolveAndroidDevClientInstallStrategy falls back to EAS local (Dagger) when SDK is missing but dagger+docker exist', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-android-strategy-'));
  try {
    const binDir = join(tmp, 'bin');
    await mkdir(binDir, { recursive: true });
    await writeStubBin(binDir, 'dagger');
    await writeStubBin(binDir, 'docker');

    const env = {
      PATH: `${binDir}:/usr/bin:/bin`,
    };

    const res = await resolveAndroidDevClientInstallStrategy({ env });
    assert.equal(res.kind, 'eas_local_dagger');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('resolveAndroidDevClientInstallStrategy returns missing prereqs when neither SDK nor pipeline fallback is available', async () => {
  const env = {
    PATH: `/usr/bin:/bin`,
  };
  const res = await resolveAndroidDevClientInstallStrategy({ env });
  assert.equal(res.kind, 'missing_prereqs');
  assert.ok(Array.isArray(res.missing) && res.missing.length > 0, 'expected missing prereqs to be listed');
});
