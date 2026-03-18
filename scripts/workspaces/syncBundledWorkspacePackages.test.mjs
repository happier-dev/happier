import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  rmDirSafeSync,
  sanitizeBundledWorkspacePackageJson,
  syncBundledWorkspacePackages,
} from './syncBundledWorkspacePackages.mjs';

test('sanitizeBundledWorkspacePackageJson keeps publish-time runtime fields only', () => {
  const sanitized = sanitizeBundledWorkspacePackageJson({
    name: '@happier-dev/protocol',
    version: '0.0.0',
    private: false,
    type: 'module',
    main: './dist/index.js',
    module: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js' } },
    dependencies: { zod: '^1.0.0' },
    devDependencies: { vitest: '^3.0.0' },
    scripts: { build: 'tsup' },
  });

  assert.deepEqual(sanitized, {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    private: true,
    type: 'module',
    main: './dist/index.js',
    module: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { default: './dist/index.js' } },
    dependencies: { zod: '^1.0.0' },
    peerDependencies: undefined,
    optionalDependencies: undefined,
    engines: undefined,
  });
});

test('rmDirSafeSync retries transient ENOTEMPTY errors before removing a directory', () => {
  assert.equal(typeof rmDirSafeSync, 'function');

  let calls = 0;
  rmDirSafeSync('/repo/apps/cli/node_modules/@happier-dev/agents/node_modules/zod/v4/locales', {
    rmSync() {
      calls += 1;
      if (calls <= 2) {
        const err = new Error('ENOTEMPTY');
        err.code = 'ENOTEMPTY';
        throw err;
      }
    },
    retries: 5,
    delayMs: 0,
  });

  assert.equal(calls, 3);
});

test('syncBundledWorkspacePackages updates bundled copies for every configured host app', () => {
  const cpCalls = [];
  const renameCalls = [];
  const writeCalls = [];

  syncBundledWorkspacePackages({
    repoRoot: '/repo',
    syncId: 'sync-1',
    packages: ['protocol'],
    hostApps: ['cli', 'stack'],
    existsSync: (candidate) =>
      String(candidate).includes('/packages/protocol/package.json') ||
      String(candidate).includes('/packages/protocol/dist') ||
      String(candidate).includes('/apps/cli/node_modules/@happier-dev/protocol/dist') ||
      String(candidate).includes('/apps/stack/node_modules/@happier-dev/protocol/dist') ||
      String(candidate).endsWith('/apps/cli/node_modules/@happier-dev/protocol/package.json') ||
      String(candidate).endsWith('/apps/stack/node_modules/@happier-dev/protocol/package.json'),
    mkdirSync: () => {},
    rmSync: () => {},
    cpSync: (...args) => cpCalls.push(args),
    renameSync: (...args) => renameCalls.push(args),
    readFileSync: () =>
      JSON.stringify({
        name: '@happier-dev/protocol',
        version: '0.0.0',
        type: 'module',
        exports: { '.': { default: './dist/index.js' } },
      }),
    writeFileSync: (...args) => writeCalls.push(args),
  });

  assert.equal(cpCalls.length, 2);
  assert.equal(cpCalls[0][0], '/repo/packages/protocol/dist');
  assert.equal(String(cpCalls[0][1]), '/repo/apps/cli/node_modules/@happier-dev/protocol/dist.__sync_tmp__.sync-1');
  assert.deepEqual(cpCalls[0][2], { recursive: true, force: true });
  assert.equal(cpCalls[1][0], '/repo/packages/protocol/dist');
  assert.equal(String(cpCalls[1][1]), '/repo/apps/stack/node_modules/@happier-dev/protocol/dist.__sync_tmp__.sync-1');
  assert.deepEqual(cpCalls[1][2], { recursive: true, force: true });

  assert.deepEqual(renameCalls, [
    [
      '/repo/apps/cli/node_modules/@happier-dev/protocol/dist',
      '/repo/apps/cli/node_modules/@happier-dev/protocol/dist.__sync_backup__.sync-1',
    ],
    [
      '/repo/apps/cli/node_modules/@happier-dev/protocol/dist.__sync_tmp__.sync-1',
      '/repo/apps/cli/node_modules/@happier-dev/protocol/dist',
    ],
    [
      '/repo/apps/stack/node_modules/@happier-dev/protocol/dist',
      '/repo/apps/stack/node_modules/@happier-dev/protocol/dist.__sync_backup__.sync-1',
    ],
    [
      '/repo/apps/stack/node_modules/@happier-dev/protocol/dist.__sync_tmp__.sync-1',
      '/repo/apps/stack/node_modules/@happier-dev/protocol/dist',
    ],
  ]);

  assert.equal(writeCalls.length, 2);
  assert.equal(writeCalls[0][0], '/repo/apps/cli/node_modules/@happier-dev/protocol/package.json');
  assert.equal(writeCalls[1][0], '/repo/apps/stack/node_modules/@happier-dev/protocol/package.json');
});

test('syncBundledWorkspacePackages preserves the previous bundled dist when copying a replacement fails', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-'));
  try {
    const srcDist = resolve(repoRoot, 'packages', 'cli-common', 'dist');
    const srcPackageJsonPath = resolve(repoRoot, 'packages', 'cli-common', 'package.json');
    const destDist = resolve(repoRoot, 'apps', 'stack', 'node_modules', '@happier-dev', 'cli-common', 'dist');
    const destMarkerPath = resolve(destDist, 'links.js');

    mkdirSync(srcDist, { recursive: true });
    mkdirSync(destDist, { recursive: true });
    writeFileSync(srcPackageJsonPath, JSON.stringify({
      name: '@happier-dev/cli-common',
      version: '0.0.0',
      type: 'module',
      exports: { './links': { default: './dist/links.js' } },
    }));
    writeFileSync(resolve(srcDist, 'links.js'), 'export const next = true;\n', 'utf8');
    writeFileSync(destMarkerPath, 'export const previous = true;\n', 'utf8');

    syncBundledWorkspacePackages({
      repoRoot,
      packages: ['cli-common'],
      hostApps: ['stack'],
      cpSync: (...args) => {
        if (String(args[1]).includes('.__sync_tmp__.')) {
          throw new Error('copy failed');
        }
      },
    });

    assert.equal(readFileSync(destMarkerPath, 'utf8'), 'export const previous = true;\n');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('syncBundledWorkspacePackages prunes stale bundled dist files during refresh', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-'));
  try {
    const srcDist = resolve(repoRoot, 'packages', 'protocol', 'dist');
    const srcPackageJsonPath = resolve(repoRoot, 'packages', 'protocol', 'package.json');
    const destDist = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol', 'dist');

    mkdirSync(srcDist, { recursive: true });
    mkdirSync(destDist, { recursive: true });
    writeFileSync(srcPackageJsonPath, JSON.stringify({
      name: '@happier-dev/protocol',
      version: '0.0.0',
      type: 'module',
      exports: { '.': { default: './dist/index.js' } },
    }));
    writeFileSync(resolve(srcDist, 'index.js'), 'export const fresh = true;\n', 'utf8');
    writeFileSync(resolve(destDist, 'index.js'), 'export const staleVersion = true;\n', 'utf8');
    writeFileSync(resolve(destDist, 'removed.js'), 'export const shouldDisappear = true;\n', 'utf8');

    syncBundledWorkspacePackages({
      repoRoot,
      packages: ['protocol'],
      hostApps: ['cli'],
    });

    assert.equal(readFileSync(resolve(destDist, 'index.js'), 'utf8'), 'export const fresh = true;\n');
    assert.equal(existsSync(resolve(destDist, 'removed.js')), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('syncBundledWorkspacePackages refreshes existing bundled dist directories via staged swap', () => {
  const cpCalls = [];
  const renameCalls = [];
  const rmCalls = [];

  syncBundledWorkspacePackages({
    repoRoot: '/repo',
    syncId: 'sync-1',
    packages: ['protocol'],
    hostApps: ['cli'],
    existsSync: (candidate) =>
      String(candidate).includes('/packages/protocol/package.json')
      || String(candidate).includes('/packages/protocol/dist')
      || String(candidate).includes('/apps/cli/node_modules/@happier-dev/protocol/dist')
      || String(candidate).endsWith('/apps/cli/node_modules/@happier-dev/protocol/package.json'),
    mkdirSync: () => {},
    rmSync: (...args) => rmCalls.push(args),
    renameSync: (...args) => renameCalls.push(args),
    cpSync: (...args) => cpCalls.push(args),
    readFileSync: () =>
      JSON.stringify({
        name: '@happier-dev/protocol',
        version: '0.0.0',
        type: 'module',
        exports: { '.': { default: './dist/index.js' } },
      }),
    writeFileSync: () => {},
  });

  assert.equal(cpCalls.length, 1);
  assert.deepEqual(cpCalls[0], [
    '/repo/packages/protocol/dist',
    '/repo/apps/cli/node_modules/@happier-dev/protocol/dist.__sync_tmp__.sync-1',
    { recursive: true, force: true },
  ]);
  assert.deepEqual(renameCalls, [
    [
      '/repo/apps/cli/node_modules/@happier-dev/protocol/dist',
      '/repo/apps/cli/node_modules/@happier-dev/protocol/dist.__sync_backup__.sync-1',
    ],
    [
      '/repo/apps/cli/node_modules/@happier-dev/protocol/dist.__sync_tmp__.sync-1',
      '/repo/apps/cli/node_modules/@happier-dev/protocol/dist',
    ],
  ]);
  assert.deepEqual(rmCalls, [
    ['/repo/apps/cli/node_modules/@happier-dev/protocol/dist.__sync_tmp__.sync-1', { recursive: true, force: true }],
    ['/repo/apps/cli/node_modules/@happier-dev/protocol/dist.__sync_backup__.sync-1', { recursive: true, force: true }],
    ['/repo/apps/cli/node_modules/@happier-dev/protocol/dist.__sync_backup__.sync-1', { recursive: true, force: true }],
  ]);
});

test('syncBundledWorkspacePackages removes stale staged sync directories before refreshing', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-stale-staging-'));
  try {
    const srcDist = resolve(repoRoot, 'packages', 'protocol', 'dist');
    const srcPackageJsonPath = resolve(repoRoot, 'packages', 'protocol', 'package.json');
    const destPackageDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol');
    const destDist = resolve(destPackageDir, 'dist');
    const staleTmpDir = resolve(destPackageDir, 'dist.__sync_tmp__.old-staging');
    const staleBackupDir = resolve(destPackageDir, 'dist.__sync_backup__.old-staging');

    mkdirSync(srcDist, { recursive: true });
    mkdirSync(destDist, { recursive: true });
    mkdirSync(staleTmpDir, { recursive: true });
    mkdirSync(staleBackupDir, { recursive: true });
    writeFileSync(srcPackageJsonPath, JSON.stringify({
      name: '@happier-dev/protocol',
      version: '0.0.0',
      type: 'module',
      exports: { '.': { default: './dist/index.js' } },
    }));
    writeFileSync(resolve(srcDist, 'index.js'), 'export const fresh = true;\n', 'utf8');
    writeFileSync(resolve(destDist, 'index.js'), 'export const refreshed = true;\n', 'utf8');
    writeFileSync(resolve(staleTmpDir, 'stale.js'), 'export const stale = true;\n', 'utf8');
    writeFileSync(resolve(staleBackupDir, 'backup.js'), 'export const backup = true;\n', 'utf8');

    syncBundledWorkspacePackages({
      repoRoot,
      packages: ['protocol'],
      hostApps: ['cli'],
    });

    assert.equal(existsSync(staleTmpDir), false, 'expected stale sync tmp dir to be removed during refresh');
    assert.equal(existsSync(staleBackupDir), false, 'expected stale sync backup dir to be removed during refresh');
    assert.equal(readFileSync(resolve(destDist, 'index.js'), 'utf8'), 'export const fresh = true;\n');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
