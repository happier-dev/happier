import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectWorkspacePackageJsonPaths } from './workspace_package_manifests.mjs';

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

test('collectWorkspacePackageJsonPaths expands character-class workspace globs for plugin packages', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-workspace-package-manifests-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await writeJson(join(root, 'package.json'), {
    name: 'repo',
    private: true,
    workspaces: {
      packages: [
        'apps/ui',
        'packages/protocol',
        'packages/plugins/[a-z]*',
      ],
    },
  });

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
