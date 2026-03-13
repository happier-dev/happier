import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { bundledWorkspaceDirs } from './buildSharedDeps.mjs';
import {
  bundledWorkspaceDirNames,
  bundledWorkspacePackageNames,
  createBundledWorkspaceBundles,
} from './bundledWorkspacePackages.mjs';

test('apps/cli prepack builds dist for npm pack', () => {
  const pkgPath = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const prepack = String(pkg?.scripts?.prepack ?? '');
  assert.ok(prepack.includes('build'), `expected scripts.prepack to include a build step, got: ${prepack || '(missing)'}`);
  assert.ok(
    prepack.includes('bundleWorkspaceDeps.mjs'),
    `expected scripts.prepack to bundle workspace deps, got: ${prepack || '(missing)'}`,
  );
});

test('apps/cli npm files list ships archives (not unpacked tools)', () => {
  const pkgPath = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const files = Array.isArray(pkg?.files) ? pkg.files.map((v) => String(v)) : [];

  assert.ok(files.includes('dist'), 'expected dist to be shipped');
  assert.ok(files.includes('bin'), 'expected bin to be shipped');

  assert.ok(files.includes('tools/archives'), 'expected tools/archives to be shipped');
  assert.ok(files.includes('tools/licenses'), 'expected tools/licenses to be shipped');

  assert.ok(!files.includes('tools'), 'expected not to ship entire tools/ tree (would include unpacked binaries)');
  assert.ok(!files.includes('tools/unpacked'), 'expected tools/unpacked to be excluded');
});

test('apps/cli bundled workspace package definitions stay in sync', () => {
  const pkgPath = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const bundledDependencies = Array.isArray(pkg?.bundledDependencies)
    ? pkg.bundledDependencies.map((value) => String(value)).sort()
    : [];

  assert.deepEqual(bundledDependencies, [...bundledWorkspacePackageNames].sort());
  assert.deepEqual([...bundledWorkspaceDirs], [...bundledWorkspaceDirNames]);

  const repoRoot = resolve('/tmp', 'happier-repo');
  const happyCliDir = resolve(repoRoot, 'apps', 'cli');
  const bundles = createBundledWorkspaceBundles({ repoRoot, happyCliDir });

  assert.deepEqual(
    bundles.map(({ packageName }) => packageName).sort(),
    [...bundledWorkspacePackageNames].sort(),
  );

  const releaseRuntimeBundle = bundles.find(
    ({ packageName }) => packageName === '@happier-dev/release-runtime',
  );
  assert.ok(releaseRuntimeBundle, 'expected release-runtime to be bundled for npm publish');
  assert.equal(releaseRuntimeBundle.srcDir, resolve(repoRoot, 'packages', 'release-runtime'));
  assert.equal(
    releaseRuntimeBundle.destDir,
    resolve(happyCliDir, 'node_modules', '@happier-dev', 'release-runtime'),
  );
});
