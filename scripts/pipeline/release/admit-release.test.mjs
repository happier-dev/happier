import test from 'node:test';
import assert from 'node:assert/strict';

import {
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

test('requires explicit maintainer approval only when the exact public SDK analysis asks for it', () => {
  assert.throws(() => admitRelease({
    ...base,
    publicSdk: { approvalRequired: true, approved: false },
  }), /public SDK release requires explicit maintainer approval/);
  assert.deepEqual(admitRelease({
    ...base,
    publicSdk: { approvalRequired: true, approved: true },
  }), { admitted: true });
  assert.deepEqual(admitRelease({
    ...base,
    publicSdk: { approvalRequired: false, approved: false },
  }), { admitted: true });
});

test('exact packed public SDK candidates retain prepublish and breaking-change approval', () => {
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
  }), /public SDK release requires explicit maintainer approval/);
  assert.deepEqual(admitPublicSdkRelease({
    packageName: '@happier-dev/plugin-sdk',
    approvalRequired: true,
    approved: true,
  }), { admitted: true });
});

test('npm publication consumes an exact admitted candidate without inventing a missing readiness authority', () => {
  const candidateSha = 'a'.repeat(40);

  assert.throws(() => admitRelease({
    ...base,
    npmPublication: {
      mode: 'pack+publish',
      dryRun: false,
      authorizedSha: '',
      checkedOutSha: candidateSha,
      packageNames: ['@happier-dev/relay-server'],
    },
  }), /release-admitted exact source SHA/);

  assert.throws(() => admitRelease({
    ...base,
    npmPublication: {
      mode: 'pack+publish',
      dryRun: false,
      authorizedSha: candidateSha,
      checkedOutSha: 'b'.repeat(40),
      packageNames: ['@happier-dev/relay-server'],
    },
  }), /does not match the checked-out source/);

  assert.deepEqual(admitRelease({
    ...base,
    npmPublication: {
      mode: 'pack+publish',
      dryRun: false,
      authorizedSha: candidateSha,
      checkedOutSha: candidateSha,
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

  const candidateSha = 'c'.repeat(40);
  const npmPublication = {
    mode: 'pack+publish',
    dryRun: false,
    authorizedSha: candidateSha,
    checkedOutSha: candidateSha,
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
