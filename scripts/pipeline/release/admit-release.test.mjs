import test from 'node:test';
import assert from 'node:assert/strict';

import { admitRelease, resolvePublicNpmPackageNames } from './admit-release.mjs';

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

test('npm publication consumes an exact admitted candidate and fails closed for public SDK readiness without an owner', () => {
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

  assert.throws(() => admitRelease({
    ...base,
    npmPublication: {
      mode: 'pack+publish',
      dryRun: false,
      authorizedSha: candidateSha,
      checkedOutSha: candidateSha,
      packageNames: ['@happier-dev/plugin-sdk', '@happier-dev/plugin-ui'],
    },
  }), /PUBLIC_SDK_READINESS_OWNER_UNAVAILABLE/);
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

  // The Channels protocol is a public Developer Preview package whose consumers
  // resolve the public SDK alongside it, so it fails closed at the same
  // readiness owner as the rest of the public surface.
  assert.throws(() => admitRelease({
    ...base,
    npmPublication: { ...npmPublication, packageNames: resolvePublicNpmPackageNames({ channelsProtocol: true }) },
  }), /PUBLIC_SDK_READINESS_OWNER_UNAVAILABLE/);

  // Non-public packages stay publishable: the readiness owner must be able to
  // stay silent, or it proves nothing when it fires.
  assert.deepEqual(admitRelease({
    ...base,
    npmPublication: { ...npmPublication, packageNames: ['@happier-dev/relay-server', '@happier-dev/cli'] },
  }), { admitted: true });
});
