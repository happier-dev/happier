import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { syncBundledWorkspacePackages } from './syncBundledWorkspacePackages.mjs';

async function withTempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-sync-bundled-workspaces-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('syncBundledWorkspacePackages copies workspace dist and sanitizes bundled package metadata', async (t) => {
  const root = await withTempRoot(t);
  const repoRoot = join(root, 'repo');
  const targetPackageRoot = join(root, 'runtime', 'cli');
  const protocolSrcDir = join(repoRoot, 'packages', 'protocol');
  const protocolDestDir = join(targetPackageRoot, 'node_modules', '@happier-dev', 'protocol');

  await mkdir(join(protocolSrcDir, 'dist'), { recursive: true });
  await writeFile(
    join(protocolSrcDir, 'package.json'),
    JSON.stringify({
      name: '@happier-dev/protocol',
      version: '0.0.0',
      type: 'module',
      exports: {
        '.': {
          default: './dist/index.mjs',
        },
      },
      scripts: {
        postinstall: 'echo no',
      },
      dependencies: {
        zod: '^1.0.0',
      },
    }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(join(protocolSrcDir, 'dist', 'index.mjs'), 'export const protocol = true;\n', 'utf-8');

  await mkdir(protocolDestDir, { recursive: true });
  await writeFile(join(protocolDestDir, 'package.json'), '{"name":"@happier-dev/protocol"}\n', 'utf-8');

  const result = await syncBundledWorkspacePackages({
    repoRoot,
    targetPackageRoot,
  });

  assert.deepEqual(result.updatedPackages, ['protocol']);
  assert.equal(await readFile(join(protocolDestDir, 'dist', 'index.mjs'), 'utf-8'), 'export const protocol = true;\n');
  assert.deepEqual(JSON.parse(await readFile(join(protocolDestDir, 'package.json'), 'utf-8')), {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    private: true,
    type: 'module',
    exports: {
      '.': {
        default: './dist/index.mjs',
      },
    },
    dependencies: {
      zod: '^1.0.0',
    },
  });
});

test('syncBundledWorkspacePackages skips bundled packages that are missing from the repo workspace set', async (t) => {
  const root = await withTempRoot(t);
  const repoRoot = join(root, 'repo');
  const targetPackageRoot = join(root, 'runtime', 'cli');
  const missingDestDir = join(targetPackageRoot, 'node_modules', '@happier-dev', 'missing-package');

  await mkdir(missingDestDir, { recursive: true });
  await writeFile(join(missingDestDir, 'package.json'), '{"name":"@happier-dev/missing-package"}\n', 'utf-8');

  const result = await syncBundledWorkspacePackages({
    repoRoot,
    targetPackageRoot,
  });

  assert.deepEqual(result.updatedPackages, []);
});
