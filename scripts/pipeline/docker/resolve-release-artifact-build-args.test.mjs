import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  resolveDockerReleaseArtifactInputs,
} from './resolve-release-artifact-build-args.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

test('publishing Docker images rejects moving rolling artifact inference', async () => {
  await assert.rejects(
    resolveDockerReleaseArtifactInputs({
      channel: 'preview',
      repoRoot,
      dryRun: false,
      env: { GH_REPO: 'happier-dev/happier', GH_TOKEN: 'token' },
      fetchGitHubReleaseByTag: async () => {
        throw new Error('unexpected GitHub lookup');
      },
    }),
    /HAPPIER_DOCKER_SERVER_VERSION/,
  );
});

test('uses explicit Docker artifact version overrides without GitHub lookups', async () => {
  const inputs = await resolveDockerReleaseArtifactInputs({
    channel: 'dev',
    repoRoot,
    dryRun: false,
    sourceRef: 'feature/older-dev-build',
    env: {
      HAPPIER_DOCKER_SERVER_VERSION: '1.0.0-dev.1',
      HAPPIER_DOCKER_CLI_VERSION: '1.0.0-dev.3',
      HAPPIER_DOCKER_RELEASE_BASE_URL: 'https://downloads.example.test/releases/',
    },
    fetchGitHubReleaseByTag: async () => {
      throw new Error('unexpected GitHub lookup');
    },
  });

  assert.equal(inputs.releaseBaseUrl, 'https://downloads.example.test/releases');
  assert.deepEqual(inputs.relay.server, { releaseTag: 'server-v1.0.0-dev.1', version: '1.0.0-dev.1' });
  assert.deepEqual(inputs.devBox.cli, { releaseTag: 'cli-v1.0.0-dev.3', version: '1.0.0-dev.3' });
});

test('requires the exact CLI version when publishing only the dev-box image', async () => {
  await assert.rejects(
    resolveDockerReleaseArtifactInputs({
      channel: 'preview',
      repoRoot,
      dryRun: false,
      includeRelay: false,
      env: { GH_REPO: 'happier-dev/happier', GH_TOKEN: 'token' },
      fetchGitHubReleaseByTag: async () => {
        throw new Error('unexpected GitHub lookup');
      },
    }),
    /HAPPIER_DOCKER_CLI_VERSION/,
  );
});
