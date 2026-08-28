import test from 'node:test';
import assert from 'node:assert/strict';

import {
  admitPublicSdkPublication,
  admitPublicSdkRelease,
  admitRelease,
  publicSdkReleaseApprovalRequired,
  resolvePublicNpmPackageNames,
} from './admit-release.mjs';

const base = {
  checksProfile: 'fast',
  environment: 'preview',
  publishServerRuntimeNeeded: true,
  publishCliBinariesNeeded: true,
  risks: { mysqlContract: false, platformServices: false, trustRoots: false },
  gates: { mysql: 'skipped', platform: 'skipped', trustRoots: 'skipped' },
};

test('admits a preview when no heavy risk gate applies', () => {
  assert.deepEqual(admitRelease(base), { admitted: true });
});

test('requires full checks for production and successful selected risk gates', () => {
  assert.throws(() => admitRelease({ ...base, environment: 'production' }), /checks_profile=full/);
  assert.throws(() => admitRelease({
    ...base,
    risks: { ...base.risks, mysqlContract: true },
    gates: { ...base.gates, mysql: 'failure' },
  }), /MySQL gate/);
  assert.throws(() => admitRelease({
    ...base,
    risks: { ...base.risks, trustRoots: true },
    gates: { ...base.gates, trustRoots: 'skipped' },
  }), /trust validation/);
});

test('public SDK publication retains first-publication and breaking-change approval', () => {
  assert.equal(publicSdkReleaseApprovalRequired({
    sourcePosture: 'prepublish_hold',
    apiGovernance: { humanReviewRequired: false },
  }), true);
  assert.equal(publicSdkReleaseApprovalRequired({
    sourcePosture: 'developer_preview',
    apiGovernance: { humanReviewRequired: true },
  }), true);
  assert.equal(publicSdkReleaseApprovalRequired({
    sourcePosture: 'developer_preview',
    apiGovernance: { humanReviewRequired: false },
  }), false);
  assert.equal(publicSdkReleaseApprovalRequired({
    sourcePosture: 'developer_preview',
    externalPublicationRequiresApproval: true,
    apiGovernance: { humanReviewRequired: false },
  }), true);

  assert.throws(() => admitPublicSdkRelease({
    packageName: '@happier-dev/plugin-sdk',
    approvalRequired: true,
    approved: false,
  }), /public SDK publication requires explicit maintainer approval at release dispatch/);
  assert.deepEqual(admitPublicSdkRelease({
    packageName: '@happier-dev/plugin-sdk',
    approvalRequired: true,
    approved: true,
  }), { admitted: true });
});

test('npm publication consumes the release-dispatch source identity', () => {
  const sourceSha = 'a'.repeat(40);
  assert.throws(() => admitRelease({
    ...base,
    npmPublication: {
      mode: 'pack+publish',
      dryRun: false,
      authorizedSha: '',
      checkedOutSha: sourceSha,
      packageNames: ['@happier-dev/plugin-sdk'],
    },
  }), /release-dispatch source SHA/);
  assert.throws(() => admitRelease({
    ...base,
    npmPublication: {
      mode: 'pack+publish',
      dryRun: false,
      authorizedSha: sourceSha,
      checkedOutSha: 'b'.repeat(40),
      packageNames: ['@happier-dev/plugin-sdk'],
    },
  }), /does not match the checked-out source/);
  assert.deepEqual(admitRelease({
    ...base,
    npmPublication: {
      mode: 'pack+publish',
      dryRun: false,
      authorizedSha: sourceSha,
      checkedOutSha: sourceSha,
      packageNames: ['@happier-dev/plugin-sdk', '@happier-dev/plugin-ui'],
    },
  }), { admitted: true });
});

test('the public npm package names one release selection publishes have a single owner', () => {
  assert.deepEqual(resolvePublicNpmPackageNames({}), []);
  assert.deepEqual(
    resolvePublicNpmPackageNames({ pluginSdk: true, sdk: true, channelsProtocol: true }),
    ['@happier-dev/plugin-sdk', '@happier-dev/plugin-ui', '@happier-dev/sdk', '@happier-dev/channels-protocol'],
  );
  assert.deepEqual(
    resolvePublicNpmPackageNames({ channelsProtocol: true }),
    ['@happier-dev/channels-protocol'],
  );

  const sourceSha = 'c'.repeat(40);
  const npmPublication = {
    mode: 'pack+publish',
    dryRun: false,
    authorizedSha: sourceSha,
    checkedOutSha: sourceSha,
  };

  // Public packages are governed by their executable API/package checks and
  // approved release classification, not an unavailable synthetic gate.
  assert.deepEqual(admitRelease({
    ...base,
    npmPublication: { ...npmPublication, packageNames: resolvePublicNpmPackageNames({ channelsProtocol: true }) },
  }), { admitted: true });

  // Non-public packages stay publishable: the readiness owner must be able to
  // stay silent, or it proves nothing when it fires.
  assert.deepEqual(admitRelease({
    ...base,
    npmPublication: { ...npmPublication, packageNames: ['@happier-dev/relay-server', '@happier-dev/cli'] },
  }), { admitted: true });
});

function publicSdkAdmission(overrides = {}) {
  return {
    channel: 'preview',
    npmTag: 'next',
    approved: true,
    releaseNotesId: '2026.08.28-preview',
    publishPluginSdk: false,
    pluginSdkReady: false,
    pluginSdkFirstPublication: false,
    pluginSdkRemovedSymbols: false,
    pluginSdkHumanReviewRequired: false,
    publishSdk: true,
    sdkAuthReadiness: 'ready',
    sdkVersion: '0.1.0-preview.1',
    sdkFirstPublication: true,
    sdkRemovedSymbols: false,
    sdkHumanReviewRequired: false,
    sdkClassification: 'first_publication',
    sdkMigrationNotes: 'not_required',
    ...overrides,
  };
}

test('public SDK admission consumes direct readiness, comparison facts, and maintainer classification', () => {
  assert.deepEqual(admitPublicSdkPublication(publicSdkAdmission()), { admitted: true });
  assert.throws(
    () => admitPublicSdkPublication(publicSdkAdmission({ ciWaived: true })),
    /public SDK publication cannot waive exact-SHA CI/u,
  );
  assert.throws(() => admitPublicSdkPublication(publicSdkAdmission({ channel: 'production', npmTag: 'latest' })), /preview.*next/u);
  assert.throws(() => admitPublicSdkPublication(publicSdkAdmission({ approved: false })), /explicit maintainer approval/u);
  assert.throws(() => admitPublicSdkPublication(publicSdkAdmission({ sdkVersion: '0.1.0' })), /0\.x preview/u);
  assert.throws(() => admitPublicSdkPublication(publicSdkAdmission({ sdkClassification: 'compatible' })), /first publication/u);
});

test('plugin readiness and external SDK auth readiness are explicit direct inputs', () => {
  const plugin = publicSdkAdmission({
    publishPluginSdk: true,
    pluginSdkReady: true,
    pluginSdkVersion: '0.1.0-preview.1',
    pluginSdkFirstPublication: true,
    pluginSdkClassification: 'first_publication',
    pluginSdkMigrationNotes: 'not_required',
  });
  assert.deepEqual(admitPublicSdkPublication(plugin), { admitted: true });
  assert.throws(() => admitPublicSdkPublication({ ...plugin, pluginSdkReady: false }), /plugin SDK publication requires explicit/u);
  assert.deepEqual(admitPublicSdkPublication(publicSdkAdmission({ sdkAuthReadiness: 'waived', sdkAuthWaiver: 'preview-auth-waiver' })), { admitted: true });
  assert.throws(() => admitPublicSdkPublication(publicSdkAdmission({ sdkAuthReadiness: 'waived', sdkAuthWaiver: '' })), /waiver must be named/u);
});

test('removed symbols require breaking classification and release notes', () => {
  const breaking = publicSdkAdmission({
    sdkVersion: '0.2.0-preview.1',
    sdkFirstPublication: false,
    sdkRemovedSymbols: true,
    sdkHumanReviewRequired: true,
    sdkClassification: 'breaking',
    sdkMigrationNotes: '2026.08.28-preview',
  });
  assert.deepEqual(admitPublicSdkPublication(breaking), { admitted: true });
  assert.throws(() => admitPublicSdkPublication({ ...breaking, sdkClassification: 'compatible' }), /removed public symbols/u);
  assert.throws(() => admitPublicSdkPublication({ ...breaking, sdkMigrationNotes: 'not_required' }), /migration notes/u);
});

test('canonical release admission fails closed when selected public SDK inputs are absent', () => {
  const publicSdkPublication = publicSdkAdmission();
  assert.deepEqual(admitRelease({ ...base, publicSdkPublication }), { admitted: true });
  assert.throws(() => admitRelease({
    ...base,
    publicSdkPublication: { ...publicSdkPublication, sdkClassification: '' },
  }), /first publication/u);
});
