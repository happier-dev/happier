import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getComponentDir, getComponentRepoDir } from './paths.mjs';

async function withTempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-paths-monorepo-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function writeHappyMonorepoStub({ rootDir }) {
  const monoRoot = join(rootDir, 'main');
  await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  return monoRoot;
}

test('getComponentDir derives monorepo component package dirs from workspace/main', async (t) => {
  const rootDir = await withTempRoot(t);
  const env = { HAPPIER_STACK_WORKSPACE_DIR: rootDir };

  const monoRoot = await writeHappyMonorepoStub({ rootDir });
  assert.equal(getComponentDir(rootDir, 'happy', env), join(monoRoot, 'apps', 'ui'));
  assert.equal(getComponentDir(rootDir, 'happy-cli', env), join(monoRoot, 'apps', 'cli'));
  assert.equal(getComponentDir(rootDir, 'happy-server', env), join(monoRoot, 'apps', 'server'));
  assert.equal(getComponentDir(rootDir, 'happy-server-light', env), join(monoRoot, 'apps', 'server'));
});

test('getComponentRepoDir returns the shared monorepo root for monorepo components', async (t) => {
  const rootDir = await withTempRoot(t);
  const env = { HAPPIER_STACK_WORKSPACE_DIR: rootDir };

  const monoRoot = await writeHappyMonorepoStub({ rootDir });
  assert.equal(getComponentRepoDir(rootDir, 'happy', env), monoRoot);
  assert.equal(getComponentRepoDir(rootDir, 'happy-cli', env), monoRoot);
  assert.equal(getComponentRepoDir(rootDir, 'happy-server', env), monoRoot);
  assert.equal(getComponentRepoDir(rootDir, 'happy-server-light', env), monoRoot);
});

test('getComponentDir normalizes HAPPIER_STACK_REPO_DIR that points inside the monorepo', async (t) => {
  const rootDir = await withTempRoot(t);
  const env = { HAPPIER_STACK_WORKSPACE_DIR: rootDir };

  const monoRoot = await writeHappyMonorepoStub({ rootDir });

  env.HAPPIER_STACK_REPO_DIR = join(monoRoot, 'apps', 'cli', 'src');
  assert.equal(getComponentDir(rootDir, 'happy-cli', env), join(monoRoot, 'apps', 'cli'));
});
