import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getStackRootFromMeta } from './testkit/auth_testkit.mjs';

function resolveBuildProfile(buildConfig, profileName) {
  const profile = buildConfig?.[profileName];
  assert.ok(profile, `expected eas.json to include build profile: ${profileName}`);

  if (!profile.extends) return profile;
  const parent = resolveBuildProfile(buildConfig, profile.extends);

  return {
    ...parent,
    ...profile,
    android: {
      ...(parent.android ?? {}),
      ...(profile.android ?? {}),
    },
    env: {
      ...(parent.env ?? {}),
      ...(profile.env ?? {}),
    },
  };
}

test('Android dev-client EAS "development" profile builds an APK in debug mode (dev-tools enabled)', async () => {
  const stackRoot = getStackRootFromMeta(import.meta.url);
  const repoRoot = dirname(dirname(stackRoot));
  const easPath = join(repoRoot, 'apps', 'ui', 'eas.json');

  const easJson = JSON.parse(await readFile(easPath, 'utf-8'));
  const resolved = resolveBuildProfile(easJson?.build, 'development');

  const gradleCommand = String(resolved?.android?.gradleCommand ?? '');
  const buildType = resolved?.android?.buildType;

  assert.equal(buildType, 'apk', 'expected development profile to set android.buildType=apk');
  assert.ok(gradleCommand.length > 0, 'expected development profile to have an android.gradleCommand');
  assert.ok(!/bundle/i.test(gradleCommand), `expected android.gradleCommand to avoid "bundle": ${gradleCommand}`);
  assert.ok(/assembledebug/i.test(gradleCommand), `expected android.gradleCommand to use assembleDebug: ${gradleCommand}`);
  assert.ok(!/assemblerelease/i.test(gradleCommand), `expected development profile to avoid release variant: ${gradleCommand}`);
});
