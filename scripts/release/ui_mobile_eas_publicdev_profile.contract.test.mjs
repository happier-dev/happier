import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('apps/ui/eas.json defines publicdev profiles for the public nightly dev lane', () => {
  const easPath = path.join(repoRoot, 'apps', 'ui', 'eas.json');
  const raw = fs.readFileSync(easPath, 'utf8');
  const eas = JSON.parse(raw);

  const build = eas?.build ?? null;
  assert.equal(typeof build, 'object');

  const publicdev = build?.publicdev ?? null;
  assert.equal(typeof publicdev, 'object');
  assert.equal(publicdev.extends, 'base');
  assert.equal(publicdev.environment, 'preview');
  assert.equal(publicdev.distribution, 'store');
  assert.equal(publicdev.channel, 'publicdev');
  assert.equal(publicdev?.env?.APP_ENV, 'publicdev');
  assert.equal(publicdev?.env?.EXPO_UPDATES_CHANNEL, 'publicdev');
  assert.equal(publicdev?.env?.EXPO_APP_NAME, 'Happier (dev)');
  assert.equal(publicdev?.env?.EXPO_APP_BUNDLE_ID, 'dev.happier.app.publicdev');
  assert.equal(publicdev?.env?.EXPO_APP_SCHEME, 'happier-publicdev');

  const publicdevApk = build?.['publicdev-apk'] ?? null;
  assert.equal(typeof publicdevApk, 'object');
  assert.equal(publicdevApk.extends, 'base');
  assert.equal(publicdevApk.environment, 'preview');
  assert.equal(publicdevApk.distribution, 'internal');
  assert.equal(publicdevApk.channel, 'publicdev');
  assert.equal(publicdevApk?.android?.buildType, 'apk');
  assert.equal(publicdevApk?.env?.APP_ENV, 'publicdev');
  assert.equal(publicdevApk?.env?.EXPO_UPDATES_CHANNEL, 'publicdev');
  assert.equal(publicdevApk?.env?.EXPO_APP_NAME, 'Happier (dev)');
  assert.equal(publicdevApk?.env?.EXPO_APP_BUNDLE_ID, 'dev.happier.app.publicdev');
  assert.equal(publicdevApk?.env?.EXPO_APP_SCHEME, 'happier-publicdev');

  const submit = eas?.submit ?? null;
  assert.equal(typeof submit, 'object');
  const publicdevSubmit = submit?.publicdev ?? null;
  assert.equal(typeof publicdevSubmit, 'object');
  assert.equal(typeof publicdevSubmit?.ios?.ascAppId, 'string');
  assert.ok(String(publicdevSubmit?.ios?.ascAppId ?? '').trim().length > 0);
  assert.equal(publicdevSubmit?.android?.track, 'internal');
});
