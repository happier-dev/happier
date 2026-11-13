import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bundleWorkspacePackage, findRepoRoot } from '../dist/workspaces/index.js';

test('bundled cli-common source runtime retains its private import closure', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-cli-common-source-bundle-'));
  try {
    const destDir = join(tempRoot, 'cli-common');
    bundleWorkspacePackage({
      packageName: '@happier-dev/cli-common',
      srcDir: fileURLToPath(new URL('..', import.meta.url)),
      destDir,
    });
    const runtime = await import(pathToFileURL(join(destDir, 'sourceRuntimeEntries.mjs')).href);
    assert.equal(runtime.resolveWorkspaceSource(new Map([
      ['example', { root: destDir, manifest: { exports: {
        './*': { 'happier-source': './src/*.ts' },
      } } }],
    ]), 'example/feature'), join(destDir, 'src', 'feature.ts'));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('bundled cli-common supports the temporary-directory lifecycle', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-cli-common-bundle-'));
  try {
    const destDir = join(tempRoot, 'cli-common');
    bundleWorkspacePackage({
      packageName: '@happier-dev/cli-common',
      srcDir: fileURLToPath(new URL('..', import.meta.url)),
      destDir,
    });
    const { createHappierTempDir, readHappierTempDirOwner, removeHappierTempDir } = await import(
      pathToFileURL(join(destDir, 'dist', 'tempDirs', 'index.js')).href
    );
    const directory = createHappierTempDir({ purpose: 'happier-bundle-test', root: tempRoot });
    assert.equal(readHappierTempDirOwner(directory)?.pid, process.pid);
    removeHappierTempDir(directory);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('findRepoRoot returns the nearest repo root marker directory', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-workspaces-root-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const nested = join(repoRoot, 'apps', 'stack', 'scripts');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(repoRoot, 'package.json'), '{}\n', 'utf8');
    writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), '\n', 'utf8');
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8');
    assert.equal(findRepoRoot(nested), repoRoot);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('findRepoRoot throws when no repository root is found', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-workspaces-missing-'));
  try {
    let dir = tempRoot;
    for (let i = 0; i < 12; i++) {
      dir = join(dir, `d${i}`);
    }
    mkdirSync(dir, { recursive: true });
    assert.throws(() => findRepoRoot(dir), /Repository root not found starting from/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
