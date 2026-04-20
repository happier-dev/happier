import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveReleaseArtifactSmokeEligibility,
} from '../pipeline/release/publishing/artifact-smoke-compatibility.mjs';

test('artifact smoke eligibility accepts archives that match the current runner target', () => {
  assert.deepEqual(
    resolveReleaseArtifactSmokeEligibility({
      archiveName: 'happier-v1.2.3-preview.4-linux-x64.tar.gz',
      runner: { platform: 'linux', arch: 'x64' },
    }),
    {
      eligible: true,
      reason: 'compatible-target',
      target: {
        product: 'happier',
        version: '1.2.3-preview.4',
        os: 'linux',
        arch: 'x64',
        filename: 'happier-v1.2.3-preview.4-linux-x64.tar.gz',
      },
      runnerTarget: { os: 'linux', arch: 'x64' },
    },
  );
});

test('artifact smoke eligibility skips archives whose architecture does not match the runner', () => {
  assert.deepEqual(
    resolveReleaseArtifactSmokeEligibility({
      archiveName: 'happier-v1.2.3-preview.4-linux-arm64.tar.gz',
      runner: { platform: 'linux', arch: 'x64' },
    }),
    {
      eligible: false,
      reason: 'target-mismatch',
      target: {
        product: 'happier',
        version: '1.2.3-preview.4',
        os: 'linux',
        arch: 'arm64',
        filename: 'happier-v1.2.3-preview.4-linux-arm64.tar.gz',
      },
      runnerTarget: { os: 'linux', arch: 'x64' },
    },
  );
});

test('artifact smoke eligibility normalizes win32 runners to windows targets', () => {
  assert.deepEqual(
    resolveReleaseArtifactSmokeEligibility({
      archiveName: 'hstack-v0.2.2-dev.52.1-windows-x64.tar.gz',
      runner: { platform: 'win32', arch: 'x64' },
    }),
    {
      eligible: true,
      reason: 'compatible-target',
      target: {
        product: 'hstack',
        version: '0.2.2-dev.52.1',
        os: 'windows',
        arch: 'x64',
        filename: 'hstack-v0.2.2-dev.52.1-windows-x64.tar.gz',
      },
      runnerTarget: { os: 'windows', arch: 'x64' },
    },
  );
});

test('artifact smoke eligibility skips non-binary tarballs that do not encode a native target', () => {
  assert.deepEqual(
    resolveReleaseArtifactSmokeEligibility({
      archiveName: 'happier-ui-web-v1.2.3-preview.4-web-any.tar.gz',
      runner: { platform: 'linux', arch: 'x64' },
    }),
    {
      eligible: false,
      reason: 'non-native-archive',
      target: null,
      runnerTarget: { os: 'linux', arch: 'x64' },
    },
  );
});
