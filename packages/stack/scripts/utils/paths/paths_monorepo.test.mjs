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
  const monoRoot = join(rootDir, 'components', 'happy');
  await mkdir(join(monoRoot, 'packages', 'app'), { recursive: true });
  await mkdir(join(monoRoot, 'packages', 'cli'), { recursive: true });
  await mkdir(join(monoRoot, 'packages', 'server'), { recursive: true });
  await writeFile(join(monoRoot, 'packages', 'app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'packages', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'packages', 'server', 'package.json'), '{}\n', 'utf-8');
  return monoRoot;
}

test('getComponentDir derives monorepo component package dirs from components/happy', async (t) => {
  const rootDir = await withTempRoot(t);
  const env = { HAPPY_STACKS_WORKSPACE_DIR: rootDir };

  const monoRoot = await writeHappyMonorepoStub({ rootDir });
  assert.equal(getComponentDir(rootDir, 'happy', env), join(monoRoot, 'packages', 'app'));
  assert.equal(getComponentDir(rootDir, 'happy-cli', env), join(monoRoot, 'packages', 'cli'));
  assert.equal(getComponentDir(rootDir, 'happy-server', env), join(monoRoot, 'packages', 'server'));
  assert.equal(getComponentDir(rootDir, 'happy-server-light', env), join(monoRoot, 'packages', 'server'));
});

test('getComponentRepoDir returns the shared monorepo root for monorepo components', async (t) => {
  const rootDir = await withTempRoot(t);
  const env = { HAPPY_STACKS_WORKSPACE_DIR: rootDir };

  const monoRoot = await writeHappyMonorepoStub({ rootDir });
  assert.equal(getComponentRepoDir(rootDir, 'happy', env), monoRoot);
  assert.equal(getComponentRepoDir(rootDir, 'happy-cli', env), monoRoot);
  assert.equal(getComponentRepoDir(rootDir, 'happy-server', env), monoRoot);
  assert.equal(getComponentRepoDir(rootDir, 'happy-server-light', env), monoRoot);
});

test('getComponentDir normalizes monorepo env overrides that point inside the repo', async (t) => {
  const rootDir = await withTempRoot(t);
  const env = { HAPPY_STACKS_WORKSPACE_DIR: rootDir };

  const monoRoot = await writeHappyMonorepoStub({ rootDir });

  env.HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI = join(monoRoot, 'packages', 'cli', 'src');
  assert.equal(getComponentDir(rootDir, 'happy-cli', env), join(monoRoot, 'packages', 'cli'));
});
