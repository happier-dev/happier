import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('apps/ui/eas.json defines a development profile for OTA-native debug dev-client validation', () => {
  const easPath = path.join(repoRoot, 'apps', 'ui', 'eas.json');
  const raw = fs.readFileSync(easPath, 'utf8');
  const eas = JSON.parse(raw);

  const build = eas?.build ?? null;
  assert.equal(typeof build, 'object');

  const development = build?.development ?? null;
  assert.equal(typeof development, 'object');
  assert.equal(development.extends, 'base');
  assert.equal(development.environment, 'development');
  assert.equal(development.developmentClient, true);
  assert.equal(development.distribution, 'internal');
  assert.equal(development.channel, 'development');
  assert.equal(development?.env?.APP_ENV, 'development');
  assert.equal(development?.env?.HAPPIER_EXPO_DEVCLIENT_LAUNCH_MODE, 'most-recent');
  assert.equal(development?.env?.HAPPIER_EXPO_DEVCLIENT_SILENT_LAUNCH, 'true');
  assert.equal(development?.env?.HAPPIER_EXPO_USE_NATIVE_DEBUG, 'true');
  assert.equal(development?.env?.EX_UPDATES_NATIVE_DEBUG, '1');
});
