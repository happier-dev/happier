import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeStackCodeWorkspace } from './utils/stack/editor_workspace.mjs';

async function createMonorepoCheckout(rootDir) {
  await mkdir(join(rootDir, 'apps', 'ui'), { recursive: true });
  await mkdir(join(rootDir, 'apps', 'cli'), { recursive: true });
  await mkdir(join(rootDir, 'apps', 'server'), { recursive: true });
  await writeFile(join(rootDir, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(rootDir, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(rootDir, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
}

async function withStackEnvDirectories(tmp, callback) {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');

  const prevStorage = process.env.HAPPIER_STACK_STORAGE_DIR;
  const prevHome = process.env.HAPPIER_STACK_HOME_DIR;
  process.env.HAPPIER_STACK_STORAGE_DIR = storageDir;
  process.env.HAPPIER_STACK_HOME_DIR = homeDir;

  try {
    await callback({ rootDir, storageDir });
  } finally {
    if (prevStorage == null) delete process.env.HAPPIER_STACK_STORAGE_DIR;
    else process.env.HAPPIER_STACK_STORAGE_DIR = prevStorage;
    if (prevHome == null) delete process.env.HAPPIER_STACK_HOME_DIR;
    else process.env.HAPPIER_STACK_HOME_DIR = prevHome;
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
    await createMonorepoCheckout(monoRoot);

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
    await createMonorepoCheckout(monoRoot);

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
