import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveArtifactVerifyExecution,
  resolveArtifactVerifyTarget,
} from '../pipeline/release/publishing/artifact-verify-target.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('artifact verification target helper resolves cli paths from product metadata', () => {
  const target = resolveArtifactVerifyTarget({
    repoRoot,
    source: { kind: 'local-build', ref: 'dist/release-assets/cli' },
    options: {
      product: 'cli',
      version: '1.2.3-preview.4',
    },
  });

  assert.deepEqual(target, {
    artifactsDir: resolve(repoRoot, 'dist/release-assets/cli'),
    checksumsPath: resolve(repoRoot, 'dist/release-assets/cli/checksums-happier-v1.2.3-preview.4.txt'),
    publicKeyPath: resolve(repoRoot, 'scripts/release/installers/happier-release.pub'),
    skipSmoke: false,
    preflightPaths: [
      resolve(repoRoot, 'dist/release-assets/cli/checksums-happier-v1.2.3-preview.4.txt'),
      resolve(repoRoot, 'dist/release-assets/cli/checksums-happier-v1.2.3-preview.4.txt.minisig'),
      resolve(repoRoot, 'dist/release-assets/cli/manifests/v1/happier/preview/latest.json'),
    ],
  });
});

test('artifact verification target helper resolves server execution through the shared executor contract', () => {
  const execution = resolveArtifactVerifyExecution({
    repoRoot,
    source: { kind: 'local-build', ref: 'dist/release-assets/server' },
    options: {
      product: 'server',
      version: '2.0.0-dev.7',
      skipSmoke: true,
    },
  });

  assert.deepEqual(execution, {
    type: 'command',
    command: process.execPath,
    args: [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'verify-artifacts.mjs'),
      '--artifacts-dir',
      resolve(repoRoot, 'dist/release-assets/server'),
      '--checksums',
      resolve(repoRoot, 'dist/release-assets/server/checksums-happier-server-v2.0.0-dev.7.txt'),
      '--public-key',
      resolve(repoRoot, 'scripts/release/installers/happier-release.pub'),
      '--skip-smoke',
    ],
    cwd: repoRoot,
  });
});
