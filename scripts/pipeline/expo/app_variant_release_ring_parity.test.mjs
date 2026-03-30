import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { getReleaseRingCatalogEntry } from '@happier-dev/release-runtime/releaseRings';

const require = createRequire(import.meta.url);
const { APP_ENVIRONMENT_CONFIGS } = require('../../../apps/ui/appVariantConfig.cjs');

const environmentToReleaseRing = Object.freeze({
  internaldev: 'internaldev',
  internalpreview: 'internalpreview',
  publicdev: 'publicdev',
  preview: 'preview',
  production: 'stable',
});

test('appVariantConfig stays in sync with release ring catalog (updates + policy env)', () => {
  for (const [environment, ringId] of Object.entries(environmentToReleaseRing)) {
    const config = APP_ENVIRONMENT_CONFIGS[environment];
    assert.ok(config, `missing app environment config for ${environment}`);

    const ring = getReleaseRingCatalogEntry(ringId);
    assert.equal(
      config.updatesChannel,
      ring.expoUpdatesChannel,
      `${environment}.updatesChannel must match release ring ${ringId}.expoUpdatesChannel`,
    );
    assert.equal(
      config.featurePolicyEnv,
      ring.embeddedPolicyEnv,
      `${environment}.featurePolicyEnv must match release ring ${ringId}.embeddedPolicyEnv`,
    );

    const expectedLogicalVariant =
      ring.expoAppEnv === 'development'
        ? 'development'
        : ring.expoAppEnv === 'production'
          ? 'production'
          : 'preview';
    assert.equal(
      config.logicalVariant,
      expectedLogicalVariant,
      `${environment}.logicalVariant must match release ring ${ringId}.expoAppEnv`,
    );
  }
});

test('mobile app variants can be installed side-by-side (unique bundle ids, packages, schemes)', () => {
  const envIds = Object.keys(environmentToReleaseRing);
  const iosBundleIds = envIds.map((id) => String(APP_ENVIRONMENT_CONFIGS[id]?.iosBundleId ?? '').trim());
  const androidPackages = envIds.map((id) => String(APP_ENVIRONMENT_CONFIGS[id]?.androidPackage ?? '').trim());
  const schemes = envIds.map((id) => String(APP_ENVIRONMENT_CONFIGS[id]?.scheme ?? '').trim());

  assert.equal(new Set(iosBundleIds).size, iosBundleIds.length, 'ios bundle identifiers must be unique per environment');
  assert.equal(new Set(androidPackages).size, androidPackages.length, 'android package names must be unique per environment');
  assert.equal(new Set(schemes).size, schemes.length, 'deep link schemes must be unique per environment');

  const publicdevName = String(APP_ENVIRONMENT_CONFIGS.publicdev?.name ?? '').toLowerCase();
  assert.ok(publicdevName.includes('dev'), 'public dev variant name should include "dev"');
  assert.ok(!publicdevName.includes('publicdev'), 'public dev variant name must not expose internal ring id "publicdev"');
});

