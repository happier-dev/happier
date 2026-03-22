import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { ensureMinimalMonorepoLayout } from './testkit/core/minimal_monorepo_layout.mjs';
import { writeStackCodeWorkspace } from './utils/stack/editor_workspace.mjs';

async function withStackEnvDirectories(tmp, callback) {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');

  const restore = withPatchedProcessEnv(null, {
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_HOME_DIR: homeDir,
  });

  try {
    await callback({ rootDir, storageDir });
  } finally {
    restore();
  }
}

test('stack code workspace groups monorepo components to the monorepo root', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'happier-stack-workspace-mono-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  await withStackEnvDirectories(tmp, async ({ rootDir, storageDir }) => {
    const stackName = 'exp-test';
    const monoRoot = join(tmp, 'mono');
    await ensureMinimalMonorepoLayout(monoRoot);

    const envPath = join(storageDir, stackName, 'env');
    await mkdir(dirname(envPath), { recursive: true });
    await writeFile(
      envPath,
      ['HAPPIER_STACK_SERVER_COMPONENT=happier-server', `HAPPIER_STACK_REPO_DIR=${monoRoot}`, ''].join('\n'),
      'utf-8'
    );

    const ws = await writeStackCodeWorkspace({
      rootDir,
      stackName,
      includeStackDir: false,
      includeAllComponents: false,
      includeCliHome: false,
    });

    assert.equal(ws.folders.length, 1);
    assert.equal(ws.folders[0].path, monoRoot);
  });
});

test('stack code workspace normalizes nested monorepo package path to monorepo root', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'happier-stack-workspace-mono-subdir-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  await withStackEnvDirectories(tmp, async ({ rootDir, storageDir }) => {
    const stackName = 'exp-subdir';
    const monoRoot = join(tmp, 'mono');
    await ensureMinimalMonorepoLayout(monoRoot);

    const envPath = join(storageDir, stackName, 'env');
    await mkdir(dirname(envPath), { recursive: true });
    await writeFile(
      envPath,
      ['HAPPIER_STACK_SERVER_COMPONENT=happier-server-light', `HAPPIER_STACK_REPO_DIR=${join(monoRoot, 'apps', 'ui')}`, ''].join('\n'),
      'utf-8'
    );

    const ws = await writeStackCodeWorkspace({
      rootDir,
      stackName,
      includeStackDir: false,
      includeAllComponents: false,
      includeCliHome: false,
    });

    assert.equal(ws.folders.length, 1);
    assert.equal(ws.folders[0].path, monoRoot);
  });
});
