import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);
const { getAppEnvironmentConfig, normalizeAppEnvironmentId } = require(
  path.join(repoRoot, 'apps', 'ui', 'appVariantConfig.cjs'),
);

test('appVariantConfig normalizes legacy mobile environment aliases into the new internal/public ring ids', () => {
  assert.equal(normalizeAppEnvironmentId('development'), 'internaldev');
  assert.equal(normalizeAppEnvironmentId('dev'), 'publicdev');
  assert.equal(normalizeAppEnvironmentId('canary'), 'internalpreview');
  assert.equal(normalizeAppEnvironmentId('stable'), 'production');
});

test('appVariantConfig treats publicdev as a preview-like public ring with its own native identity', () => {
  const publicdev = getAppEnvironmentConfig('publicdev');

  assert.equal(publicdev.id, 'publicdev');
  assert.equal(publicdev.logicalVariant, 'preview');
  assert.equal(publicdev.name, 'Happier (dev)');
  assert.equal(publicdev.iosBundleId, 'dev.happier.app.publicdev');
  assert.equal(publicdev.androidPackage, 'dev.happier.app.publicdev');
  assert.equal(publicdev.scheme, 'happier-dev');
  // User-facing OTA channel should be "dev" (internal lane is "publicdev").
  assert.equal(publicdev.updatesChannel, 'dev');
  assert.equal(publicdev.featurePolicyEnv, 'preview');
});
