import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNodeCapture } from './stack_script_cmd.testHelper.mjs';

export async function setupStackNewMonorepoFixture({
  importMetaUrl,
  t,
  tmpPrefix = 'hstack-stack-new-monorepo-',
} = {}) {
  const scriptsDir = dirname(fileURLToPath(importMetaUrl));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), tmpPrefix));

  const workspaceDir = join(tmp, 'workspace');
  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const sandboxDir = join(tmp, 'sandbox');

  const cleanup = async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  };
  if (t?.after) t.after(cleanup);

  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_SANDBOX_DIR: sandboxDir,
  };

  async function createMonorepoCheckout(relativePath, { includeServerPrisma = false } = {}) {
    const monorepoRoot = join(workspaceDir, relativePath);
    await mkdir(join(monorepoRoot, 'apps', 'ui'), { recursive: true });
    await mkdir(join(monorepoRoot, 'apps', 'cli'), { recursive: true });
    await mkdir(join(monorepoRoot, 'apps', 'server'), { recursive: true });
    await writeFile(join(monorepoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(monorepoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(monorepoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
    if (includeServerPrisma) {
      await mkdir(join(monorepoRoot, 'apps', 'server', 'prisma', 'sqlite'), { recursive: true });
      await writeFile(
        join(monorepoRoot, 'apps', 'server', 'prisma', 'schema.prisma'),
        'datasource db { provider = "postgresql" }\n',
        'utf-8'
      );
      await writeFile(
        join(monorepoRoot, 'apps', 'server', 'prisma', 'sqlite', 'schema.prisma'),
        'datasource db { provider = "sqlite" }\n',
        'utf-8'
      );
    }
    return monorepoRoot;
  }

  async function runStackNew(args) {
    return await runNodeCapture([join(rootDir, 'scripts', 'stack.mjs'), 'new', ...args], {
      cwd: rootDir,
      env: baseEnv,
    });
  }

  async function readStackEnv(stackName) {
    return await readFile(join(storageDir, stackName, 'env'), 'utf-8');
  }

  return {
    rootDir,
    tmp,
    workspaceDir,
    storageDir,
    homeDir,
    sandboxDir,
    baseEnv,
    cleanup,
    createMonorepoCheckout,
    runStackNew,
    readStackEnv,
  };
}
