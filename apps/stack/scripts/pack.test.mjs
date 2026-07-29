import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, writeFile, mkdir, realpath, rm, readFile, symlink } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import * as packModule from './pack.mjs';
import {
  assertPhysicalPathWithinApprovedRoot,
} from '@happier-dev/cli-common/workspaceRuntimeDependencies';
import {
  analyzeBundledWorkspaceTarList,
  analyzeTarList,
  createPackSandbox,
  exportPackSandboxTarball,
  findMonorepoRoot,
  resolvePackDirForComponent,
  resolvePackSandboxWorkspaceRelDirs,
} from './pack.mjs';

async function writeFixtureRuntimeDependencyOwner(monorepoRoot) {
  await writeFile(
    join(
      monorepoRoot,
      'packages',
      'cli-common',
      'workspaceRuntimeDependencies.mjs',
    ),
    `export * from ${JSON.stringify(new URL(
      '../../../packages/cli-common/workspaceRuntimeDependencies.mjs',
      import.meta.url,
    ).href)};\n`,
  );
}

async function createHoistedRuntimePackFixture({
  root,
  symlinkRuntimeOutside = false,
  includeUndeclaredNestedRuntime = false,
  includeSiblingBorrowSymlink = false,
}) {
  const monorepoRoot = join(root, 'repo');
  for (const relDir of [
    'apps/cli',
    'apps/ui',
    'apps/server',
    'packages/cli-common',
    'packages/plugin-sdk',
    'packages/protocol',
    'scripts/workspaces',
    'scripts/testing/process',
    'node_modules/.bin',
    'node_modules/unapproved-runtime',
  ]) {
    await mkdir(join(monorepoRoot, relDir), { recursive: true });
  }
  await writeFile(join(monorepoRoot, 'package.json'), JSON.stringify({
    name: 'monorepo',
    workspaces: ['apps/*', 'packages/*'],
  }));
  await writeFile(join(monorepoRoot, 'yarn.lock'), '# lock');
  await writeFile(
    join(monorepoRoot, 'apps', 'cli', 'package.json'),
    JSON.stringify({ name: '@happier-dev/cli' }),
  );
  await writeFile(
    join(monorepoRoot, 'apps', 'ui', 'package.json'),
    JSON.stringify({ name: '@happier-dev/app' }),
  );
  await writeFile(
    join(monorepoRoot, 'apps', 'server', 'package.json'),
    JSON.stringify({ name: '@happier-dev/server' }),
  );
  await writeFile(
    join(monorepoRoot, 'packages', 'cli-common', 'package.json'),
    JSON.stringify({ name: '@happier-dev/cli-common' }),
  );
  await writeFixtureRuntimeDependencyOwner(monorepoRoot);
  await writeFile(
    join(monorepoRoot, 'packages', 'plugin-sdk', 'package.json'),
    JSON.stringify({
      name: '@happier-dev/plugin-sdk',
      bundledDependencies: ['@happier-dev/protocol'],
    }),
  );
  await writeFile(
    join(monorepoRoot, 'packages', 'protocol', 'package.json'),
    JSON.stringify({
      name: '@happier-dev/protocol',
      dependencies: {
        '@fixture/runtime': '^1.0.0',
      },
    }),
  );
  await writeFile(join(monorepoRoot, 'scripts', 'workspaces', 'placeholder.mjs'), '');
  await writeFile(join(monorepoRoot, 'scripts', 'testing', 'process', 'placeholder.mjs'), '');
  await writeFile(
    join(monorepoRoot, 'node_modules', 'unapproved-runtime', 'package.json'),
    JSON.stringify({ name: 'unapproved-runtime', version: '1.0.0' }),
  );

  const runtimePackageDir = symlinkRuntimeOutside
    ? join(root, 'outside-runtime')
    : join(monorepoRoot, 'node_modules', '@fixture', 'runtime');
  await mkdir(runtimePackageDir, { recursive: true });
  await writeFile(
    join(runtimePackageDir, 'package.json'),
    JSON.stringify({
      name: '@fixture/runtime',
      version: '1.0.0',
      dependencies: {
        'runtime-transitive': '^2.0.0',
      },
    }),
  );
  await writeFile(join(runtimePackageDir, 'index.js'), 'export const runtime = true;\n');
  if (includeUndeclaredNestedRuntime) {
    const undeclaredNestedRuntimeDir = join(
      runtimePackageDir,
      'node_modules',
      'undeclared-nested-runtime',
    );
    await mkdir(undeclaredNestedRuntimeDir, { recursive: true });
    await writeFile(
      join(undeclaredNestedRuntimeDir, 'package.json'),
      JSON.stringify({
        name: 'undeclared-nested-runtime',
        version: '1.0.0',
      }),
    );
    await writeFile(
      join(undeclaredNestedRuntimeDir, 'secret.js'),
      'export const leaked = true;\n',
    );
    await symlink(
      'node_modules/undeclared-nested-runtime/secret.js',
      join(runtimePackageDir, 'borrowed-nested.js'),
      'file',
    );
  }
  if (includeSiblingBorrowSymlink) {
    const undeclaredSiblingDir = join(
      monorepoRoot,
      'node_modules',
      '@fixture',
      'undeclared-sibling-runtime',
    );
    await mkdir(undeclaredSiblingDir, { recursive: true });
    await writeFile(
      join(undeclaredSiblingDir, 'secret.js'),
      'export const leaked = true;\n',
    );
    await symlink(
      '../undeclared-sibling-runtime/secret.js',
      join(runtimePackageDir, 'borrowed.js'),
      'file',
    );
  }
  if (symlinkRuntimeOutside) {
    await mkdir(join(monorepoRoot, 'node_modules', '@fixture'), { recursive: true });
    await symlink(
      runtimePackageDir,
      join(monorepoRoot, 'node_modules', '@fixture', 'runtime'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  await mkdir(
    join(monorepoRoot, 'node_modules', 'runtime-transitive'),
    { recursive: true },
  );
  await writeFile(
    join(monorepoRoot, 'node_modules', 'runtime-transitive', 'package.json'),
    JSON.stringify({
      name: 'runtime-transitive',
      version: '2.0.0',
    }),
  );
  await writeFile(
    join(monorepoRoot, 'node_modules', 'runtime-transitive', 'index.js'),
    'export const transitive = true;\n',
  );
  return monorepoRoot;
}

test('exportPackSandboxTarball persists exact validated bytes and returns path-free bounded metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-export-'));
  const sandboxRoot = join(root, 'sandbox');
  const sandboxPackDir = join(sandboxRoot, 'packages', 'plugin-sdk');
  const destinationDir = join(root, 'destination');
  const tarballName = 'happier-dev-plugin-sdk-0.0.0.tgz';
  const tarballBytes = Buffer.from('exact-packed-bytes');
  const inheritedLease = 'lease-value-without-path-exposure';
  const calls = [];
  try {
    await mkdir(sandboxPackDir, { recursive: true });
    await mkdir(destinationDir);
    await writeFile(join(sandboxPackDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugin-sdk',
      version: '0.0.0',
    }));

    const metadata = await exportPackSandboxTarball({
      monorepoRoot: join(root, 'workspace-must-not-leak'),
      packageRelDir: 'packages/plugin-sdk',
      destinationDir,
      env: {
        HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: inheritedLease,
      },
      createPackSandboxImpl: async () => sandboxRoot,
      runCaptureImpl: async (command, args, options) => {
        calls.push({ command, args, options });
        if (command === 'npm' && args.includes('--dry-run')) return 'dry-run output';
        if (command === 'npm') {
          await writeFile(join(sandboxPackDir, tarballName), tarballBytes);
          return `npm notice\n${tarballName}\n`;
        }
        if (command === 'tar') {
          return [
            'package/package.json',
            'package/dist/index.js',
          ].join('\n');
        }
        throw new Error(`unexpected command: ${command}`);
      },
    });

    assert.deepEqual(await readFile(join(destinationDir, tarballName)), tarballBytes);
    assert.equal(existsSync(sandboxRoot), false);
    assert.equal(
      calls
        .filter((call) => call.command === 'npm')
        .every((call) => (
          call.options.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD === inheritedLease
        )),
      true,
    );
    assert.deepEqual(metadata, {
      ok: true,
      package: {
        name: '@happier-dev/plugin-sdk',
        version: '0.0.0',
      },
      tarball: {
        name: tarballName,
        sizeBytes: tarballBytes.length,
      },
      bundled: {
        agents: false,
        cliCommon: false,
        protocol: false,
      },
      bundledWorkspaces: {
        ok: true,
        present: {},
        missing: [],
      },
      enforcement: {
        bundledDeps: false,
      },
      dryRun: {
        ok: true,
      },
    });
    const serialized = JSON.stringify(metadata);
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes(sandboxRoot), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exportPackSandboxTarball rejects symlink destinations before sandbox allocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-export-symlink-'));
  const realDestinationDir = join(root, 'real-destination');
  const symlinkDestinationDir = join(root, 'symlink-destination');
  let allocated = false;
  try {
    await mkdir(realDestinationDir);
    await symlink(
      realDestinationDir,
      symlinkDestinationDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      exportPackSandboxTarball({
        monorepoRoot: root,
        packageRelDir: 'packages/plugin-sdk',
        destinationDir: symlinkDestinationDir,
        createPackSandboxImpl: async () => {
          allocated = true;
          return join(root, 'sandbox');
        },
      }),
      /destination directory must not resolve through a symbolic link/i,
    );
    assert.equal(allocated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exportPackSandboxTarball never overwrites an existing destination and cleans only its sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-export-existing-'));
  const sandboxRoot = join(root, 'sandbox');
  const sandboxPackDir = join(sandboxRoot, 'apps', 'cli');
  const destinationDir = join(root, 'destination');
  const tarballName = 'happier-dev-cli-0.2.10.tgz';
  const destinationPath = join(destinationDir, tarballName);
  try {
    await mkdir(sandboxPackDir, { recursive: true });
    await mkdir(destinationDir);
    await writeFile(join(sandboxPackDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
    }));
    await writeFile(destinationPath, 'pre-existing-artifact');

    await assert.rejects(
      exportPackSandboxTarball({
        monorepoRoot: root,
        packageRelDir: 'apps/cli',
        destinationDir,
        createPackSandboxImpl: async () => sandboxRoot,
        runCaptureImpl: async (command, args) => {
          if (command === 'npm' && args.includes('--dry-run')) return 'dry-run';
          if (command === 'npm') {
            await writeFile(join(sandboxPackDir, tarballName), 'new-artifact');
            return tarballName;
          }
          if (command === 'tar') return 'package/package.json\n';
          throw new Error(`unexpected command: ${command}`);
        },
      }),
      /destination already exists/i,
    );
    assert.equal(await readFile(destinationPath, 'utf8'), 'pre-existing-artifact');
    assert.equal(existsSync(sandboxRoot), false);
    assert.equal(existsSync(destinationDir), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('analyzeTarList detects bundled workspace deps in tar listing', () => {
  const { hasAgents, hasCliCommon, hasProtocol } = analyzeTarList([
    'package/dist/index.mjs',
    'package/node_modules/@happier-dev/agents/package.json',
    'package/node_modules/@happier-dev/agents/dist/index.js',
    'package/node_modules/@happier-dev/cli-common/package.json',
    'package/node_modules/@happier-dev/protocol/package.json',
  ]);
  assert.equal(hasAgents, true);
  assert.equal(hasCliCommon, true);
  assert.equal(hasProtocol, true);
});

test('analyzeBundledWorkspaceTarList checks every internal bundled workspace from the package manifest', () => {
  const analysis = analyzeBundledWorkspaceTarList([
    'package/node_modules/@happier-dev/plugin-sdk/package.json',
    'package/node_modules/@happier-dev/plugins-cursor/dist/index.js',
    'package/node_modules/@happier-dev/protocol/package.json',
  ], [
    '@happier-dev/plugin-sdk',
    '@happier-dev/plugins-cursor',
    '@happier-dev/protocol',
    'tweetnacl',
  ]);

  assert.deepEqual(analysis, {
    ok: true,
    present: {
      '@happier-dev/plugin-sdk': true,
      '@happier-dev/plugins-cursor': true,
      '@happier-dev/protocol': true,
    },
    missing: [],
  });
});

test('assertBundledWorkspaceTarballComplete fails the pack when enforced bundled workspaces are missing', () => {
  assert.equal(typeof packModule.assertBundledWorkspaceTarballComplete, 'function');
  assert.throws(
    () => packModule.assertBundledWorkspaceTarballComplete({
      enforce: true,
      analysis: {
        ok: false,
        present: {
          '@happier-dev/protocol': false,
        },
        missing: ['@happier-dev/protocol'],
      },
    }),
    /missing bundled deps in tarball: @happier-dev\/protocol/,
  );
});

test('resolvePackSandboxWorkspaceRelDirs derives plugin and internal workspace directories from bundledDependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-workspace-closure-'));
  try {
    const packDir = join(root, 'apps', 'cli');
    await mkdir(packDir, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(root, 'yarn.lock'), '# lock');
    await mkdir(join(root, 'apps', 'ui'), { recursive: true });
    await mkdir(join(root, 'apps', 'server'), { recursive: true });
    await writeFile(join(root, 'apps', 'ui', 'package.json'), JSON.stringify({ name: '@happier-dev/app' }));
    await writeFile(join(root, 'apps', 'server', 'package.json'), JSON.stringify({ name: '@happier-dev/server' }));
    await writeFile(
      join(packDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli',
        bundledDependencies: [
          '@happier-dev/agents',
          '@happier-dev/plugin-sdk',
          '@happier-dev/plugins-cursor',
          'tweetnacl',
        ],
      }),
    );

    const dirs = await resolvePackSandboxWorkspaceRelDirs({
      monorepoRoot: root,
      packageRelDir: 'apps/cli',
    });

    assert.deepEqual(dirs, [
      'apps/cli',
      'packages/agents',
      'packages/plugin-sdk',
      'packages/plugins/cursor',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolvePackSandboxWorkspaceRelDirs derives and validates transitive internal workspace closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-transitive-closure-'));
  try {
    const packDir = join(root, 'apps', 'stack');
    await mkdir(packDir, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(root, 'yarn.lock'), '# lock');
    await writeFile(
      join(packDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/stack',
        bundledDependencies: [
          '@happier-dev/cli-common',
          '@happier-dev/agents',
          '@happier-dev/protocol',
        ],
      }),
    );

    await mkdir(join(root, 'packages', 'cli-common'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'cli-common', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli-common',
        dependencies: {
          '@happier-dev/agents': '0.0.0',
        },
      }),
    );
    await writeFixtureRuntimeDependencyOwner(root);
    await mkdir(join(root, 'packages', 'agents'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'agents', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/agents',
        dependencies: {
          '@happier-dev/protocol': '0.0.0',
        },
      }),
    );
    await mkdir(join(root, 'packages', 'protocol'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'protocol', 'package.json'),
      JSON.stringify({ name: '@happier-dev/protocol' }),
    );

    const dirs = await resolvePackSandboxWorkspaceRelDirs({
      monorepoRoot: root,
      packageRelDir: 'apps/stack',
    });

    assert.deepEqual(dirs, [
      'apps/stack',
      'packages/agents',
      'packages/cli-common',
      'packages/protocol',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolvePackSandboxWorkspaceRelDirs fails when bundledDependencies omit transitive internal closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-missing-transitive-closure-'));
  try {
    const packDir = join(root, 'apps', 'stack');
    await mkdir(packDir, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(root, 'yarn.lock'), '# lock');
    await writeFile(
      join(packDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/stack',
        bundledDependencies: ['@happier-dev/cli-common'],
      }),
    );

    await mkdir(join(root, 'packages', 'cli-common'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'cli-common', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli-common',
        dependencies: {
          '@happier-dev/agents': '0.0.0',
        },
      }),
    );
    await mkdir(join(root, 'packages', 'agents'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'agents', 'package.json'),
      JSON.stringify({ name: '@happier-dev/agents' }),
    );

    await assert.rejects(
      () => resolvePackSandboxWorkspaceRelDirs({
        monorepoRoot: root,
        packageRelDir: 'apps/stack',
      }),
      /Missing bundled internal workspace dependencies/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox copies every internal workspace required by the packed package closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-sandbox-closure-'));
  const originalPath = process.env.PATH;
  let sandboxRoot;
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'monorepo',
      workspaces: ['apps/*', 'packages/*', 'packages/plugins/*'],
    }));
    await writeFile(join(root, 'yarn.lock'), '# lock');
    for (const [appDir, packageName] of [
      ['ui', '@happier-dev/app'],
      ['server', '@happier-dev/server'],
    ]) {
      await mkdir(join(root, 'apps', appDir), { recursive: true });
      await writeFile(
        join(root, 'apps', appDir, 'package.json'),
        JSON.stringify({ name: packageName }),
      );
    }
    await mkdir(join(root, 'scripts', 'workspaces'), { recursive: true });
    await writeFile(
      join(root, 'scripts', 'workspaces', 'workspaceBundleLock.mjs'),
      'export function withWorkspaceBundleLock() {}\n',
    );
    await mkdir(join(root, 'scripts', 'testing', 'process'), { recursive: true });
    await writeFile(
      join(root, 'scripts', 'testing', 'process', 'managedChildLifecycle.mjs'),
      'export function runManagedChildCommand() {}\n',
    );
    const workspaceBuildSupportFiles = [
      'apps/stack/scripts/utils/fs/atomic_dir_swap.mjs',
      'apps/stack/scripts/utils/fs/fs.mjs',
      'apps/stack/scripts/utils/paths/canonical_home.mjs',
      'apps/stack/scripts/utils/paths/paths.mjs',
      'apps/stack/scripts/utils/proc/cliDistBuildLock.mjs',
      'apps/stack/scripts/utils/proc/workspace_package_manifests.mjs',
      'apps/stack/scripts/utils/proc/workspace_tool_bins.mjs',
    ];
    for (const relPath of workspaceBuildSupportFiles) {
      await mkdir(join(root, relPath, '..'), { recursive: true });
      await writeFile(join(root, relPath), `// ${relPath}\n`);
    }
    await mkdir(join(root, 'node_modules', '@typescript', 'native'), { recursive: true });
    await writeFile(
      join(root, 'node_modules', '@typescript', 'native', 'package.json'),
      JSON.stringify({ name: '@typescript/native', version: '7.0.0-dev' }),
    );
    await writeFile(join(root, 'node_modules', '.yarn-integrity'), '{}\n');
    await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(root, 'node_modules', '@react-native-community', '.bin'), { recursive: true });
    await writeFile(
      join(root, 'node_modules', '@react-native-community', '.bin', 'react-native-community-tool'),
      'transient scoped bin shim\n',
    );
    await mkdir(join(root, 'packages', 'cli-common'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'cli-common', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli-common',
        dependencies: { '@happier-dev/release-runtime': '0.0.0' },
      }),
    );
    await writeFixtureRuntimeDependencyOwner(root);
    await writeFile(
      join(root, 'packages', 'cli-common', 'workspaceBundleLock.mjs'),
      'export function withWorkspaceBundleLock() {}\n',
    );
    await mkdir(join(root, 'packages', 'release-runtime'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'release-runtime', 'package.json'),
      JSON.stringify({ name: '@happier-dev/release-runtime' }),
    );

    const packageRelDir = 'apps/cli';
    const workspaceRelDirs = [
      packageRelDir,
      'packages/agents',
      'packages/plugin-sdk',
      'packages/plugins/cursor',
      'packages/plugins/inspector',
    ];
    const packageNamesByRelDir = {
      [packageRelDir]: '@happier-dev/cli',
      'packages/agents': '@happier-dev/agents',
      'packages/plugin-sdk': '@happier-dev/plugin-sdk',
      'packages/plugins/cursor': '@happier-dev/plugins-cursor',
      'packages/plugins/inspector': '@happier-dev/plugins-inspector',
    };
    for (const relDir of workspaceRelDirs) {
      await mkdir(join(root, relDir), { recursive: true });
      await writeFile(join(root, relDir, 'package.json'), JSON.stringify({ name: packageNamesByRelDir[relDir] }));
    }
    await writeFile(
      join(root, 'packages', 'agents', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/agents',
        dependencies: { zod: 'test' },
      }),
    );
    await mkdir(join(root, 'packages', 'agents', 'node_modules', 'zod'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'agents', 'node_modules', 'zod', 'package.json'),
      JSON.stringify({ name: 'zod', version: 'test' }),
    );
    await writeFile(
      join(root, 'packages', 'agents', 'node_modules', 'zod', 'index.js'),
      'export const z = true;\n',
    );
    const pluginBuildBin = join(root, 'packages', 'plugin-sdk', 'dist', 'ui', 'build', 'bin.js');
    await mkdir(join(root, 'packages', 'plugin-sdk', 'dist', 'ui', 'build'), { recursive: true });
    await writeFile(pluginBuildBin, '#!/usr/bin/env node\n');
    await writeFile(
      join(root, 'packages', 'plugin-sdk', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugin-sdk',
        bin: {
          'happier-plugin-build-ui': './dist/ui/build/bin.js',
        },
        devDependencies: {
          zod: 'test',
        },
      }),
    );
    await writeFile(
      join(root, 'packages', 'plugins', 'inspector', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugins-inspector',
        dependencies: {
          '@happier-dev/plugin-sdk': '0.0.0',
        },
      }),
    );
    await mkdir(join(root, 'node_modules', '@happier-dev'), { recursive: true });
    await symlink(
      join(root, 'packages', 'plugin-sdk'),
      join(root, 'node_modules', '@happier-dev', 'plugin-sdk'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const absoluteRootShim = [
      '#!/bin/sh',
      `exec "${process.execPath}" "${pluginBuildBin}" "$@"`,
      '',
    ].join('\n');
    await writeFile(
      join(root, 'node_modules', '.bin', 'happier-plugin-build-ui'),
      absoluteRootShim,
    );
    await writeFile(
      join(root, 'packages', 'plugins', 'cursor', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugins-cursor',
        devDependencies: { '@happier-dev/bundled-voice-runtime-contract': '0.0.0' },
      }),
    );
    await mkdir(join(root, 'packages', 'bundled-voice-runtime-contract'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'bundled-voice-runtime-contract', 'package.json'),
      JSON.stringify({ name: '@happier-dev/bundled-voice-runtime-contract' }),
    );
    await mkdir(join(root, 'packages', 'plugin-sdk', 'node_modules', '@happier-dev', 'agents'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'plugin-sdk', 'node_modules', '@happier-dev', 'agents', 'package.json'),
      JSON.stringify({ name: '@happier-dev/agents', version: 'stale-publication-output' }),
    );
    await mkdir(join(root, 'packages', 'plugin-sdk', 'node_modules', 'zod'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'plugin-sdk', 'node_modules', 'zod', 'package.json'),
      JSON.stringify({
        name: 'zod',
        version: 'test-dependency',
        dependencies: { 'zod-transitive': 'test' },
      }),
    );
    await mkdir(join(root, 'packages', 'plugin-sdk', 'node_modules', 'zod-transitive'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'plugin-sdk', 'node_modules', 'zod-transitive', 'package.json'),
      JSON.stringify({ name: 'zod-transitive', version: 'test-transitive-dependency' }),
    );
    await mkdir(join(root, packageRelDir, 'node_modules', '.vite-temp'), { recursive: true });
    await writeFile(
      join(root, packageRelDir, 'node_modules', '.vite-temp', 'transient-config.mjs'),
      'export default {};\n',
    );
    await mkdir(join(root, packageRelDir, 'dist.staging.1234'), { recursive: true });
    await writeFile(join(root, packageRelDir, 'dist.staging.1234', 'stale.js'), 'stale\n');
    await writeFile(join(root, packageRelDir, 'stale-pack.tgz'), 'stale\n');
    await mkdir(join(root, packageRelDir, 'tools', 'unpacked'), { recursive: true });
    await writeFile(join(root, packageRelDir, 'tools', 'unpacked', 'stale-tool'), 'stale\n');
    await mkdir(join(root, 'packages', 'plugin-sdk', '.dist.build.1234'), { recursive: true });
    await writeFile(join(root, 'packages', 'plugin-sdk', '.dist.build.1234', 'stale.js'), 'stale\n');
    await writeFile(
      join(root, packageRelDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli',
        bundledDependencies: [
          '@happier-dev/agents',
          '@happier-dev/plugin-sdk',
          '@happier-dev/plugins-cursor',
          '@happier-dev/plugins-inspector',
          'tweetnacl',
        ],
      }),
    );

    process.env.PATH = '';
    sandboxRoot = await createPackSandbox({ monorepoRoot: root, packageRelDir });
    process.env.PATH = originalPath;

    assert.equal(existsSync(join(sandboxRoot, 'packages', 'agents', 'package.json')), true);
    assert.equal(existsSync(join(sandboxRoot, 'packages', 'plugin-sdk', 'package.json')), true);
    assert.equal(existsSync(join(sandboxRoot, 'packages', 'plugins', 'cursor', 'package.json')), true);
    assert.equal(existsSync(join(sandboxRoot, 'packages', 'plugins', 'inspector', 'package.json')), true);
    assert.equal(
      existsSync(join(sandboxRoot, 'packages', 'bundled-voice-runtime-contract', 'package.json')),
      true,
    );
    assert.equal(
      existsSync(join(sandboxRoot, 'packages', 'cli-common', 'workspaceBundleLock.mjs')),
      true,
    );
    assert.equal(
      existsSync(join(sandboxRoot, 'packages', 'release-runtime', 'package.json')),
      true,
    );
    assert.equal(
      existsSync(join(sandboxRoot, 'scripts', 'workspaces', 'workspaceBundleLock.mjs')),
      true,
    );
    assert.equal(
      existsSync(join(sandboxRoot, 'scripts', 'testing', 'process', 'managedChildLifecycle.mjs')),
      true,
    );
    for (const relPath of workspaceBuildSupportFiles) {
      assert.equal(
        existsSync(join(sandboxRoot, relPath)),
        true,
        `workspace build support must be copied into the pack sandbox: ${relPath}`,
      );
    }
    assert.equal(
      await realpath(join(sandboxRoot, 'node_modules', '@typescript', 'native')),
      await realpath(join(root, 'node_modules', '@typescript', 'native')),
    );
    assert.equal((await lstat(join(sandboxRoot, 'node_modules', '.yarn-integrity'))).isSymbolicLink(), false);
    assert.equal(
      existsSync(join(sandboxRoot, 'node_modules', '@react-native-community', '.bin')),
      false,
      'scoped package bin directories should not be treated as package dependencies',
    );
    assert.equal(
      await realpath(join(sandboxRoot, 'node_modules', '@happier-dev', 'plugin-sdk')),
      await realpath(join(sandboxRoot, 'packages', 'plugin-sdk')),
    );
    assert.equal(
      await realpath(join(sandboxRoot, 'node_modules', '@happier-dev', 'bundled-voice-runtime-contract')),
      await realpath(join(sandboxRoot, 'packages', 'bundled-voice-runtime-contract')),
    );
    assert.equal(
      (await lstat(join(sandboxRoot, 'packages', 'plugin-sdk', 'node_modules', 'zod'))).isSymbolicLink(),
      true,
      'external build dependencies should be linked instead of recursively copied',
    );
    assert.equal(
      (await lstat(join(
        sandboxRoot,
        'packages',
        'plugin-sdk',
        'node_modules',
        'zod-transitive',
      ))).isSymbolicLink(),
      true,
      'transitive external build dependencies should remain resolvable in the isolated sandbox',
    );
    assert.equal(
      existsSync(join(sandboxRoot, 'packages', 'plugin-sdk', 'node_modules', '@happier-dev')),
      false,
    );
    assert.equal(
      (await lstat(join(sandboxRoot, 'packages', 'agents', 'node_modules', 'zod'))).isSymbolicLink(),
      false,
      'workspace-local runtime dependencies should materialize as sandbox-owned bytes',
    );
    assert.equal(
      await readFile(
        join(sandboxRoot, 'packages', 'agents', 'node_modules', 'zod', 'index.js'),
        'utf8',
      ),
      'export const z = true;\n',
    );
    assert.equal(
      existsSync(join(sandboxRoot, packageRelDir, 'node_modules', '.vite-temp')),
      false,
    );
    assert.equal(existsSync(join(sandboxRoot, packageRelDir, 'dist.staging.1234')), false);
    assert.equal(existsSync(join(sandboxRoot, packageRelDir, 'stale-pack.tgz')), false);
    assert.equal(existsSync(join(sandboxRoot, packageRelDir, 'tools', 'unpacked')), false);
    assert.equal(existsSync(join(sandboxRoot, 'packages', 'plugin-sdk', '.dist.build.1234')), false);
    const expectedSandboxPluginBuildBin = await realpath(join(
      sandboxRoot,
      'packages',
      'plugin-sdk',
      'dist',
      'ui',
      'build',
      'bin.js',
    ));
    const sandboxPluginBuildBin = join(
      sandboxRoot,
      'node_modules',
      '.bin',
      'happier-plugin-build-ui',
    );
    if (process.platform === 'win32') {
      const commandShim = await readFile(`${sandboxPluginBuildBin}.cmd`, 'utf8');
      assert.match(commandShim, /packages\\plugin-sdk\\dist\\ui\\build\\bin\.js/);
      assert.equal(commandShim.includes(root), false);
    } else {
      const commandShim = await readFile(sandboxPluginBuildBin, 'utf8');
      assert.match(commandShim, /packages\/plugin-sdk\/dist\/ui\/build\/bin\.js/);
      assert.equal(commandShim.includes(root), false);
      assert.equal(commandShim.includes(expectedSandboxPluginBuildBin), true);
    }
    assert.equal(
      existsSync(join(
        sandboxRoot,
        'packages',
        'plugins',
        'inspector',
        'node_modules',
        '.bin',
        'happier-plugin-build-ui',
      )),
      false,
      'the canonical workspace bin owner should provide one root shim instead of a package-local copy',
    );
  } finally {
    process.env.PATH = originalPath;
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox materializes only the declared root-hoisted runtime closure inside the sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-hoisted-runtime-'));
  let sandboxRoot;
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    sandboxRoot = await createPackSandbox({
      monorepoRoot,
      packageRelDir: 'packages/plugin-sdk',
    });

    const runtimePackageDir = join(
      sandboxRoot,
      'packages',
      'protocol',
      'node_modules',
      '@fixture',
      'runtime',
    );
    const transitivePackageDir = join(
      runtimePackageDir,
      'node_modules',
      'runtime-transitive',
    );
    assert.equal((await lstat(runtimePackageDir)).isSymbolicLink(), false);
    assert.equal((await lstat(transitivePackageDir)).isSymbolicLink(), false);
    assert.doesNotThrow(() => assertPhysicalPathWithinApprovedRoot({
      approvedRootDir: sandboxRoot,
      sourcePath: runtimePackageDir,
      dependencyName: '@fixture/runtime',
    }));
    assert.doesNotThrow(() => assertPhysicalPathWithinApprovedRoot({
      approvedRootDir: sandboxRoot,
      sourcePath: transitivePackageDir,
      dependencyName: 'runtime-transitive',
    }));

    const unapprovedPackageDir = join(
      sandboxRoot,
      'node_modules',
      'unapproved-runtime',
    );
    assert.equal((await lstat(unapprovedPackageDir)).isSymbolicLink(), true);
    assert.throws(
      () => assertPhysicalPathWithinApprovedRoot({
        approvedRootDir: sandboxRoot,
        sourcePath: unapprovedPackageDir,
        dependencyName: 'unapproved-runtime',
      }),
      /outside the caller-approved root/i,
    );
  } finally {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox excludes undeclared nested node_modules while retaining declared transitive runtime packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-undeclared-nested-runtime-'));
  let sandboxRoot;
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({
      root,
      includeUndeclaredNestedRuntime: true,
    });
    sandboxRoot = await createPackSandbox({
      monorepoRoot,
      packageRelDir: 'packages/plugin-sdk',
    });

    const runtimePackageDir = join(
      sandboxRoot,
      'packages',
      'protocol',
      'node_modules',
      '@fixture',
      'runtime',
    );
    assert.equal(
      existsSync(join(
        runtimePackageDir,
        'node_modules',
        'undeclared-nested-runtime',
        'secret.js',
      )),
      false,
    );
    assert.equal(existsSync(join(runtimePackageDir, 'borrowed-nested.js')), false);
    assert.equal(
      existsSync(join(
        runtimePackageDir,
        'node_modules',
        'runtime-transitive',
        'index.js',
      )),
      true,
    );
  } finally {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox rejects a declared runtime package that borrows undeclared sibling bytes through a symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-runtime-sibling-borrow-'));
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({
      root,
      includeSiblingBorrowSymlink: true,
    });

    await assert.rejects(
      () => createPackSandbox({
        monorepoRoot,
        packageRelDir: 'packages/plugin-sdk',
      }),
      /escapes copy source root/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox loads the basis-owned cli-common runtime dependency owner after operation entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-lazy-runtime-owner-'));
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    const hookPath = join(root, 'poison-runtime-owner-hook.mjs');
    await writeFile(hookPath, `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@happier-dev/cli-common/workspaceRuntimeDependencies') {
    return {
      shortCircuit: true,
      url: 'data:text/javascript,throw new Error("poisoned mutable Stack cli-common copy")',
    };
  }
  return nextResolve(specifier, context);
}
`);
    const bootstrapPath = join(root, 'run-pack-with-poisoned-fallback.mjs');
    const packModuleUrl = `${pathToFileURL(join(
      import.meta.dirname,
      'pack.mjs',
    )).href}?lazy-owner-test=${Date.now()}`;
    await writeFile(bootstrapPath, `
import { register } from 'node:module';
import { rm } from 'node:fs/promises';
register(${JSON.stringify(pathToFileURL(hookPath).href)}, import.meta.url);
const { createPackSandbox } = await import(${JSON.stringify(packModuleUrl)});
const sandboxRoot = await createPackSandbox({
  monorepoRoot: ${JSON.stringify(monorepoRoot)},
  packageRelDir: 'packages/plugin-sdk',
});
await rm(sandboxRoot, { recursive: true, force: true });
`);

    const result = spawnSync(process.execPath, [bootstrapPath], {
      cwd: import.meta.dirname,
      encoding: 'utf8',
    });
    assert.equal(
      result.status,
      0,
      `pack operation resolved the poisoned pre-operation fallback:\n${result.stderr}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox fails closed when the source cli-common owner module is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-missing-runtime-owner-'));
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    await rm(join(
      monorepoRoot,
      'packages',
      'cli-common',
      'workspaceRuntimeDependencies.mjs',
    ));

    await assert.rejects(
      createPackSandbox({
        monorepoRoot,
        packageRelDir: 'packages/plugin-sdk',
      }),
      /source cli-common workspace is missing its runtime dependency owner/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox rejects a declared runtime package symlinked outside the monorepo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-runtime-symlink-escape-'));
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({
      root,
      symlinkRuntimeOutside: true,
    });
    await assert.rejects(
      createPackSandbox({
        monorepoRoot,
        packageRelDir: 'packages/plugin-sdk',
      }),
      /runtime dependency.*outside.*approved dependency roots/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox rejects malformed declared dependency names without a local node_modules directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-runtime-name-traversal-'));
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    await rm(
      join(monorepoRoot, 'packages', 'protocol', 'node_modules'),
      { recursive: true, force: true },
    );
    await writeFile(
      join(monorepoRoot, 'packages', 'protocol', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/protocol',
        dependencies: {
          '../../../../outside-runtime': '1.0.0',
        },
      }),
    );

    await assert.rejects(
      createPackSandbox({
        monorepoRoot,
        packageRelDir: 'packages/plugin-sdk',
      }),
      /invalid package dependency name/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [
  linkKind,
  linkName,
] of [
  ['file', 'linked-source.js'],
  ['directory', 'linked-source-dir'],
]) {
  test(`createPackSandbox rejects a nested source ${linkKind} symlink outside its copied workspace root`, async () => {
  const root = await mkdtemp(join(tmpdir(), `pack-test-source-${linkKind}-escape-`));
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    const outsidePath = join(root, `outside-source-${linkKind}`);
    if (linkKind === 'directory') {
      await mkdir(outsidePath, { recursive: true });
      await writeFile(join(outsidePath, 'secret.js'), 'outside directory bytes\n');
    } else {
      await writeFile(outsidePath, 'outside file bytes\n');
    }
    await symlink(
      outsidePath,
      join(monorepoRoot, 'packages', 'protocol', linkName),
      linkKind === 'directory'
        ? (process.platform === 'win32' ? 'junction' : 'dir')
        : 'file',
    );

    await assert.rejects(
      createPackSandbox({
        monorepoRoot,
        packageRelDir: 'packages/plugin-sdk',
      }),
      /dereferenced symlink target escapes copy source root/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  });
}

test('createPackSandbox materializes a contained relative source symlink as sandbox-owned bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-contained-source-symlink-'));
  let sandboxRoot;
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    const protocolSourceDir = join(monorepoRoot, 'packages', 'protocol');
    await writeFile(join(protocolSourceDir, 'owned-source.js'), 'owned source bytes\n');
    await symlink('owned-source.js', join(protocolSourceDir, 'linked-source.js'), 'file');

    sandboxRoot = await createPackSandbox({
      monorepoRoot,
      packageRelDir: 'packages/plugin-sdk',
    });

    const copiedLinkPath = join(
      sandboxRoot,
      'packages',
      'protocol',
      'linked-source.js',
    );
    assert.equal((await lstat(copiedLinkPath)).isSymbolicLink(), false);
    assert.equal(await readFile(copiedLinkPath, 'utf8'), 'owned source bytes\n');
  } finally {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox excludes nested transient build bytes omitted from the candidate basis', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-nested-transient-build-'));
  let sandboxRoot;
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    const transientSourceDir = join(
      monorepoRoot,
      'packages',
      'protocol',
      'native',
      'helper',
      '.build',
    );
    await mkdir(transientSourceDir, { recursive: true });
    await writeFile(join(transientSourceDir, 'unattested-sentinel'), 'must not enter prepack\n');

    sandboxRoot = await createPackSandbox({
      monorepoRoot,
      packageRelDir: 'packages/plugin-sdk',
    });

    assert.equal(
      existsSync(join(
        sandboxRoot,
        'packages',
        'protocol',
        'native',
        'helper',
        '.build',
        'unattested-sentinel',
      )),
      false,
    );
  } finally {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox rejects a workspace package manifest symlink before it can change closure discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-workspace-manifest-symlink-'));
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    const protocolPackageJsonPath = join(
      monorepoRoot,
      'packages',
      'protocol',
      'package.json',
    );
    const outsideManifestPath = join(root, 'outside-protocol-package.json');
    await writeFile(outsideManifestPath, JSON.stringify({
      name: '@happier-dev/protocol',
      dependencies: {
        '@fixture/runtime': '^1.0.0',
      },
    }));
    await rm(protocolPackageJsonPath);
    await symlink(outsideManifestPath, protocolPackageJsonPath, 'file');

    await assert.rejects(
      createPackSandbox({
        monorepoRoot,
        packageRelDir: 'packages/plugin-sdk',
      }),
      /json source must be a regular file/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [
  relativePath,
  outsideContents,
] of [
  ['package.json', JSON.stringify({ name: 'monorepo' })],
  ['yarn.lock', '# outside lock\n'],
]) {
  test(`createPackSandbox rejects a symlinked root ${relativePath} before copying outside bytes`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-root-file-symlink-'));
  try {
    const monorepoRoot = await createHoistedRuntimePackFixture({ root });
    const sourcePath = join(monorepoRoot, relativePath);
    const outsidePath = join(root, `outside-${relativePath.replaceAll('/', '-')}`);
    await writeFile(outsidePath, outsideContents);
    await rm(sourcePath);
    await symlink(outsidePath, sourcePath, 'file');

    await assert.rejects(
      createPackSandbox({
        monorepoRoot,
        packageRelDir: 'packages/plugin-sdk',
      }),
      /pack source file must be a regular file/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  });
}

test('createPackSandbox ignores inherited package bin links outside the declared dependency graph', async () => {
  for (const mode of ['absolute', 'relative']) {
    const root = await mkdtemp(join(tmpdir(), `pack-test-bin-escape-${mode}-`));
    const monorepoRoot = join(root, 'repo');
    const outsideTarget = join(root, 'outside-bin.js');
    let sandboxRoot;
    try {
      await mkdir(join(monorepoRoot, 'apps', 'cli', 'node_modules', '.bin'), { recursive: true });
      await mkdir(join(monorepoRoot, 'packages', 'cli-common'), { recursive: true });
      await mkdir(join(monorepoRoot, 'scripts', 'workspaces'), { recursive: true });
      await mkdir(join(monorepoRoot, 'scripts', 'testing', 'process'), { recursive: true });
      await mkdir(join(monorepoRoot, 'node_modules', '.bin'), { recursive: true });
      await writeFile(join(monorepoRoot, 'package.json'), JSON.stringify({ name: 'monorepo' }));
      await writeFile(join(monorepoRoot, 'yarn.lock'), '# lock');
      await writeFile(
        join(monorepoRoot, 'apps', 'cli', 'package.json'),
        JSON.stringify({ name: '@happier-dev/cli' }),
      );
      await writeFile(
        join(monorepoRoot, 'packages', 'cli-common', 'package.json'),
        JSON.stringify({ name: '@happier-dev/cli-common' }),
      );
      await writeFixtureRuntimeDependencyOwner(monorepoRoot);
      await writeFile(join(monorepoRoot, 'scripts', 'workspaces', 'placeholder.mjs'), '');
      await writeFile(join(monorepoRoot, 'scripts', 'testing', 'process', 'placeholder.mjs'), '');
      await writeFile(outsideTarget, '#!/usr/bin/env node\n');

      const binDir = join(monorepoRoot, 'apps', 'cli', 'node_modules', '.bin');
      await symlink(
        mode === 'absolute' ? outsideTarget : relative(binDir, outsideTarget),
        join(binDir, 'escaped-tool'),
        process.platform === 'win32' ? 'file' : undefined,
      );

      sandboxRoot = await createPackSandbox({ monorepoRoot, packageRelDir: 'apps/cli' });
      assert.equal(
        existsSync(join(sandboxRoot, 'apps', 'cli', 'node_modules', '.bin', 'escaped-tool')),
        false,
      );
    } finally {
      if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('createPackSandbox removes its allocated sandbox when construction fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-sandbox-cleanup-'));
  const sandboxRoot = join(root, 'allocated-sandbox');
  try {
    await mkdir(join(root, 'apps', 'cli'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(root, 'yarn.lock'), '# lock');
    await writeFile(join(root, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }));
    await mkdir(sandboxRoot, { recursive: true });

    await assert.rejects(
      () => createPackSandbox({
        monorepoRoot: root,
        packageRelDir: 'apps/cli',
        createTempDir: async () => sandboxRoot,
      }),
      /missing repository dependencies/i,
    );
    assert.equal(existsSync(sandboxRoot), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox rejects traversal and symlinked package roots before allocating a sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-sandbox-containment-'));
  const monorepoRoot = join(root, 'repo');
  const outsidePackageDir = join(root, 'outside-package');
  let allocated = false;
  const createTempDir = async () => {
    allocated = true;
    return join(root, 'allocated-sandbox');
  };
  try {
    await mkdir(join(monorepoRoot, 'apps'), { recursive: true });
    await mkdir(outsidePackageDir, { recursive: true });
    await symlink(
      outsidePackageDir,
      join(monorepoRoot, 'apps', 'escaped-package'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await assert.rejects(
      () => createPackSandbox({
        monorepoRoot,
        packageRelDir: '../outside-package',
        createTempDir,
      }),
      /relative workspace path under apps\/ or packages\//i,
    );
    await assert.rejects(
      () => createPackSandbox({
        monorepoRoot,
        packageRelDir: 'apps/escaped-package',
        createTempDir,
      }),
      /must not resolve through a symbolic link/i,
    );
    assert.equal(allocated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox rejects dependency-derived workspace traversal without reading or writing outside its roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-dependency-traversal-'));
  const monorepoRoot = join(root, 'repo');
  const outsideSourceDir = join(root, 'outside-source');
  const sandboxRoot = join(root, 'sandbox-parent', 'sandbox');
  const escapedDestinationDir = join(root, 'sandbox-parent', 'outside-source');
  try {
    for (const relDir of [
      'apps/cli',
      'packages/cli-common',
      'scripts/workspaces',
      'scripts/testing/process',
      'node_modules',
    ]) {
      await mkdir(join(monorepoRoot, relDir), { recursive: true });
    }
    await writeFile(join(monorepoRoot, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(monorepoRoot, 'yarn.lock'), '# lock');
    await writeFile(
      join(monorepoRoot, 'apps', 'cli', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli',
        bundledDependencies: ['@happier-dev/plugins-../../../outside-source'],
      }),
    );
    await writeFile(
      join(monorepoRoot, 'packages', 'cli-common', 'package.json'),
      JSON.stringify({ name: '@happier-dev/cli-common' }),
    );
    await writeFixtureRuntimeDependencyOwner(monorepoRoot);
    await writeFile(join(monorepoRoot, 'scripts', 'workspaces', 'placeholder.mjs'), '');
    await writeFile(join(monorepoRoot, 'scripts', 'testing', 'process', 'placeholder.mjs'), '');
    await mkdir(outsideSourceDir);
    await writeFile(
      join(outsideSourceDir, 'package.json'),
      JSON.stringify({ name: '@happier-dev/plugins-../../../outside-source' }),
    );
    await writeFile(join(outsideSourceDir, 'sentinel.txt'), 'outside source bytes');

    await assert.rejects(
      createPackSandbox({
        monorepoRoot,
        packageRelDir: 'apps/cli',
        createTempDir: async () => {
          await mkdir(sandboxRoot, { recursive: true });
          return sandboxRoot;
        },
      }),
      /invalid internal workspace package name/i,
    );
    assert.equal(existsSync(escapedDestinationDir), false);
    assert.equal(await readFile(join(outsideSourceDir, 'sentinel.txt'), 'utf8'), 'outside source bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox rejects a symlinked dependency workspace without copying its external target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-dependency-symlink-'));
  const monorepoRoot = join(root, 'repo');
  const outsideWorkspaceDir = join(root, 'outside-plugin');
  const sandboxRoot = join(root, 'sandbox');
  try {
    for (const relDir of [
      'apps/cli',
      'packages/cli-common',
      'packages/plugins',
      'scripts/workspaces',
      'scripts/testing/process',
      'node_modules',
    ]) {
      await mkdir(join(monorepoRoot, relDir), { recursive: true });
    }
    await writeFile(join(monorepoRoot, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(monorepoRoot, 'yarn.lock'), '# lock');
    await writeFile(
      join(monorepoRoot, 'apps', 'cli', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli',
        bundledDependencies: ['@happier-dev/plugins-escaped'],
      }),
    );
    await writeFile(
      join(monorepoRoot, 'packages', 'cli-common', 'package.json'),
      JSON.stringify({ name: '@happier-dev/cli-common' }),
    );
    await writeFixtureRuntimeDependencyOwner(monorepoRoot);
    await writeFile(join(monorepoRoot, 'scripts', 'workspaces', 'placeholder.mjs'), '');
    await writeFile(join(monorepoRoot, 'scripts', 'testing', 'process', 'placeholder.mjs'), '');
    await mkdir(outsideWorkspaceDir);
    await writeFile(
      join(outsideWorkspaceDir, 'package.json'),
      JSON.stringify({ name: '@happier-dev/plugins-escaped' }),
    );
    await writeFile(join(outsideWorkspaceDir, 'sentinel.txt'), 'external target bytes');
    await symlink(
      outsideWorkspaceDir,
      join(monorepoRoot, 'packages', 'plugins', 'escaped'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await assert.rejects(
      createPackSandbox({
        monorepoRoot,
        packageRelDir: 'apps/cli',
        createTempDir: async () => {
          await mkdir(sandboxRoot, { recursive: true });
          return sandboxRoot;
        },
      }),
      /dependency workspace must not resolve through a symbolic link/i,
    );
    assert.equal(existsSync(join(sandboxRoot, 'packages', 'plugins', 'escaped')), false);
    assert.equal(
      await readFile(join(outsideWorkspaceDir, 'sentinel.txt'), 'utf8'),
      'external target bytes',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createPackSandbox rejects external dependency traversal before node_modules source or destination joins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-node-modules-traversal-'));
  const monorepoRoot = join(root, 'repo');
  const outsideSourceDir = join(root, 'outside-external');
  const sandboxRoot = join(root, 'sandbox-parent', 'sandbox');
  const escapedDestinationDir = join(root, 'sandbox-parent', 'outside-external');
  try {
    for (const relDir of [
      'apps/cli/node_modules',
      'packages/cli-common',
      'scripts/workspaces',
      'scripts/testing/process',
      'node_modules',
    ]) {
      await mkdir(join(monorepoRoot, relDir), { recursive: true });
    }
    await writeFile(join(monorepoRoot, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(monorepoRoot, 'yarn.lock'), '# lock');
    await writeFile(
      join(monorepoRoot, 'apps', 'cli', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli',
        dependencies: {
          '../../../../outside-external': '1.0.0',
        },
      }),
    );
    await writeFile(
      join(monorepoRoot, 'packages', 'cli-common', 'package.json'),
      JSON.stringify({ name: '@happier-dev/cli-common' }),
    );
    await writeFixtureRuntimeDependencyOwner(monorepoRoot);
    await writeFile(join(monorepoRoot, 'scripts', 'workspaces', 'placeholder.mjs'), '');
    await writeFile(join(monorepoRoot, 'scripts', 'testing', 'process', 'placeholder.mjs'), '');
    await mkdir(outsideSourceDir);
    await writeFile(
      join(outsideSourceDir, 'package.json'),
      JSON.stringify({ name: 'outside-external' }),
    );
    await writeFile(join(outsideSourceDir, 'sentinel.txt'), 'outside dependency bytes');

    await assert.rejects(
      createPackSandbox({
        monorepoRoot,
        packageRelDir: 'apps/cli',
        createTempDir: async () => {
          await mkdir(sandboxRoot, { recursive: true });
          return sandboxRoot;
        },
      }),
      /invalid package dependency name/i,
    );
    assert.equal(existsSync(escapedDestinationDir), false);
    assert.equal(
      await readFile(join(outsideSourceDir, 'sentinel.txt'), 'utf8'),
      'outside dependency bytes',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('findMonorepoRoot finds nearest package.json + yarn.lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(root, 'yarn.lock'), '# lock');
    await mkdir(join(root, 'packages', 'happy-cli'), { recursive: true });

    const nested = join(root, 'packages', 'happy-cli');
    const found = await findMonorepoRoot(nested);
    assert.equal(found, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolvePackDirForComponent maps monorepo root to apps/cli', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(root, 'yarn.lock'), '# lock');
    await mkdir(join(root, 'apps', 'cli'), { recursive: true });

    const resolved = await resolvePackDirForComponent({
      component: 'happy-cli',
      componentDir: root,
      explicitDir: null,
    });
    assert.equal(resolve(resolved), resolve(join(root, 'apps', 'cli')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolvePackDirForComponent keeps a repo-local hstack pack in its own monorepo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-local-owner-'));
  try {
    const localRoot = join(root, 'dev');
    const inheritedStackRoot = join(root, 'remote-dev');
    await mkdir(localRoot, { recursive: true });
    await writeFile(join(localRoot, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(localRoot, 'yarn.lock'), '# local lock');
    await mkdir(join(localRoot, 'apps', 'stack'), { recursive: true });
    await mkdir(join(localRoot, 'apps', 'cli'), { recursive: true });
    await mkdir(inheritedStackRoot, { recursive: true });
    await writeFile(join(inheritedStackRoot, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(inheritedStackRoot, 'yarn.lock'), '# inherited lock');
    await mkdir(join(inheritedStackRoot, 'apps', 'cli'), { recursive: true });

    const resolved = await resolvePackDirForComponent({
      component: 'happy-cli',
      componentDir: join(inheritedStackRoot, 'apps', 'cli'),
      explicitDir: null,
      rootDir: join(localRoot, 'apps', 'stack'),
    });
    assert.equal(resolve(resolved), resolve(join(localRoot, 'apps', 'cli')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolvePackDirForComponent prefers explicitDir override', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-test-explicit-'));
  try {
    const explicit = join(root, 'custom-pack-dir');
    await mkdir(explicit, { recursive: true });
    const resolved = await resolvePackDirForComponent({
      component: 'happy-cli',
      componentDir: root,
      explicitDir: explicit,
    });
    assert.equal(resolve(resolved), resolve(explicit));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stack package exposes happier as a published binary', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.bin, {
    hstack: './bin/hstack.mjs',
    happier: './bin/happier.mjs',
  });
});

test('stack package excludes the WSREPL Lima test shims from published files', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(pkg.files), 'expected stack package to declare published files');
  assert.ok(
    pkg.files.includes('!scripts/provision/macos-lima-wsrepl-matrix.sh'),
    'expected WSREPL Lima matrix shim to be excluded from the published stack package',
  );
  assert.ok(
    pkg.files.includes('!scripts/provision/macos-lima-vm.sh'),
    'expected WSREPL Lima VM shim to be excluded from the published stack package',
  );
});

test('stack package keeps the Expo heap helper local to the packaged scripts tree', async () => {
  const commandMjs = await readFile(new URL('./utils/expo/command.mjs', import.meta.url), 'utf8');
  assert.match(commandMjs, /from '\.\/expoNodeHeapEnv\.mjs';/);
  assert.doesNotMatch(commandMjs, /scripts\/expo\/expoNodeHeapEnv\.mjs/);
});
