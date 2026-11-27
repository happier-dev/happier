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

test('binds the hosted server artifact through its release tag commit, not the release target branch', async (t) => {
  const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const sha = '87aaa83f6b81c92a4ceee5816df2e566ed429bc7';
  const bin = await mkdtemp(path.join(os.tmpdir(), 'happier-gh-stub-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  // GitHub boundary: releases keep target_commitish on a branch because the API rejects raw
  // SHAs; the immutable tag itself resolves to the exact source commit.
  await writeFile(path.join(bin, 'gh'), [
    '#!/bin/sh',
    'case "$*" in',
    `  *"commits/server-v1.0.0-dev.1"*) echo ${sha} ;;`,
    '  *) echo "unexpected gh $*" >&2; exit 1 ;;',
    'esac',
  ].join('\n'));
  await chmod(path.join(bin, 'gh'), 0o755);
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    GH_REPO: 'happier-dev/happier',
    HAPPIER_DOCKER_SERVER_VERSION: '1.0.0-dev.1',
  };
  const resolve = (expectedServerSourceSha) => resolveDockerReleaseArtifactInputs({
    channel: 'dev', repoRoot, dryRun: false, env, includeDevBox: false, expectedServerSourceSha,
  });

  const inputs = await resolve(sha);
  assert.equal(inputs.relay.server.releaseTag, 'server-v1.0.0-dev.1');
  await assert.rejects(resolve('0'.repeat(40)), /Server artifact source does not match the hosted image candidate/);
});
