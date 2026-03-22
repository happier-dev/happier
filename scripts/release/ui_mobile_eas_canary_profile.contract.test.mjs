import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('apps/ui/eas.json defines canary profiles for release-like private OTA testing', () => {
  const easPath = path.join(repoRoot, 'apps', 'ui', 'eas.json');
  const raw = fs.readFileSync(easPath, 'utf8');
  const eas = JSON.parse(raw);

  const build = eas?.build ?? null;
  assert.equal(typeof build, 'object');

  const canary = build?.canary ?? null;
  assert.equal(typeof canary, 'object');
  assert.equal(canary.extends, 'base');
  assert.equal(canary.environment, 'preview');
  assert.equal(canary.distribution, 'internal');
  assert.equal(canary.channel, 'canary');
  assert.equal(canary?.env?.APP_ENV, 'preview');
  assert.equal(canary?.env?.EXPO_UPDATES_CHANNEL, 'canary');
  assert.equal(canary?.env?.EXPO_APP_NAME, 'Happier (canary)');
  assert.equal(canary?.env?.EXPO_APP_BUNDLE_ID, 'dev.happier.app.canary');
  assert.equal(canary?.env?.EXPO_APP_SCHEME, 'happier-canary');

  const canaryApk = build?.['canary-apk'] ?? null;
  assert.equal(typeof canaryApk, 'object');
  assert.equal(canaryApk.extends, 'base');
  assert.equal(canaryApk.environment, 'preview');
  assert.equal(canaryApk.distribution, 'internal');
  assert.equal(canaryApk.channel, 'canary');
  assert.equal(canaryApk?.android?.buildType, 'apk');
  assert.equal(canaryApk?.env?.APP_ENV, 'preview');
  assert.equal(canaryApk?.env?.EXPO_UPDATES_CHANNEL, 'canary');
  assert.equal(canaryApk?.env?.EXPO_APP_NAME, 'Happier (canary)');
  assert.equal(canaryApk?.env?.EXPO_APP_BUNDLE_ID, 'dev.happier.app.canary');
  assert.equal(canaryApk?.env?.EXPO_APP_SCHEME, 'happier-canary');
});
