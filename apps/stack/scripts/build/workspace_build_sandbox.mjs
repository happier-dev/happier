import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { pathExists } from '../utils/fs/fs.mjs';

export async function findWorkspaceMonorepoRoot(startDir) {
  let dir = resolve(startDir);
  for (let i = 0; i < 12; i += 1) {
    if ((await pathExists(join(dir, 'package.json'))) && (await pathExists(join(dir, 'yarn.lock')))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`[build] failed to locate monorepo root from ${startDir}`);
}

async function copyIntoSandbox({ sourceRoot, sandboxRoot, relativePath }) {
  const sourcePath = join(sourceRoot, relativePath);
  const destPath = join(sandboxRoot, relativePath);
  await cp(sourcePath, destPath, { recursive: true });
}

export async function createWorkspaceBuildSandbox({ packageDir, extraRelativePaths = [] }) {
  const monorepoRoot = await findWorkspaceMonorepoRoot(packageDir);
  const packageRelativeDir = relative(monorepoRoot, resolve(packageDir));
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'hstack-build-sandbox-'));

  await copyIntoSandbox({ sourceRoot: monorepoRoot, sandboxRoot, relativePath: 'package.json' });
  await copyIntoSandbox({ sourceRoot: monorepoRoot, sandboxRoot, relativePath: 'yarn.lock' });
  await copyIntoSandbox({ sourceRoot: monorepoRoot, sandboxRoot, relativePath: packageRelativeDir });
  for (const extraRelativePath of extraRelativePaths) {
    await copyIntoSandbox({ sourceRoot: monorepoRoot, sandboxRoot, relativePath: extraRelativePath });
  }
  if (await pathExists(join(monorepoRoot, 'node_modules'))) {
    await symlink(join(monorepoRoot, 'node_modules'), join(sandboxRoot, 'node_modules'), 'junction');
  }

  return {
    monorepoRoot,
    sandboxRoot,
    sandboxPackageDir: join(sandboxRoot, packageRelativeDir),
    async cleanup() {
      await rm(sandboxRoot, { recursive: true, force: true });
    },
  };
}
