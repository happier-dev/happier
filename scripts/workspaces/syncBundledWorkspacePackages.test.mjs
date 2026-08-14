import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  bundleWorkspacePackageFallbackTransactionally,
  rmDirSafeSync,
  sanitizeBundledWorkspacePackageJson,
  syncBundledWorkspacePackages,
  vendorBundledPackageRuntimeDependenciesFallback,
} from './syncBundledWorkspacePackages.mjs';
import * as workspaceRuntimeDependencies from '../../packages/cli-common/workspaceRuntimeDependencies.mjs';

test('canonical mounted publication restores the exact prior tree after a mid-publication failure', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-mounted-publication-rollback-'));
  try {
    const stagedDir = resolve(rootDir, 'staged');
    const liveDir = resolve(rootDir, 'live');
    const rollbackDir = resolve(rootDir, 'rollback');
    mkdirSync(stagedDir, { recursive: true });
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(resolve(stagedDir, 'a.txt'), 'new-a\n');
    writeFileSync(resolve(stagedDir, 'b.txt'), 'new-b\n');
    writeFileSync(resolve(stagedDir, 'package.json'), '{"version":"next"}\n');
    writeFileSync(resolve(liveDir, 'a.txt'), 'old-a\n');
    writeFileSync(resolve(liveDir, 'b.txt'), 'old-b\n');
    writeFileSync(resolve(liveDir, 'legacy.txt'), 'legacy\n');
    writeFileSync(resolve(liveDir, 'package.json'), '{"version":"previous"}\n');

    const publishStagedDirectoryMountedSync =
      workspaceRuntimeDependencies.publishStagedDirectoryMountedSync;
    assert.equal(typeof publishStagedDirectoryMountedSync, 'function');
    assert.throws(
      () => publishStagedDirectoryMountedSync({
        stagedDir,
        liveDir,
        rollbackDir,
        pruneStale: false,
        fsOps: {
          renameSync(sourcePath, targetPath) {
            if (String(sourcePath).endsWith('/b.txt')) {
              const error = new Error('injected-mid-publication-failure');
              error.code = 'EIO';
              throw error;
            }
            renameSync(sourcePath, targetPath);
          },
        },
      }),
      /injected-mid-publication-failure/,
    );
    assert.equal(readFileSync(resolve(liveDir, 'a.txt'), 'utf8'), 'old-a\n');
    assert.equal(readFileSync(resolve(liveDir, 'b.txt'), 'utf8'), 'old-b\n');
    assert.equal(readFileSync(resolve(liveDir, 'legacy.txt'), 'utf8'), 'legacy\n');
    assert.equal(readFileSync(resolve(liveDir, 'package.json'), 'utf8'), '{"version":"previous"}\n');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('transactional fallback leaves the previous package untouched when vendoring fails', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-fallback-transaction-'));
  try {
    const srcPackageDir = resolve(repoRoot, 'packages', 'protocol');
    const destPackageDir = resolve(repoRoot, 'apps', 'stack', 'node_modules', '@happier-dev', 'protocol');
    mkdirSync(resolve(srcPackageDir, 'dist'), { recursive: true });
    mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/protocol',
        version: '0.0.0',
        type: 'module',
        exports: { '.': { default: './dist/index.js' } },
        dependencies: { 'missing-required-runtime': '1.0.0' },
      }),
    );
    writeFileSync(resolve(srcPackageDir, 'dist/index.js'), 'export const version = "next";\n');
    writeFileSync(resolve(destPackageDir, 'package.json'), JSON.stringify({ version: 'previous' }));
    writeFileSync(resolve(destPackageDir, 'dist/index.js'), 'export const version = "previous";\n');

    assert.throws(
      () => bundleWorkspacePackageFallbackTransactionally({
        srcPackageDir,
        destPackageDir,
        syncId: 'fallback-failure',
        vendorBundledPackageRuntimeDependencies() {
          throw new Error('missing-required-runtime');
        },
      }),
      /missing-required-runtime/,
    );

    assert.equal(readFileSync(resolve(destPackageDir, 'dist/index.js'), 'utf8'), 'export const version = "previous";\n');
    assert.deepEqual(JSON.parse(readFileSync(resolve(destPackageDir, 'package.json'), 'utf8')), {
      version: 'previous',
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

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
    dependencies: { zod: '^1.0.0', '@happier-dev/agents': '0.0.0' },
    optionalDependencies: { kleur: '^1.0.0', '@happier-dev/protocol': '0.0.0' },
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
    optionalDependencies: { kleur: '^1.0.0' },
    engines: undefined,
  });
});

test('syncBundledWorkspacePackages derives the default bundled workspace set from the CLI manifest', () => {
  const cpCalls = [];

  syncBundledWorkspacePackages({
    repoRoot: '/repo',
    hostApps: ['cli'],
    existsSync: (candidate) => {
      const text = String(candidate);
      return (
        text.endsWith('/apps/cli/package.json') ||
        text.endsWith('/packages/custom-bundle/package.json') ||
        text.endsWith('/packages/custom-bundle/dist') ||
        text.endsWith('/apps/cli/node_modules/@happier-dev/custom-bundle/package.json') ||
        text.endsWith('/apps/cli/node_modules/@happier-dev/custom-bundle/dist')
      );
    },
    mkdirSync: () => {},
    rmSync: () => {},
    cpSync: (...args) => cpCalls.push(args),
    renameSync: () => {},
    readFileSync: (path) => {
      const text = String(path);
      if (text.endsWith('/apps/cli/package.json')) {
        return JSON.stringify({
          bundledDependencies: ['@happier-dev/custom-bundle', 'tweetnacl'],
        });
      }

      if (text.endsWith('/packages/custom-bundle/package.json')) {
        return JSON.stringify({
          name: '@happier-dev/custom-bundle',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
        });
      }

      throw new Error(`unexpected read: ${text}`);
    },
    writeFileSync: () => {},
  });

  assert.equal(cpCalls.length, 1);
  assert.equal(cpCalls[0][0], '/repo/packages/custom-bundle/dist');
});

test('syncBundledWorkspacePackages publishes default workspace packages dependency-first', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-dependency-order-'));
  try {
    const hostPackageDir = resolve(repoRoot, 'apps', 'cli');
    const protocolPackageDir = resolve(repoRoot, 'packages', 'protocol');
    const agentsPackageDir = resolve(repoRoot, 'packages', 'agents');
    mkdirSync(resolve(protocolPackageDir, 'dist'), { recursive: true });
    mkdirSync(resolve(agentsPackageDir, 'dist'), { recursive: true });
    mkdirSync(hostPackageDir, { recursive: true });

    writeFileSync(
      resolve(hostPackageDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli',
        bundledDependencies: ['@happier-dev/agents', '@happier-dev/protocol'],
      }),
    );
    writeFileSync(
      resolve(protocolPackageDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/protocol',
        version: '0.0.0',
        type: 'module',
        exports: { '.': { default: './dist/index.js' } },
      }),
    );
    writeFileSync(resolve(protocolPackageDir, 'dist/index.js'), 'export const protocol = true;\n');
    writeFileSync(
      resolve(agentsPackageDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/agents',
        version: '0.0.0',
        type: 'module',
        exports: { '.': { default: './dist/index.js' } },
        dependencies: { '@happier-dev/protocol': '0.0.0' },
      }),
    );
    writeFileSync(resolve(agentsPackageDir, 'dist/index.js'), 'export const agents = true;\n');

    const manifestPublicationOrder = [];
    syncBundledWorkspacePackages({
      repoRoot,
      hostApps: ['cli'],
      writeFileSync(path, contents, encoding) {
        if (String(path).includes('/node_modules/@happier-dev/') && String(path).endsWith('/package.json')) {
          manifestPublicationOrder.push(JSON.parse(String(contents)).name);
        }
        return writeFileSync(path, contents, encoding);
      },
    });

    assert.deepEqual(manifestPublicationOrder, ['@happier-dev/protocol', '@happier-dev/agents']);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('syncBundledWorkspacePackages refreshes bundled dependencies for a workspace package host', () => {
  const cpCalls = [];
  const writes = [];

  syncBundledWorkspacePackages({
    repoRoot: '/repo',
    hostPackageDirs: ['/repo/packages/plugin-sdk'],
    syncId: 'plugin-sdk-sync',
    existsSync: (candidate) => {
      const text = String(candidate);
      return text.endsWith('/packages/plugin-sdk/package.json')
        || text.endsWith('/packages/protocol/package.json')
        || text.endsWith('/packages/protocol/dist');
    },
    mkdirSync: () => {},
    rmSync: () => {},
    renameSync: () => {},
    cpSync: (...args) => cpCalls.push(args),
    readFileSync: (candidate) => String(candidate).endsWith('/packages/plugin-sdk/package.json')
      ? JSON.stringify({ bundledDependencies: ['@happier-dev/protocol'] })
      : JSON.stringify({
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
        }),
    writeFileSync: (...args) => writes.push(args),
  });

  assert.equal(cpCalls.length, 1);
  assert.equal(cpCalls[0][0], '/repo/packages/protocol/dist');
  assert.equal(
    cpCalls[0][1],
    '/repo/packages/plugin-sdk/node_modules/@happier-dev/protocol/dist.__sync_tmp__.plugin-sdk-sync',
  );
  assert.equal(writes[0][0], '/repo/packages/plugin-sdk/node_modules/@happier-dev/protocol/package.json');
});

test('syncBundledWorkspacePackages syncs extension workspaces from packages/plugins/<extensionId>', () => {
  const cpCalls = [];

  syncBundledWorkspacePackages({
    repoRoot: '/repo',
    hostApps: ['cli'],
    existsSync: (candidate) => {
      const text = String(candidate);
      return (
        text.endsWith('/apps/cli/package.json') ||
        text.endsWith('/packages/plugins/acme/package.json') ||
        text.endsWith('/packages/plugins/acme/dist') ||
        text.endsWith('/apps/cli/node_modules/@happier-dev/plugins-acme/package.json') ||
        text.endsWith('/apps/cli/node_modules/@happier-dev/plugins-acme/dist')
      );
    },
    mkdirSync: () => {},
    rmSync: () => {},
    cpSync: (...args) => cpCalls.push(args),
    renameSync: () => {},
    readFileSync: (path) => {
      const text = String(path);
      if (text.endsWith('/apps/cli/package.json')) {
        return JSON.stringify({
          bundledDependencies: ['@happier-dev/plugins-acme'],
        });
      }

      if (text.endsWith('/packages/plugins/acme/package.json')) {
        return JSON.stringify({
          name: '@happier-dev/plugins-acme',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
        });
      }

      throw new Error(`unexpected read: ${text}`);
    },
    writeFileSync: () => {},
  });

  assert.equal(cpCalls.length, 1);
  assert.equal(cpCalls[0][0], '/repo/packages/plugins/acme/dist');
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

test('syncBundledWorkspacePackages retries transient source dist copy failures', () => {
  const cpCalls = [];
  const writeCalls = [];

  syncBundledWorkspacePackages({
    repoRoot: '/repo',
    packages: ['protocol'],
    hostApps: ['stack'],
    existsSync: (candidate) =>
      String(candidate).includes('/packages/protocol/package.json') ||
      String(candidate).includes('/packages/protocol/dist') ||
      String(candidate).endsWith('/apps/stack/node_modules/@happier-dev/protocol/package.json'),
    mkdirSync: () => {},
    rmSync: () => {},
    cpSync: (...args) => {
      cpCalls.push(args);
      if (cpCalls.length === 1) {
        const error = new Error('transient missing dist entry');
        error.code = 'ENOENT';
        throw error;
      }
    },
    renameSync: () => {},
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
  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0][0], '/repo/apps/stack/node_modules/@happier-dev/protocol/package.json');
});

test('syncBundledWorkspacePackages does not replace an existing dist directory when replaceExisting is false', () => {
  const cpCalls = [];
  const renameCalls = [];

  syncBundledWorkspacePackages({
    repoRoot: '/repo',
    packages: ['custom-bundle'],
    hostApps: ['cli'],
    replaceExisting: false,
    existsSync: (candidate) => {
      const text = String(candidate);
      if (text.endsWith('/apps/cli/package.json')) return true;
      if (text.endsWith('/packages/custom-bundle/package.json')) return true;
      if (text.endsWith('/packages/custom-bundle/dist')) return true;
      if (text.endsWith('/apps/cli/node_modules/@happier-dev/custom-bundle/package.json')) return true;
      if (text.endsWith('/apps/cli/node_modules/@happier-dev/custom-bundle/dist')) return true;
      return false;
    },
    readFileSync: (path) => {
      const text = String(path);
      if (text.endsWith('/apps/cli/package.json')) {
        return JSON.stringify({
          bundledDependencies: ['@happier-dev/custom-bundle'],
        });
      }
      if (text.endsWith('/packages/custom-bundle/package.json')) {
        return JSON.stringify({
          name: '@happier-dev/custom-bundle',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
        });
      }
      throw new Error(`unexpected read: ${text}`);
    },
    mkdirSync: () => {},
    rmSync: () => {},
    cpSync: (...args) => cpCalls.push(args),
    renameSync: (...args) => renameCalls.push(args),
    writeFileSync: () => {},
  });

  assert.equal(cpCalls.length, 1);
  assert.equal(renameCalls.length, 0);
});

test('syncBundledWorkspacePackages falls back to staged refresh when presence-only dist repair fails', () => {
  const cpCalls = [];
  const renameCalls = [];
  const rmCalls = [];

  syncBundledWorkspacePackages({
    repoRoot: '/repo',
    syncId: 'presence-fallback',
    packages: ['custom-bundle'],
    hostApps: ['cli'],
    replaceExisting: false,
    existsSync: (candidate) => {
      const text = String(candidate);
      if (text.endsWith('/apps/cli/package.json')) return true;
      if (text.endsWith('/packages/custom-bundle/package.json')) return true;
      if (text.endsWith('/packages/custom-bundle/dist')) return true;
      if (text.endsWith('/apps/cli/node_modules/@happier-dev/custom-bundle/package.json')) return true;
      if (text.endsWith('/apps/cli/node_modules/@happier-dev/custom-bundle/dist')) return true;
      return false;
    },
    readFileSync: (path) => {
      const text = String(path);
      if (text.endsWith('/apps/cli/package.json')) {
        return JSON.stringify({
          bundledDependencies: ['@happier-dev/custom-bundle'],
        });
      }
      if (text.endsWith('/packages/custom-bundle/package.json')) {
        return JSON.stringify({
          name: '@happier-dev/custom-bundle',
          version: '0.0.0',
          type: 'module',
          exports: { './agent/contributions/runtime': { default: './dist/agent/contributions/runtime.js' } },
        });
      }
      throw new Error(`unexpected read: ${text}`);
    },
    mkdirSync: () => {},
    rmSync: (...args) => rmCalls.push(args),
    renameSync: (...args) => renameCalls.push(args),
    cpSync: (...args) => {
      cpCalls.push(args);
      if (String(args[1]).endsWith('/apps/cli/node_modules/@happier-dev/custom-bundle/dist')) {
        const error = new Error('transient in-place copy failure');
        error.code = 'ENOENT';
        throw error;
      }
    },
    writeFileSync: () => {},
  });

  assert.equal(cpCalls.length, 7);
  assert.deepEqual(cpCalls.slice(0, 6), Array.from({ length: 6 }, () => [
    '/repo/packages/custom-bundle/dist',
    '/repo/apps/cli/node_modules/@happier-dev/custom-bundle/dist',
    { recursive: true, force: true },
  ]));
  assert.deepEqual(cpCalls[6], [
    '/repo/packages/custom-bundle/dist',
    '/repo/apps/cli/node_modules/@happier-dev/custom-bundle/dist.__sync_tmp__.presence-fallback',
    { recursive: true, force: true },
  ]);
  assert.deepEqual(renameCalls, [
    [
      '/repo/apps/cli/node_modules/@happier-dev/custom-bundle/dist',
      '/repo/apps/cli/node_modules/@happier-dev/custom-bundle/dist.__sync_backup__.presence-fallback',
    ],
    [
      '/repo/apps/cli/node_modules/@happier-dev/custom-bundle/dist.__sync_tmp__.presence-fallback',
      '/repo/apps/cli/node_modules/@happier-dev/custom-bundle/dist',
    ],
  ]);
  assert.deepEqual(rmCalls, [
    [
      '/repo/apps/cli/node_modules/@happier-dev/custom-bundle/dist.__sync_tmp__.presence-fallback',
      { recursive: true, force: true },
    ],
    [
      '/repo/apps/cli/node_modules/@happier-dev/custom-bundle/dist.__sync_backup__.presence-fallback',
      { recursive: true, force: true },
    ],
    [
      '/repo/apps/cli/node_modules/@happier-dev/custom-bundle/dist.__sync_backup__.presence-fallback',
      { recursive: true, force: true },
    ],
  ]);
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
      existsSync: existsSync.bind(null),
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

test('syncBundledWorkspacePackages uses the canonical workspace copy helper when cli-common is built', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-canonical-copy-'));
  try {
    const srcDist = resolve(repoRoot, 'packages', 'protocol', 'dist');
    const srcPackageJsonPath = resolve(repoRoot, 'packages', 'protocol', 'package.json');
    const destDist = resolve(repoRoot, 'apps', 'stack', 'node_modules', '@happier-dev', 'protocol', 'dist');

    mkdirSync(srcDist, { recursive: true });
    writeFileSync(srcPackageJsonPath, JSON.stringify({
      name: '@happier-dev/protocol',
      version: '0.0.0',
      type: 'module',
      exports: { '.': { default: './dist/index.js' } },
    }));
    writeFileSync(resolve(srcDist, 'index.js'), 'export const fresh = true;\n', 'utf8');

    syncBundledWorkspacePackages({
      repoRoot,
      packages: ['protocol'],
      hostApps: ['stack'],
      cpSync: () => {
        throw new Error('native copy path should not be used when cli-common helper is available');
      },
    });

    assert.equal(readFileSync(resolve(destDist, 'index.js'), 'utf8'), 'export const fresh = true;\n');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('syncBundledWorkspacePackages uses mounted canonical publication for presence-only repairs', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-canonical-presence-'));
  try {
    const srcPackageDir = resolve(repoRoot, 'packages', 'protocol');
    const srcDist = resolve(srcPackageDir, 'dist');
    const srcPackageJsonPath = resolve(srcPackageDir, 'package.json');
    const destPackageDir = resolve(repoRoot, 'apps', 'stack', 'node_modules', '@happier-dev', 'protocol');
    const destDist = resolve(destPackageDir, 'dist');

    mkdirSync(srcDist, { recursive: true });
    mkdirSync(destDist, { recursive: true });
    writeFileSync(srcPackageJsonPath, JSON.stringify({
      name: '@happier-dev/protocol',
      version: '0.0.0',
      type: 'module',
      exports: { '.': { default: './dist/index.js' } },
    }));
    writeFileSync(resolve(srcDist, 'index.js'), 'export const version = "next";\n', 'utf8');
    writeFileSync(resolve(destPackageDir, 'package.json'), '{}\n', 'utf8');
    writeFileSync(resolve(destDist, 'index.js'), 'export const version = "previous";\n', 'utf8');
    writeFileSync(resolve(destDist, 'legacy.js'), 'export const legacy = true;\n', 'utf8');
    const liveDirectoryInode = statSync(destPackageDir).ino;
    const previousPackageJsonInode = statSync(resolve(destPackageDir, 'package.json')).ino;

    syncBundledWorkspacePackages({
      repoRoot,
      packages: ['protocol'],
      hostApps: ['stack'],
      replaceExisting: false,
      cpSync: () => {
        throw new Error('presence-only production path should use canonical mounted publication');
      },
    });

    assert.equal(statSync(destPackageDir).ino, liveDirectoryInode);
    assert.notEqual(statSync(resolve(destPackageDir, 'package.json')).ino, previousPackageJsonInode);
    assert.equal(readFileSync(resolve(destDist, 'index.js'), 'utf8'), 'export const version = "next";\n');
    assert.equal(readFileSync(resolve(destDist, 'legacy.js'), 'utf8'), 'export const legacy = true;\n');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('syncBundledWorkspacePackages exactly reconciles generated plugin artifacts when requested', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-'));
  try {
    const srcDist = resolve(repoRoot, 'packages', 'plugins', 'codex', 'dist');
    const srcPackageJsonPath = resolve(repoRoot, 'packages', 'plugins', 'codex', 'package.json');
    const destPackageDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'plugins-codex');
    const destDist = resolve(destPackageDir, 'dist');
    const staleRootPath = resolve(destPackageDir, 'obsolete-runtime-root.js');
    const staleChunkPath = resolve(destDist, '.happier-chunks', 'chunk-2DIVYW5Y.js');

    mkdirSync(srcDist, { recursive: true });
    mkdirSync(resolve(srcDist, '.happier-chunks'), { recursive: true });
    mkdirSync(destDist, { recursive: true });
    writeFileSync(srcPackageJsonPath, JSON.stringify({
      name: '@happier-dev/plugins-codex',
      version: '0.0.0',
      type: 'module',
      exports: { '.': { default: './dist/index.js' } },
    }));
    writeFileSync(resolve(srcDist, 'index.js'), 'export const fresh = true;\n', 'utf8');
    writeFileSync(
      resolve(srcDist, '.happier-chunks', 'chunk-ZIDEGITN.js'),
      'export const currentChunk = true;\n',
      'utf8',
    );
    writeFileSync(resolve(destDist, 'index.js'), 'export const staleVersion = true;\n', 'utf8');
    mkdirSync(resolve(destDist, '.happier-chunks'), { recursive: true });
    writeFileSync(staleRootPath, 'export const staleRoot = true;\n', 'utf8');
    writeFileSync(staleChunkPath, 'export const staleChunk = true;\n', 'utf8');
    const liveDirectoryInode = statSync(destPackageDir).ino;

    syncBundledWorkspacePackages({
      repoRoot,
      packages: ['plugins-codex'],
      hostApps: ['cli'],
      pruneStale: true,
    });

    assert.equal(statSync(destPackageDir).ino, liveDirectoryInode);
    assert.equal(readFileSync(resolve(destDist, 'index.js'), 'utf8'), 'export const fresh = true;\n');
    assert.equal(existsSync(resolve(destDist, '.happier-chunks', 'chunk-ZIDEGITN.js')), true);
    assert.equal(existsSync(staleRootPath), false);
    assert.equal(existsSync(staleChunkPath), false);
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
    const staleAt = new Date(Date.now() - 120_000);
    utimesSync(staleTmpDir, staleAt, staleAt);
    utimesSync(staleBackupDir, staleAt, staleAt);

    syncBundledWorkspacePackages({
      repoRoot,
      packages: ['protocol'],
      hostApps: ['cli'],
      staleSwapDirAgeMs: 1_000,
    });

    assert.equal(existsSync(staleTmpDir), false, 'expected stale sync tmp dir to be removed during refresh');
    assert.equal(existsSync(staleBackupDir), false, 'expected stale sync backup dir to be removed during refresh');
    assert.equal(readFileSync(resolve(destDist, 'index.js'), 'utf8'), 'export const fresh = true;\n');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('syncBundledWorkspacePackages preserves fresh staged sync directories owned by another live process', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-live-staging-'));
  try {
    const srcDist = resolve(repoRoot, 'packages', 'protocol', 'dist');
    const srcPackageJsonPath = resolve(repoRoot, 'packages', 'protocol', 'package.json');
    const destPackageDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol');
    const destDist = resolve(destPackageDir, 'dist');
    const liveTmpDir = resolve(destPackageDir, 'dist.__sync_tmp__.12345.1');

    mkdirSync(srcDist, { recursive: true });
    mkdirSync(destDist, { recursive: true });
    mkdirSync(liveTmpDir, { recursive: true });
    writeFileSync(srcPackageJsonPath, JSON.stringify({
      name: '@happier-dev/protocol',
      version: '0.0.0',
      type: 'module',
      exports: { '.': { default: './dist/index.js' } },
    }));
    writeFileSync(resolve(srcDist, 'index.js'), 'export const fresh = true;\n', 'utf8');
    writeFileSync(resolve(destDist, 'index.js'), 'export const refreshed = true;\n', 'utf8');
    writeFileSync(resolve(liveTmpDir, 'in-flight.js'), 'export const inFlight = true;\n', 'utf8');

    syncBundledWorkspacePackages({
      repoRoot,
      packages: ['protocol'],
      hostApps: ['cli'],
      staleSwapDirAgeMs: 120_000,
      isPidAlive: (pid) => pid === 12345,
    });

    assert.equal(existsSync(liveTmpDir), true, 'expected fresh staging dir for another live process to be preserved');
    assert.equal(readFileSync(resolve(destDist, 'index.js'), 'utf8'), 'export const fresh = true;\n');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('syncBundledWorkspacePackages syncs non-dist exported file targets referenced by package.json', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-extra-files-'));
  try {
    const srcPackageDir = resolve(repoRoot, 'packages', 'release-runtime');
    const srcDist = resolve(srcPackageDir, 'dist');
    const srcPackageJsonPath = resolve(srcPackageDir, 'package.json');
    const srcExtra = resolve(srcPackageDir, 'releaseRings.cjs');

    mkdirSync(srcDist, { recursive: true });
    mkdirSync(resolve(repoRoot, 'apps', 'cli'), { recursive: true });
    writeFileSync(resolve(srcDist, 'index.js'), 'export const ok = true;\n', 'utf8');
    writeFileSync(srcExtra, 'module.exports = { ring: \"stable\" };\n', 'utf8');
    writeFileSync(srcPackageJsonPath, JSON.stringify({
      name: '@happier-dev/release-runtime',
      version: '0.0.0',
      type: 'module',
      exports: {
        '.': { default: './dist/index.js' },
        './releaseRings': { require: './releaseRings.cjs', default: './dist/index.js' },
      },
    }));

    syncBundledWorkspacePackages({
      repoRoot,
      packages: ['release-runtime'],
      hostApps: ['cli'],
    });

    const destExtra = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'release-runtime', 'releaseRings.cjs');
    assert.equal(existsSync(destExtra), true);
    assert.equal(readFileSync(destExtra, 'utf8'), 'module.exports = { ring: \"stable\" };\n');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('syncBundledWorkspacePackages publishes cli-common package-root helpers consumed by compiled modules', async () => {
  const sourceRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const testTempRoot = resolve(sourceRepoRoot, '.project', 'tmp');
  mkdirSync(testTempRoot, { recursive: true });
  const hostPackageDir = mkdtempSync(join(testTempRoot, 'happier-sync-bundled-cli-common-helper-'));
  const bundledPackageDir = resolve(hostPackageDir, 'node_modules', '@happier-dev', 'cli-common');
  try {
    syncBundledWorkspacePackages({
      repoRoot: sourceRepoRoot,
      packages: ['cli-common'],
      hostPackageDirs: [hostPackageDir],
    });

    const bundledHelperPath = resolve(bundledPackageDir, 'workspaceChildBuildEnv.mjs');
    assert.equal(
      existsSync(bundledHelperPath),
      true,
      'canonical publication must include the package-root helper imported by compiled component artifacts',
    );
    assert.equal(
      existsSync(resolve(bundledPackageDir, 'workspaceChildBuildEnv.d.mts')),
      true,
      'canonical publication must include the helper declaration target exposed by the package',
    );
    const bundledHelper = await import(
      `${pathToFileURL(bundledHelperPath).href}?bundled-cli-common-helper-direct=${Date.now()}`
    );
    assert.equal(typeof bundledHelper.createWorkspaceChildBuildEnv, 'function');

    const bundledComponentArtifacts = await import(
      `${pathToFileURL(resolve(
        bundledPackageDir,
        'dist',
        'componentArtifacts',
        'buildCliBinaryArtifactPayload.js',
      )).href}?bundled-cli-common-helper=${Date.now()}`
    );
    assert.equal(typeof bundledComponentArtifacts.buildCliBinaryArtifactPayload, 'function');
  } finally {
    rmSync(hostPackageDir, { recursive: true, force: true });
  }
});

test('syncBundledWorkspacePackages installs exported targets before publishing their package manifest', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-publication-order-'));
  try {
    const srcPackageDir = resolve(repoRoot, 'packages', 'cli-common');
    const srcDist = resolve(srcPackageDir, 'dist');
    const srcPackageJsonPath = resolve(srcPackageDir, 'package.json');
    const srcExtra = resolve(srcPackageDir, 'cliDistBuildManifest.cjs');
    const hostPackageDir = resolve(repoRoot, 'apps', 'cli');
    const destPackageDir = resolve(hostPackageDir, 'node_modules', '@happier-dev', 'cli-common');
    const destExtra = resolve(destPackageDir, 'cliDistBuildManifest.cjs');

    mkdirSync(srcDist, { recursive: true });
    mkdirSync(hostPackageDir, { recursive: true });
    writeFileSync(resolve(srcDist, 'index.js'), 'export const ok = true;\n', 'utf8');
    writeFileSync(srcExtra, 'module.exports = { valid: true };\n', 'utf8');
    writeFileSync(srcPackageJsonPath, JSON.stringify({
      name: '@happier-dev/cli-common',
      version: '0.0.0',
      type: 'module',
      exports: {
        '.': { default: './dist/index.js' },
        './cliDistBuildManifest': { require: './cliDistBuildManifest.cjs' },
      },
    }));

    let exportedTargetExistedWhenManifestWasPublished = false;
    syncBundledWorkspacePackages({
      repoRoot,
      packages: ['cli-common'],
      hostApps: ['cli'],
      writeFileSync(path, contents, encoding) {
        if (path === resolve(destPackageDir, 'package.json')) {
          exportedTargetExistedWhenManifestWasPublished = existsSync(destExtra);
        }
        return writeFileSync(path, contents, encoding);
      },
    });

    assert.equal(exportedTargetExistedWhenManifestWasPublished, true);
    assert.equal(readFileSync(destExtra, 'utf8'), 'module.exports = { valid: true };\n');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('syncBundledWorkspacePackages does not publish a manifest when required runtime vendoring fails', () => {
  const writes = [];

  syncBundledWorkspacePackages({
    repoRoot: '/repo',
    packages: ['protocol'],
    hostApps: ['stack'],
    existsSync: (candidate) => String(candidate).endsWith('/packages/protocol/package.json'),
    mkdirSync: () => {},
    readFileSync: () => JSON.stringify({
      name: '@happier-dev/protocol',
      version: '0.0.0',
      type: 'module',
      exports: { '.': { default: './dist/index.js' } },
      dependencies: { 'required-runtime': '1.0.0' },
    }),
    writeFileSync: (...args) => writes.push(args),
    vendorBundledPackageRuntimeDependencies(options) {
      assert.equal(options.dereferenceRootDir, '/repo');
      throw new Error('required runtime dependency is unavailable');
    },
  });

  assert.deepEqual(writes, []);
});

test('syncBundledWorkspacePackages fails closed without mutating the live package when canonical bundling fails', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-canonical-failure-'));
  try {
    const srcPackageDir = resolve(repoRoot, 'packages', 'protocol');
    const destPackageDir = resolve(repoRoot, 'apps', 'stack', 'node_modules', '@happier-dev', 'protocol');
    mkdirSync(resolve(srcPackageDir, 'dist'), { recursive: true });
    mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
    writeFileSync(
      resolve(srcPackageDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/protocol',
        version: '0.0.0',
        type: 'module',
        exports: { '.': { default: './dist/index.js' } },
        dependencies: { 'missing-required-runtime': '1.0.0' },
      }),
    );
    writeFileSync(resolve(srcPackageDir, 'dist/index.js'), 'export const version = "next";\n');
    writeFileSync(
      resolve(destPackageDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/protocol',
        version: '0.0.0',
        type: 'module',
        exports: { '.': { default: './dist/index.js' } },
      }),
    );
    writeFileSync(resolve(destPackageDir, 'dist/index.js'), 'export const version = "previous";\n');

    assert.throws(
      () => syncBundledWorkspacePackages({ repoRoot, packages: ['protocol'], hostApps: ['stack'] }),
      /missing-required-runtime/,
    );
    assert.equal(readFileSync(resolve(destPackageDir, 'dist/index.js'), 'utf8'), 'export const version = "previous";\n');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('syncBundledWorkspacePackages restores vendored runtime dependency trees under the bundled package', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-runtime-deps-'));
  try {
    const srcPackageDir = resolve(repoRoot, 'packages', 'protocol');
    const srcDist = resolve(srcPackageDir, 'dist');
    const srcPackageJsonPath = resolve(srcPackageDir, 'package.json');
    const depADir = resolve(srcPackageDir, 'node_modules', 'dep-a');
    const depBDir = resolve(depADir, 'node_modules', 'dep-b');
    const destPackageDir = resolve(repoRoot, 'apps', 'stack', 'node_modules', '@happier-dev', 'protocol');

    mkdirSync(srcDist, { recursive: true });
    mkdirSync(depBDir, { recursive: true });
    writeFileSync(resolve(srcDist, 'index.js'), 'export const ok = true;\n', 'utf8');
    writeFileSync(srcPackageJsonPath, JSON.stringify({
      name: '@happier-dev/protocol',
      version: '0.0.0',
      type: 'module',
      exports: { '.': { default: './dist/index.js' } },
      dependencies: {
        'dep-a': '^1.0.0',
      },
    }));
    writeFileSync(resolve(depADir, 'package.json'), JSON.stringify({
      name: 'dep-a',
      version: '1.0.0',
      main: 'index.js',
      dependencies: {
        'dep-b': '^1.0.0',
      },
    }));
    writeFileSync(resolve(depADir, 'index.js'), 'module.exports = { a: true };\n', 'utf8');
    writeFileSync(resolve(depBDir, 'package.json'), JSON.stringify({
      name: 'dep-b',
      version: '1.0.0',
      main: 'index.js',
    }));
    writeFileSync(resolve(depBDir, 'index.js'), 'module.exports = { b: true };\n', 'utf8');

    syncBundledWorkspacePackages({
      repoRoot,
      packages: ['protocol'],
      hostApps: ['stack'],
    });

    assert.equal(
      JSON.parse(readFileSync(resolve(destPackageDir, 'node_modules', 'dep-a', 'package.json'), 'utf8')).name,
      'dep-a',
    );
    assert.equal(
      JSON.parse(
        readFileSync(resolve(destPackageDir, 'node_modules', 'dep-a', 'node_modules', 'dep-b', 'package.json'), 'utf8'),
      ).name,
      'dep-b',
    );

  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('vendorBundledPackageRuntimeDependenciesFallback vendors runtime dependencies without cli-common dist helpers', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-runtime-deps-fallback-'));
  try {
    const srcPackageDir = resolve(repoRoot, 'packages', 'protocol');
    const srcDist = resolve(srcPackageDir, 'dist');
    const srcPackageJsonPath = resolve(srcPackageDir, 'package.json');
    const depADir = resolve(srcPackageDir, 'node_modules', 'dep-a');
    const depBDir = resolve(depADir, 'node_modules', 'dep-b');
    const destPackageDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol');

    mkdirSync(srcDist, { recursive: true });
    mkdirSync(depBDir, { recursive: true });
    writeFileSync(resolve(srcDist, 'index.js'), 'export const ok = true;\n', 'utf8');
    writeFileSync(srcPackageJsonPath, JSON.stringify({
      name: '@happier-dev/protocol',
      version: '0.0.0',
      type: 'module',
      exports: { '.': { default: './dist/index.js' } },
      dependencies: {
        'dep-a': '^1.0.0',
      },
      optionalDependencies: {
        '@happier-dev/agents': '0.0.0',
      },
    }));
    writeFileSync(resolve(depADir, 'package.json'), JSON.stringify({
      name: 'dep-a',
      version: '1.0.0',
      main: 'index.js',
      dependencies: {
        'dep-b': '^1.0.0',
      },
    }));
    writeFileSync(resolve(depADir, 'index.js'), 'module.exports = { a: true };\n', 'utf8');
    writeFileSync(resolve(depBDir, 'package.json'), JSON.stringify({
      name: 'dep-b',
      version: '1.0.0',
      main: 'index.js',
    }));
    writeFileSync(resolve(depBDir, 'index.js'), 'module.exports = { b: true };\n', 'utf8');

    syncBundledWorkspacePackages({
      repoRoot,
      packages: ['protocol'],
      hostApps: ['cli'],
      vendorBundledPackageRuntimeDependencies: vendorBundledPackageRuntimeDependenciesFallback,
    });

    assert.equal(
      JSON.parse(readFileSync(resolve(destPackageDir, 'package.json'), 'utf8')).dependencies['@happier-dev/agents'],
      undefined,
    );
    assert.equal(
      JSON.parse(readFileSync(resolve(destPackageDir, 'node_modules', 'dep-a', 'package.json'), 'utf8')).name,
      'dep-a',
    );
    assert.equal(
      JSON.parse(
        readFileSync(resolve(destPackageDir, 'node_modules', 'dep-a', 'node_modules', 'dep-b', 'package.json'), 'utf8'),
      ).name,
      'dep-b',
    );

    const destNodeModulesDir = resolve(destPackageDir, 'node_modules');
    const liveDirectoryInode = statSync(destNodeModulesDir).ino;
    const priorTargetPath = resolve(destNodeModulesDir, 'dep-a', 'prior-target.js');
    writeFileSync(priorTargetPath, 'module.exports = "prior";\n');
    writeFileSync(resolve(depADir, 'index.js'), 'module.exports = { a: "updated" };\n', 'utf8');

    vendorBundledPackageRuntimeDependenciesFallback({
      srcPackageJsonPath,
      destPackageDir,
    });

    assert.equal(
      statSync(destNodeModulesDir).ino,
      liveDirectoryInode,
      'runtime dependency refresh must not rename the live node_modules directory away',
    );
    assert.equal(
      readFileSync(resolve(destNodeModulesDir, 'dep-a', 'index.js'), 'utf8'),
      'module.exports = { a: "updated" };\n',
    );
    assert.equal(
      readFileSync(priorTargetPath, 'utf8'),
      'module.exports = "prior";\n',
      'live fallback publication must retain prior unstaged targets',
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('no-dist bootstrap automatically delegates canonical vendoring with rollback and exported runtime ownership', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-no-dist-bootstrap-'));
  const sourceRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  try {
    const workspaceScriptsDir = resolve(repoRoot, 'scripts', 'workspaces');
    const srcPackageDir = resolve(repoRoot, 'packages', 'cli-common');
    const srcPackageJsonPath = resolve(srcPackageDir, 'package.json');
    const destPackageDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common');
    const canonicalRuntimeModulePath = resolve(srcPackageDir, 'workspaceRuntimeDependencies.mjs');
    mkdirSync(workspaceScriptsDir, { recursive: true });
    mkdirSync(resolve(srcPackageDir, 'dist'), { recursive: true });
    mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
    mkdirSync(resolve(repoRoot, 'node_modules'), { recursive: true });
    for (const file of [
      'syncBundledWorkspacePackages.mjs',
      'vendorBundledWorkspaceRuntimeDependenciesFallback.mjs',
    ]) {
      cpSync(resolve(sourceRepoRoot, 'scripts', 'workspaces', file), resolve(workspaceScriptsDir, file));
    }
    cpSync(
      resolve(sourceRepoRoot, 'packages', 'cli-common', 'workspaceRuntimeDependencies.mjs'),
      canonicalRuntimeModulePath,
    );
    cpSync(
      resolve(sourceRepoRoot, 'node_modules', 'semver'),
      resolve(repoRoot, 'node_modules', 'semver'),
      { recursive: true },
    );
    writeFileSync(resolve(srcPackageDir, 'dist', 'index.js'), 'export const current = true;\n');
    writeFileSync(resolve(destPackageDir, 'dist', 'index.js'), 'export const previous = true;\n');
    writeFileSync(resolve(destPackageDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli-common',
      version: 'previous',
    }));
    writeFileSync(srcPackageJsonPath, JSON.stringify({
      name: '@happier-dev/cli-common',
      version: '0.0.0',
      type: 'module',
      exports: {
        '.': './dist/index.js',
        './workspaceRuntimeDependencies': './workspaceRuntimeDependencies.mjs',
      },
      dependencies: { 'missing-runtime': '^1.0.0' },
    }));

    const sandboxSyncModule = await import(
      `${pathToFileURL(resolve(workspaceScriptsDir, 'syncBundledWorkspacePackages.mjs')).href}`
        + `?no-dist-bootstrap=${Date.now()}`
    );
    assert.throws(
      () => sandboxSyncModule.syncBundledWorkspacePackages({
        repoRoot,
        packages: ['cli-common'],
        hostApps: ['cli'],
      }),
      /missing-runtime/,
    );
    assert.equal(readFileSync(resolve(destPackageDir, 'dist', 'index.js'), 'utf8'), 'export const previous = true;\n');
    assert.equal(JSON.parse(readFileSync(resolve(destPackageDir, 'package.json'), 'utf8')).version, 'previous');

    const depADir = resolve(srcPackageDir, 'node_modules', 'dep-a');
    const depBDir = resolve(srcPackageDir, 'node_modules', 'dep-b');
    mkdirSync(depADir, { recursive: true });
    mkdirSync(depBDir, { recursive: true });
    writeFileSync(resolve(depADir, 'package.json'), JSON.stringify({
      name: 'dep-a',
      version: '1.0.0',
      dependencies: { 'dep-b': '^1.0.0' },
    }));
    writeFileSync(resolve(depBDir, 'package.json'), JSON.stringify({
      name: 'dep-b',
      version: '1.0.0',
    }));
    writeFileSync(srcPackageJsonPath, JSON.stringify({
      name: '@happier-dev/cli-common',
      version: '0.0.0',
      type: 'module',
      exports: {
        '.': './dist/index.js',
        './workspaceRuntimeDependencies': './workspaceRuntimeDependencies.mjs',
      },
      dependencies: {
        semver: '*',
        'dep-a': '^1.0.0',
      },
    }));

    sandboxSyncModule.syncBundledWorkspacePackages({
      repoRoot,
      packages: ['cli-common'],
      hostApps: ['cli'],
    });

    assert.equal(
      JSON.parse(readFileSync(
        resolve(destPackageDir, 'node_modules', 'dep-a', 'node_modules', 'dep-b', 'package.json'),
        'utf8',
      )).name,
      'dep-b',
    );
    const bundledRuntimeOwner = await import(
      `${pathToFileURL(resolve(destPackageDir, 'workspaceRuntimeDependencies.mjs')).href}`
        + `?bundled-owner=${Date.now()}`
    );
    assert.deepEqual(
      bundledRuntimeOwner.collectExternalRuntimeDependencies({
        dependencies: { semver: '*' },
      }),
      [{ name: 'semver', optional: false, declaredSpec: '*' }],
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('explicit fresh workspaces helpers override a stale top-level helper during final publication', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-fresh-helper-'));
  const sourceRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  try {
    const workspaceScriptsDir = resolve(repoRoot, 'scripts', 'workspaces');
    const cliCommonDir = resolve(repoRoot, 'packages', 'cli-common');
    const cliCommonWorkspacesDir = resolve(cliCommonDir, 'dist', 'workspaces');
    const cliDir = resolve(repoRoot, 'apps', 'cli');
    const destPackageDir = resolve(cliDir, 'node_modules', '@happier-dev', 'cli-common');
    mkdirSync(workspaceScriptsDir, { recursive: true });
    mkdirSync(cliCommonWorkspacesDir, { recursive: true });
    mkdirSync(cliDir, { recursive: true });
    mkdirSync(resolve(repoRoot, 'node_modules'), { recursive: true });
    for (const file of [
      'syncBundledWorkspacePackages.mjs',
      'vendorBundledWorkspaceRuntimeDependenciesFallback.mjs',
    ]) {
      cpSync(resolve(sourceRepoRoot, 'scripts', 'workspaces', file), resolve(workspaceScriptsDir, file));
    }
    cpSync(
      resolve(sourceRepoRoot, 'packages', 'cli-common', 'workspaceRuntimeDependencies.mjs'),
      resolve(cliCommonDir, 'workspaceRuntimeDependencies.mjs'),
    );
    cpSync(
      resolve(sourceRepoRoot, 'node_modules', 'semver'),
      resolve(repoRoot, 'node_modules', 'semver'),
      { recursive: true },
    );
    writeFileSync(resolve(cliCommonDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli-common',
      type: 'module',
    }));
    writeFileSync(resolve(cliCommonDir, 'dist', 'index.js'), 'export const current = true;\n');
    writeFileSync(resolve(cliCommonWorkspacesDir, 'index.js'), `
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
export function bundleWorkspacePackageWithRuntimeDependencies({ destDir }) {
  mkdirSync(destDir, { recursive: true });
  writeFileSync(resolve(destDir, 'helper-generation.txt'), 'stale\\n');
}
`);
    writeFileSync(resolve(cliDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      bundledDependencies: ['@happier-dev/cli-common'],
    }));

    const sandboxSyncModule = await import(
      `${pathToFileURL(resolve(workspaceScriptsDir, 'syncBundledWorkspacePackages.mjs')).href}`
        + `?stale-helper=${Date.now()}`
    );
    const freshHelpers = {
      bundleWorkspacePackageWithRuntimeDependencies({ destDir }) {
        mkdirSync(destDir, { recursive: true });
        writeFileSync(resolve(destDir, 'helper-generation.txt'), 'fresh\n');
      },
    };

    sandboxSyncModule.syncBundledWorkspacePackages({
      repoRoot,
      packages: ['cli-common'],
      hostApps: ['cli'],
      cliCommonWorkspacesModule: freshHelpers,
    });

    assert.equal(
      readFileSync(resolve(destPackageDir, 'helper-generation.txt'), 'utf8'),
      'fresh\n',
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('vendorBundledPackageRuntimeDependenciesFallback removes an empty dependency directory', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-empty-runtime-deps-fallback-'));
  try {
    const srcPackageDir = resolve(repoRoot, 'packages', 'plugins-review');
    const srcPackageJsonPath = resolve(srcPackageDir, 'package.json');
    const destPackageDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'plugins-review');

    mkdirSync(srcPackageDir, { recursive: true });
    mkdirSync(resolve(destPackageDir, 'node_modules'), { recursive: true });
    writeFileSync(srcPackageJsonPath, JSON.stringify({
      name: '@happier-dev/plugins-review',
      version: '0.0.0',
      type: 'module',
      dependencies: {},
    }));

    vendorBundledPackageRuntimeDependenciesFallback({
      srcPackageJsonPath,
      destPackageDir,
    });

    assert.equal(existsSync(resolve(destPackageDir, 'node_modules')), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('vendorBundledPackageRuntimeDependenciesFallback rejects a dependency resolved outside its approved root', () => {
  const ancestorRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-fallback-outside-'));
  try {
    const repoRoot = resolve(ancestorRoot, 'repository');
    const srcPackageDir = resolve(repoRoot, 'packages', 'protocol');
    const srcPackageJsonPath = resolve(srcPackageDir, 'package.json');
    const outsidePackageDir = resolve(ancestorRoot, 'node_modules', 'outside-dep');
    const destPackageDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol');
    mkdirSync(srcPackageDir, { recursive: true });
    mkdirSync(outsidePackageDir, { recursive: true });
    writeFileSync(srcPackageJsonPath, JSON.stringify({
      name: '@happier-dev/protocol',
      version: '0.0.0',
      dependencies: { 'outside-dep': '^1.0.0' },
    }));
    writeFileSync(resolve(outsidePackageDir, 'package.json'), JSON.stringify({
      name: 'outside-dep',
      version: '1.0.0',
      main: 'index.js',
    }));
    writeFileSync(resolve(outsidePackageDir, 'index.js'), 'module.exports = true;\n');

    assert.throws(
      () => vendorBundledPackageRuntimeDependenciesFallback({
        srcPackageJsonPath,
        destPackageDir,
        dereferenceRootDir: repoRoot,
      }),
      /resolved runtime dependency outside-dep.*outside.*approved root/i,
    );
    assert.equal(existsSync(resolve(destPackageDir, 'node_modules', 'outside-dep')), false);
  } finally {
    rmSync(ancestorRoot, { recursive: true, force: true });
  }
});

test('vendorBundledPackageRuntimeDependenciesFallback rejects an npm alias with the wrong installed identity', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-fallback-alias-'));
  try {
    const srcPackageDir = resolve(repoRoot, 'packages', 'protocol');
    const srcPackageJsonPath = resolve(srcPackageDir, 'package.json');
    const aliasPackageDir = resolve(srcPackageDir, 'node_modules', 'alias-dep');
    const destPackageDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol');
    mkdirSync(aliasPackageDir, { recursive: true });
    writeFileSync(srcPackageJsonPath, JSON.stringify({
      name: '@happier-dev/protocol',
      version: '0.0.0',
      dependencies: { 'alias-dep': 'npm:real-dep@^2.0.0' },
    }));
    writeFileSync(resolve(aliasPackageDir, 'package.json'), JSON.stringify({
      name: 'wrong-dep',
      version: '2.1.0',
      main: 'index.js',
    }));
    writeFileSync(resolve(aliasPackageDir, 'index.js'), 'module.exports = true;\n');

    assert.throws(
      () => vendorBundledPackageRuntimeDependenciesFallback({
        srcPackageJsonPath,
        destPackageDir,
        dereferenceRootDir: repoRoot,
      }),
      /resolved runtime dependency alias-dep has package identity wrong-dep; expected real-dep/i,
    );
    assert.equal(existsSync(resolve(destPackageDir, 'node_modules', 'alias-dep')), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('vendorBundledPackageRuntimeDependenciesFallback preserves a valid npm alias package', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-fallback-valid-alias-'));
  try {
    const srcPackageDir = resolve(repoRoot, 'packages', 'protocol');
    const srcPackageJsonPath = resolve(srcPackageDir, 'package.json');
    const aliasPackageDir = resolve(srcPackageDir, 'node_modules', 'alias-dep');
    const destPackageDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol');
    mkdirSync(aliasPackageDir, { recursive: true });
    writeFileSync(srcPackageJsonPath, JSON.stringify({
      name: '@happier-dev/protocol',
      version: '0.0.0',
      dependencies: { 'alias-dep': 'npm:real-dep@^2.0.0' },
    }));
    writeFileSync(resolve(aliasPackageDir, 'package.json'), JSON.stringify({
      name: 'real-dep',
      version: '2.1.0',
      main: 'index.js',
    }));
    writeFileSync(resolve(aliasPackageDir, 'index.js'), 'module.exports = "aliased";\n');

    vendorBundledPackageRuntimeDependenciesFallback({
      srcPackageJsonPath,
      destPackageDir,
      dereferenceRootDir: repoRoot,
    });

    assert.equal(
      readFileSync(resolve(destPackageDir, 'node_modules', 'alias-dep', 'index.js'), 'utf8'),
      'module.exports = "aliased";\n',
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('vendorBundledPackageRuntimeDependenciesFallback terminates cyclic dependency ancestry', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-sync-bundled-workspaces-fallback-cycle-'));
  try {
    const srcPackageDir = resolve(repoRoot, 'packages', 'protocol');
    const srcPackageJsonPath = resolve(srcPackageDir, 'package.json');
    const packageADir = resolve(srcPackageDir, 'node_modules', 'package-a');
    const packageBDir = resolve(srcPackageDir, 'node_modules', 'package-b');
    const destPackageDir = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol');
    mkdirSync(packageADir, { recursive: true });
    mkdirSync(packageBDir, { recursive: true });
    writeFileSync(srcPackageJsonPath, JSON.stringify({
      name: '@happier-dev/protocol',
      version: '0.0.0',
      dependencies: { 'package-a': '^1.0.0' },
    }));
    writeFileSync(resolve(packageADir, 'package.json'), JSON.stringify({
      name: 'package-a',
      version: '1.0.0',
      dependencies: { 'package-b': '^1.0.0' },
    }));
    writeFileSync(resolve(packageBDir, 'package.json'), JSON.stringify({
      name: 'package-b',
      version: '1.0.0',
      dependencies: { 'package-a': '^1.0.0' },
    }));

    assert.doesNotThrow(() => vendorBundledPackageRuntimeDependenciesFallback({
      srcPackageJsonPath,
      destPackageDir,
      dereferenceRootDir: repoRoot,
    }));
    assert.equal(
      existsSync(resolve(
        destPackageDir,
        'node_modules',
        'package-a',
        'node_modules',
        'package-b',
        'node_modules',
        'package-a',
      )),
      false,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
