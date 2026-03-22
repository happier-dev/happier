import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildStackFixtureEnv } from './core/env_scope.mjs';
import { ensureMinimalMonorepoLayout } from './core/minimal_monorepo_layout.mjs';
import { runNodeCapture } from './core/run_node_capture.mjs';
import { resolveStackRootFromMeta, resolveStackScriptPath } from './core/stack_root.mjs';
import { createTempFixture } from './core/temp_fixture.mjs';

export async function setupStackNewMonorepoFixture({
  importMetaUrl,
  t,
  tmpPrefix = 'hstack-stack-new-monorepo-',
} = {}) {
  const rootDir = resolveStackRootFromMeta(importMetaUrl);
  const fixture = await createTempFixture(t, { prefix: tmpPrefix });
  const tmp = fixture.root;

  const workspaceDir = join(tmp, 'workspace');
  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const sandboxDir = join(tmp, 'sandbox');

  const cleanup = async () => {
    await fixture.cleanup();
  };

  const baseEnv = buildStackFixtureEnv({
    homeDir,
    workspaceDir,
    storageDir,
    sandboxDir,
  });

  async function createMonorepoCheckout(relativePath, { includeServerPrisma = false } = {}) {
    const monorepoRoot = join(workspaceDir, relativePath);
    await ensureMinimalMonorepoLayout(monorepoRoot, { includeServerPrisma });
    return monorepoRoot;
  }

  async function runStackNew(args) {
    return await runNodeCapture([resolveStackScriptPath(rootDir, 'stack.mjs'), 'new', ...args], {
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
