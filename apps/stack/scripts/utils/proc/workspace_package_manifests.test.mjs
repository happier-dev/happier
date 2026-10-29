import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectWorkspacePackageJsonPaths, readWorkspacePatterns, readWorkspacePatchPaths } from './workspace_package_manifests.mjs';

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

test('reads registered patch paths through the dependency-free workspace reader', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hs-workspace-patches-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await readWorkspacePatchPaths(root), []);
  await writeFile(join(root, 'pnpm-workspace.yaml'), [
    'packages:', '  - apps/*', 'patchedDependencies: # canonical patches',
    '  "@scope/first@1.0.0": "changes/first.diff" # double quoted',
    "  'second@2.0.0': 'patches/it''s-second.patch'",
    '  third@3.0.0: patches/third.patch', 'nodeLinker: hoisted', '',
  ].join('\n'));
  assert.deepEqual(await readWorkspacePatchPaths(root), ['changes/first.diff', "patches/it's-second.patch", 'patches/third.patch']);
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  assert.deepEqual(await readWorkspacePatchPaths(root), []);
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'patchedDependencies: {}\n');
  assert.deepEqual(await readWorkspacePatchPaths(root), []);
  for (const source of ['patchedDependencies: { dependency: patches/x.patch }\n',
    'patchedDependencies:\n  dependency: &patch patches/x.patch\n',
    'patchedDependencies:\n  dependency:\n    path: patches/x.patch\n']) {
    await writeFile(join(root, 'pnpm-workspace.yaml'), source);
    await assert.rejects(readWorkspacePatchPaths(root), /Unsupported patchedDependencies syntax/u);
  }
});

test('collectWorkspacePackageJsonPaths expands character-class workspace globs for plugin packages', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-workspace-package-manifests-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await writeJson(join(root, 'package.json'), { name: 'repo', private: true });
  await writeFile(join(root, 'pnpm-workspace.yaml'), [
    'packages:',
    '  - apps/ui',
    '  - packages/protocol',
    '  - packages/plugins/[a-z]*',
    '',
  ].join('\n'));

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), { name: '@happier-dev/app', private: true });

  await mkdir(join(root, 'packages', 'protocol'), { recursive: true });
  await writeJson(join(root, 'packages', 'protocol', 'package.json'), { name: '@happier-dev/protocol', private: true });

  await mkdir(join(root, 'packages', 'plugins', 'claude'), { recursive: true });
  await writeJson(join(root, 'packages', 'plugins', 'claude', 'package.json'), { name: '@happier-dev/plugins-claude', private: true });

  await mkdir(join(root, 'packages', 'plugins', '_private'), { recursive: true });
  await writeJson(join(root, 'packages', 'plugins', '_private', 'package.json'), { name: '@happier-dev/plugins-private', private: true });

  const paths = await collectWorkspacePackageJsonPaths(root);
  const relativePaths = paths
    .map((path) => path.slice(root.length + 1).replaceAll('\\', '/'))
    .sort();

  assert.deepEqual(relativePaths, [
    'apps/ui/package.json',
    'packages/plugins/claude/package.json',
    'packages/protocol/package.json',
  ]);
});

test('reads quoted string globs and comments without loading installed dependencies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-workspace-patterns-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'pnpm-workspace.yaml'), [
    'packages: # canonical workspace set',
    '  - "apps/*" # apps',
    "  - 'packages/it''s-a-workspace'",
    '  # nested plugins',
    '  - packages/plugins/[a-z]*',
    'nodeLinker: hoisted',
    '',
  ].join('\n'));
  assert.deepEqual(await readWorkspacePatterns(root), ['apps/*', "packages/it's-a-workspace", 'packages/plugins/[a-z]*']);

  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: [apps/*]\n');
  await assert.rejects(readWorkspacePatterns(root), /Unsupported packages syntax/u);
});

test('reads an empty flow sequence as no workspace packages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hs-empty-workspace-patterns-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'packages', 'unused'), { recursive: true });
  await writeJson(join(root, 'packages', 'unused', 'package.json'), { name: '@fixture/unused' });
  for (const source of ['packages: []\n', 'packages: [ ] # no packages\r\nnodeLinker: hoisted\r\n']) {
    await writeFile(join(root, 'pnpm-workspace.yaml'), source);
    assert.deepEqual(await readWorkspacePatterns(root), []);
    assert.deepEqual(await collectWorkspacePackageJsonPaths(root), []);
  }
});

test('reads the declared Yarn predecessor workspace without requiring a pnpm manifest', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hs-yarn-workspaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeJson(join(root, 'package.json'), {
    packageManager: 'yarn@1.22.22', workspaces: { packages: ['apps/*', 'packages/*'] },
  });
  assert.deepEqual(await readWorkspacePatterns(root), ['apps/*', 'packages/*']);
  await writeJson(join(root, 'package.json'), { packageManager: 'pnpm@12.14.0', workspaces: ['wrong/*'] });
  await assert.rejects(readWorkspacePatterns(root), { code: 'ENOENT' });
});
