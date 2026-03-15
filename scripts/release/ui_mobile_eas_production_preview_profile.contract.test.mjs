import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('apps/ui/eas.json defines production-preview profiles (preview runtime variant with production bundle id)', () => {
  const easPath = path.join(repoRoot, 'apps', 'ui', 'eas.json');
  const raw = fs.readFileSync(easPath, 'utf8');
  const eas = JSON.parse(raw);

  const build = eas?.build ?? null;
  assert.equal(typeof build, 'object');

  const prodPreview = build?.['production-preview'] ?? null;
  assert.equal(typeof prodPreview, 'object');
  assert.equal(prodPreview.extends, 'base');
  assert.equal(prodPreview.environment, 'production');
  assert.equal(prodPreview.channel, 'preview');

  // Native identity stays production so production-only native config (domains/intents) remains enabled.
  assert.equal(prodPreview?.env?.APP_ENV, 'production');
  assert.equal(prodPreview?.env?.HAPPIER_APP_VARIANT_OVERRIDE, 'preview');
  assert.equal(prodPreview?.env?.EXPO_UPDATES_CHANNEL, 'preview');
  assert.equal(prodPreview?.env?.EXPO_APP_BUNDLE_ID, 'dev.happier.app');

  const prodPreviewApk = build?.['production-preview-apk'] ?? null;
  assert.equal(typeof prodPreviewApk, 'object');
  assert.equal(prodPreviewApk.extends, 'base');
  assert.equal(prodPreviewApk.environment, 'production');
  assert.equal(prodPreviewApk.channel, 'preview');
  assert.equal(prodPreviewApk.distribution, 'internal');
  assert.equal(prodPreviewApk?.android?.buildType, 'apk');

  assert.equal(prodPreviewApk?.env?.APP_ENV, 'production');
  assert.equal(prodPreviewApk?.env?.HAPPIER_APP_VARIANT_OVERRIDE, 'preview');
  assert.equal(prodPreviewApk?.env?.EXPO_UPDATES_CHANNEL, 'preview');
  assert.equal(prodPreviewApk?.env?.EXPO_APP_BUNDLE_ID, 'dev.happier.app');
});
