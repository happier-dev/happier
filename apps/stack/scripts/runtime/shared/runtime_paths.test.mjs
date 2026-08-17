import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  resolveStackArtifactsDir,
  resolveStackComponentArtifactDir,
  resolveStackComponentArtifactLockPath,
  resolveStackRuntimePaths,
} from './runtime_paths.mjs';

test('resolveStackArtifactsDir places artifacts under the stack base dir', () => {
  const stackBaseDir = join('tmp', 'happier', 'stacks', 'prod-dev');
  const dir = resolveStackArtifactsDir({ stackBaseDir });

  assert.equal(dir, join(stackBaseDir, 'artifacts'));
});

test('resolveStackComponentArtifactDir scopes artifacts by component and fingerprint', () => {
  const stackBaseDir = join('tmp', 'happier', 'stacks', 'prod-dev');
  const dir = resolveStackComponentArtifactDir({
    stackBaseDir,
    component: 'server',
    fingerprint: 'abc123',
  });

  assert.equal(dir, join(stackBaseDir, 'artifacts', 'server', 'abc123'));
});

test('resolveStackComponentArtifactDir rejects fingerprints that are not one managed-store path segment', () => {
  for (const fingerprint of ['../../escaped-web', '/absolute-artifact', 'nested/artifact', 'nested\\artifact', '.', '..']) {
    assert.throws(
      () => resolveStackComponentArtifactDir({
        stackBaseDir: '/tmp/happier/stacks/prod-dev',
        component: 'server',
        fingerprint,
      }),
      /artifact fingerprint.*path segment/i,
    );
  }
});

test('resolveStackComponentArtifactLockPath scopes publication to one immutable artifact identity', () => {
  const stackBaseDir = join('tmp', 'happier', 'stacks', 'prod-dev');
  assert.equal(
    resolveStackComponentArtifactLockPath({
      stackBaseDir,
      component: 'server',
      fingerprint: 'abc123',
    }),
    `${join(stackBaseDir, 'artifacts', 'server', 'abc123')}.lock`,
  );
});

test('resolveStackRuntimePaths exposes build and activation locations', () => {
  const stackBaseDir = join('tmp', 'happier', 'stacks', 'prod-dev');
  const runtimeDir = join(stackBaseDir, 'runtime');
  const buildsDir = join(runtimeDir, 'builds');
  const currentDir = join(runtimeDir, 'current');
  const paths = resolveStackRuntimePaths({
    stackBaseDir,
    snapshotId: 'snap-1',
  });

  assert.deepEqual(paths, {
    runtimeDir,
    buildsDir,
    currentDir,
    currentPath: join(runtimeDir, 'current.json'),
    currentManifestPath: join(currentDir, 'manifest.json'),
    lockPath: join(runtimeDir, 'build.lock'),
    snapshotDir: join(buildsDir, 'snap-1'),
    manifestPath: join(buildsDir, 'snap-1', 'manifest.json'),
  });
});

test('resolveStackRuntimePaths rejects snapshot ids that are not one path segment', () => {
  for (const snapshotId of ['../escaped', '/absolute-snapshot', 'nested/snapshot', 'nested\\snapshot']) {
    assert.throws(
      () => resolveStackRuntimePaths({ stackBaseDir: '/tmp/happier/stacks/prod-dev', snapshotId }),
      /snapshot id.*path segment/i,
    );
  }
});
