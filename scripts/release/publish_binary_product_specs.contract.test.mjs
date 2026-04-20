import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BINARY_PUBLISH_PRODUCT_IDS,
  getBinaryPublishProductSpec,
} from '../pipeline/release/publishing/product-specs.mjs';

test('binary publish product specs expose the canonical per-product release metadata', () => {
  assert.deepEqual(BINARY_PUBLISH_PRODUCT_IDS, ['cli', 'hstack', 'server']);

  assert.deepEqual(getBinaryPublishProductSpec('cli'), {
    id: 'cli',
    pipelineLabel: 'cli-binaries',
    publishSurfaceLabel: 'CLI binary publishing',
    minisignRequirementLabel: 'CLI release artifacts',
    packageJsonPath: 'apps/cli/package.json',
    patchPackageVersionOnRolling: true,
    buildScriptPath: 'scripts/pipeline/release/build-cli-binaries.mjs',
    artifactsDir: 'dist/release-assets/cli',
    manifestProduct: 'happier',
    manifestOutDir: 'dist/release-assets/cli/manifests',
    checksumProductStem: 'happier',
    rollingTagPrefix: 'cli',
    versionTagPrefix: 'cli-v',
    releaseTitleBase: 'Happier CLI',
    rollingNotesSubject: 'CLI binaries',
    versionNotesSubject: 'CLI',
  });

  assert.deepEqual(getBinaryPublishProductSpec('hstack'), {
    id: 'hstack',
    pipelineLabel: 'hstack-binaries',
    publishSurfaceLabel: 'hstack binary publishing',
    minisignRequirementLabel: 'hstack release artifacts',
    packageJsonPath: 'apps/stack/package.json',
    patchPackageVersionOnRolling: true,
    buildScriptPath: 'scripts/pipeline/release/build-hstack-binaries.mjs',
    artifactsDir: 'dist/release-assets/stack',
    manifestProduct: 'hstack',
    manifestOutDir: 'dist/release-assets/stack/manifests',
    checksumProductStem: 'hstack',
    rollingTagPrefix: 'stack',
    versionTagPrefix: 'stack-v',
    releaseTitleBase: 'Happier Stack',
    rollingNotesSubject: 'hstack binaries',
    versionNotesSubject: 'hstack',
  });

  assert.deepEqual(getBinaryPublishProductSpec('server'), {
    id: 'server',
    pipelineLabel: 'server-runtime',
    publishSurfaceLabel: 'server runtime publishing',
    minisignRequirementLabel: 'server runtime release artifacts',
    packageJsonPath: 'apps/server/package.json',
    patchPackageVersionOnRolling: false,
    buildScriptPath: 'scripts/pipeline/release/build-server-binaries.mjs',
    artifactsDir: 'dist/release-assets/server',
    manifestProduct: 'happier-server',
    manifestOutDir: 'dist/release-assets/server/manifests',
    checksumProductStem: 'happier-server',
    rollingTagPrefix: 'server',
    versionTagPrefix: 'server-v',
    releaseTitleBase: 'Happier Server',
    rollingNotesSubject: 'server runtime release',
    versionNotesSubject: 'Server runtime',
  });
});

test('binary publish product specs reject unknown publish products', () => {
  assert.throws(() => getBinaryPublishProductSpec('unknown'), /Unknown binary publish product/i);
});
