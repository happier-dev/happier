import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, resolve } from 'node:path';

import {
  bundledWorkspacePackages,
  resolveBundledWorkspaceBuildEntry,
  syncBundledWorkspaceDist,
} from './buildSharedDeps.mjs';
import { createBundledWorkspaceBundles } from './workspaceBundleManifest.mjs';

test('buildSharedDeps builds every bundled workspace package needed by the published CLI', () => {
  assert.deepEqual(bundledWorkspacePackages, ['agents', 'cli-common', 'protocol', 'release-runtime']);
});

test('workspace bundle manifest derives bundle metadata from a single package list', () => {
  const repoRoot = resolve('repo');
  const targetRoot = resolve(repoRoot, 'apps', 'cli');

  assert.deepEqual(createBundledWorkspaceBundles({ repoRoot, targetRoot }), [
    {
      packageName: '@happier-dev/agents',
      srcDir: resolve(repoRoot, 'packages', 'agents'),
      destDir: resolve(targetRoot, 'node_modules', '@happier-dev', 'agents'),
    },
    {
      packageName: '@happier-dev/cli-common',
      srcDir: resolve(repoRoot, 'packages', 'cli-common'),
      destDir: resolve(targetRoot, 'node_modules', '@happier-dev', 'cli-common'),
    },
    {
      packageName: '@happier-dev/protocol',
      srcDir: resolve(repoRoot, 'packages', 'protocol'),
      destDir: resolve(targetRoot, 'node_modules', '@happier-dev', 'protocol'),
    },
    {
      packageName: '@happier-dev/release-runtime',
      srcDir: resolve(repoRoot, 'packages', 'release-runtime'),
      destDir: resolve(targetRoot, 'node_modules', '@happier-dev', 'release-runtime'),
    },
  ]);
});

test('buildSharedDeps verifies each package using its declared main entry when available', () => {
  const repoRoot = resolve('repo');

  assert.equal(
    resolveBundledWorkspaceBuildEntry('release-runtime', {
      repoRoot,
      readFileSync: () => JSON.stringify({ main: './dist/github.js' }),
    }),
    resolve(repoRoot, 'packages', 'release-runtime', 'dist', 'github.js'),
  );

  assert.equal(
    resolveBundledWorkspaceBuildEntry('release-runtime', {
      repoRoot,
      readFileSync: () => JSON.stringify({}),
    }),
    resolve(repoRoot, 'packages', 'release-runtime', 'dist', 'index.js'),
  );
});

test('syncBundledWorkspaceDist defaults include release-runtime', () => {
  const copyCalls = [];
  const writeCalls = [];
  const repoRoot = resolve('repo');
  const releaseRuntimeDist = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'dist');
  const releaseRuntimePackageJson = resolve(
    repoRoot,
    'apps',
    'cli',
    'node_modules',
    '@happier-dev',
    'release-runtime',
    'package.json',
  );
  const releaseRuntimeSourceDist = resolve(repoRoot, 'packages', 'release-runtime', 'dist');
  const toPlatformPath = (path) => normalize(String(path));

  syncBundledWorkspaceDist({
    repoRoot,
    existsSync: (candidate) =>
      [releaseRuntimeDist, releaseRuntimePackageJson].includes(toPlatformPath(candidate)),
    cpSync: (src, dest, opts) => {
      copyCalls.push({ src: toPlatformPath(src), dest: toPlatformPath(dest), opts });
    },
    readFileSync: () =>
      JSON.stringify({
        name: '@happier-dev/release-runtime',
        version: '0.0.0',
        type: 'module',
        exports: { './github': { default: './dist/github.js' } },
      }),
    writeFileSync: (path, payload) => {
      writeCalls.push({ path: toPlatformPath(path), payload: String(payload) });
    },
  });

  assert.deepEqual(copyCalls, [
    {
      src: releaseRuntimeSourceDist,
      dest: releaseRuntimeDist,
      opts: { recursive: true, force: true },
    },
  ]);

  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0]?.path, releaseRuntimePackageJson);
  assert.match(writeCalls[0]?.payload ?? '', /\"name\": \"@happier-dev\/release-runtime\"/);
  assert.match(writeCalls[0]?.payload ?? '', /\"private\": true/);
});
