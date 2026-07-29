import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { loadCliCommonDistModule, resolveCliCommonDistModulePathForTests } from './ensureCliCommonDistModule.mjs';

test('loadCliCommonDistModule rebuilds cli-common when the dist module is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-loader-'));
  try {
    const repoRoot = join(root, 'repo');
    const packageDir = join(repoRoot, 'packages', 'cli-common');
    const modulePath = resolveCliCommonDistModulePathForTests(repoRoot, 'componentArtifacts');
    mkdirSync(join(packageDir, 'dist', 'componentArtifacts'), { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli-common', type: 'module' }, null, 2));

    const execCalls = [];
    const moduleSource = 'export const rebuilt = true;\n';
    const execFileSync = (_cmd, _args, options) => {
      execCalls.push({ cmd: _cmd, args: _args, cwd: options?.cwd });
      writeFileSync(modulePath, moduleSource, 'utf8');
      return { status: 0, stdout: '', stderr: '' };
    };

    const mod = await loadCliCommonDistModule({
      repoRoot,
      subpath: 'componentArtifacts',
      execFileSync,
      importModule: async (url) => import(url),
    });

    assert.equal(mod.rebuilt, true);
    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0].cwd, repoRoot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadCliCommonDistModule admits existing cli-common output through the canonical stale-only owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-loader-stale-'));
  try {
    const repoRoot = join(root, 'repo');
    const packageDir = join(repoRoot, 'packages', 'cli-common');
    const modulePath = resolveCliCommonDistModulePathForTests(repoRoot, 'componentArtifacts');
    mkdirSync(join(packageDir, 'dist', 'componentArtifacts'), { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli-common', type: 'module' }, null, 2));
    writeFileSync(modulePath, 'export const admitted = "stale";\n', 'utf8');

    const execCalls = [];
    const execFileSync = (cmd, args, options) => {
      execCalls.push({ cmd, args, cwd: options?.cwd });
      writeFileSync(modulePath, 'export const admitted = "fresh";\n', 'utf8');
    };

    const mod = await loadCliCommonDistModule({ repoRoot, subpath: 'componentArtifacts', execFileSync });

    assert.equal(mod.admitted, 'fresh');
    assert.equal(execCalls.length, 1);
    assert.deepEqual(execCalls[0].args.slice(1), ['--declarations']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadCliCommonDistModule force-admits cli-common before importing an artifact helper', async () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-loader-force-'));
  try {
    const repoRoot = join(root, 'repo');
    const packageDir = join(repoRoot, 'packages', 'cli-common');
    const modulePath = resolveCliCommonDistModulePathForTests(repoRoot, 'componentArtifacts');
    mkdirSync(join(packageDir, 'dist', 'componentArtifacts'), { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli-common', type: 'module' }, null, 2));
    writeFileSync(modulePath, 'export const admitted = "stale";\n', 'utf8');

    const loaderCalls = [];
    const loadCliCommonWorkspacesModuleImpl = async (...args) => {
      loaderCalls.push(args);
      writeFileSync(modulePath, 'export const admitted = "artifact";\n', 'utf8');
    };

    const mod = await loadCliCommonDistModule({
      repoRoot,
      subpath: 'componentArtifacts',
      force: true,
      loadCliCommonWorkspacesModuleImpl,
      execFileSync: () => {
        throw new Error('force admission must not use the stale-only declaration build');
      },
    });

    assert.equal(mod.admitted, 'artifact');
    assert.equal(loaderCalls.length, 1);
    assert.equal(loaderCalls[0][0], repoRoot);
    assert.deepEqual(loaderCalls[0][3], {
      force: true,
      includeDevDependencies: false,
      quiet: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
