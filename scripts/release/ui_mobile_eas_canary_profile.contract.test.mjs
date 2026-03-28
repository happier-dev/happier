import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('apps/ui/eas.json defines internalpreview profiles for release-like private OTA testing', () => {
  const easPath = path.join(repoRoot, 'apps', 'ui', 'eas.json');
  const raw = fs.readFileSync(easPath, 'utf8');
  const eas = JSON.parse(raw);

  const build = eas?.build ?? null;
  assert.equal(typeof build, 'object');

  const internalpreview = build?.internalpreview ?? null;
  assert.equal(typeof internalpreview, 'object');
  assert.equal(internalpreview.extends, 'base');
  assert.equal(internalpreview.environment, 'preview');
  assert.equal(internalpreview.distribution, 'internal');
  assert.equal(internalpreview.channel, 'internalpreview');
  assert.equal(internalpreview?.env?.APP_ENV, 'internalpreview');
  assert.equal(internalpreview?.env?.EXPO_UPDATES_CHANNEL, 'internalpreview');
  assert.equal(internalpreview?.env?.EXPO_APP_NAME, 'Happier (internal preview)');
  assert.equal(internalpreview?.env?.EXPO_APP_BUNDLE_ID, 'dev.happier.app.internalpreview');
  assert.equal(internalpreview?.env?.EXPO_APP_SCHEME, 'happier-internalpreview');

  const internalpreviewApk = build?.['internalpreview-apk'] ?? null;
  assert.equal(typeof internalpreviewApk, 'object');
  assert.equal(internalpreviewApk.extends, 'base');
  assert.equal(internalpreviewApk.environment, 'preview');
  assert.equal(internalpreviewApk.distribution, 'internal');
  assert.equal(internalpreviewApk.channel, 'internalpreview');
  assert.equal(internalpreviewApk?.android?.buildType, 'apk');
  assert.equal(internalpreviewApk?.env?.APP_ENV, 'internalpreview');
  assert.equal(internalpreviewApk?.env?.EXPO_UPDATES_CHANNEL, 'internalpreview');
  assert.equal(internalpreviewApk?.env?.EXPO_APP_NAME, 'Happier (internal preview)');
  assert.equal(internalpreviewApk?.env?.EXPO_APP_BUNDLE_ID, 'dev.happier.app.internalpreview');
  assert.equal(internalpreviewApk?.env?.EXPO_APP_SCHEME, 'happier-internalpreview');
});
