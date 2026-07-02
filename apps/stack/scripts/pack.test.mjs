import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as packModule from './pack.mjs';
import {
  analyzeBundledWorkspaceTarList,
  analyzeTarList,
  createPackSandbox,
  findMonorepoRoot,
  resolvePackDirForComponent,
  resolvePackSandboxWorkspaceRelDirs,
} from './pack.mjs';

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
  let sandboxRoot;
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo' }));
    await writeFile(join(root, 'yarn.lock'), '# lock');

    const packageRelDir = 'apps/cli';
    const workspaceRelDirs = [
      packageRelDir,
      'packages/agents',
      'packages/plugin-sdk',
      'packages/plugins/cursor',
    ];
    for (const relDir of workspaceRelDirs) {
      await mkdir(join(root, relDir), { recursive: true });
      await writeFile(join(root, relDir, 'package.json'), JSON.stringify({ name: relDir }));
    }
    await writeFile(
      join(root, packageRelDir, 'package.json'),
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

    sandboxRoot = await createPackSandbox({ monorepoRoot: root, packageRelDir });

    assert.equal(existsSync(join(sandboxRoot, 'packages', 'agents', 'package.json')), true);
    assert.equal(existsSync(join(sandboxRoot, 'packages', 'plugin-sdk', 'package.json')), true);
    assert.equal(existsSync(join(sandboxRoot, 'packages', 'plugins', 'cursor', 'package.json')), true);
  } finally {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
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
