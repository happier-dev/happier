import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveStackArtifactsDir,
  resolveStackComponentArtifactDir,
  resolveStackRuntimePaths,
} from './runtime_paths.mjs';

test('resolveStackArtifactsDir places artifacts under the stack base dir', () => {
  const dir = resolveStackArtifactsDir({ stackBaseDir: '/tmp/happier/stacks/prod-dev' });

  assert.equal(dir, '/tmp/happier/stacks/prod-dev/artifacts');
});

test('resolveStackComponentArtifactDir scopes artifacts by component and fingerprint', () => {
  const dir = resolveStackComponentArtifactDir({
    stackBaseDir: '/tmp/happier/stacks/prod-dev',
    component: 'server',
    fingerprint: 'abc123',
  });

  assert.equal(dir, '/tmp/happier/stacks/prod-dev/artifacts/server/abc123');
});

test('resolveStackRuntimePaths exposes build and activation locations', () => {
  const paths = resolveStackRuntimePaths({
    stackBaseDir: '/tmp/happier/stacks/prod-dev',
    snapshotId: 'snap-1',
  });

  assert.deepEqual(paths, {
    runtimeDir: '/tmp/happier/stacks/prod-dev/runtime',
    buildsDir: '/tmp/happier/stacks/prod-dev/runtime/builds',
    currentDir: '/tmp/happier/stacks/prod-dev/runtime/current',
    currentPath: '/tmp/happier/stacks/prod-dev/runtime/current.json',
    currentManifestPath: '/tmp/happier/stacks/prod-dev/runtime/current/manifest.json',
    lockPath: '/tmp/happier/stacks/prod-dev/runtime/build.lock',
    snapshotDir: '/tmp/happier/stacks/prod-dev/runtime/builds/snap-1',
    manifestPath: '/tmp/happier/stacks/prod-dev/runtime/builds/snap-1/manifest.json',
  });
});
