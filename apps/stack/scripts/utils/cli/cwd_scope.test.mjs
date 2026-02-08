import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getInvokedCwd, inferComponentFromCwd } from './cwd_scope.mjs';

async function withTempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'happier-stacks-cwd-scope-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function createMonorepoCheckout({ rootDir, checkoutPath }) {
  const repoRoot = join(rootDir, checkoutPath);
  await mkdir(join(repoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(repoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(repoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(repoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(repoRoot, '.git'), 'gitdir: /tmp/fake\n', 'utf-8');
  return repoRoot;
}

function workspaceEnv(rootDir) {
  return { ...process.env, HAPPIER_STACK_WORKSPACE_DIR: rootDir };
}

function withMockedProcessCwd(t, value) {
  if (t.mock?.method) {
    t.mock.method(process, 'cwd', () => value);
    return;
  }
  const prevCwd = process.cwd;
  process.cwd = () => value;
  t.after(() => {
    process.cwd = prevCwd;
  });
}

test('inferComponentFromCwd resolves the stable monorepo checkout under <workspace>/main', async (t) => {
  const rootDir = await withTempRoot(t);
  const repoRoot = await createMonorepoCheckout({ rootDir, checkoutPath: 'main' });
  const inferred = inferComponentFromCwd({
    rootDir,
    invokedCwd: join(repoRoot, 'apps', 'ui'),
    components: ['happier-ui', 'happier-cli'],
    env: workspaceEnv(rootDir),
  });
  assert.deepEqual(inferred, { component: 'happier-ui', repoDir: repoRoot });
});

test('inferComponentFromCwd resolves happier monorepo subpackages under <workspace>/main', async (t) => {
  const rootDir = await withTempRoot(t);
  const repoRoot = await createMonorepoCheckout({ rootDir, checkoutPath: 'main' });
  const inferred = inferComponentFromCwd({
    rootDir,
    invokedCwd: join(repoRoot, 'apps', 'cli', 'src'),
    components: ['happier-ui', 'happier-cli', 'happier-server'],
    env: workspaceEnv(rootDir),
  });
  assert.deepEqual(inferred, { component: 'happier-cli', repoDir: repoRoot });
});

test('inferComponentFromCwd resolves happier monorepo worktree roots under <workspace>/pr', async (t) => {
  const rootDir = await withTempRoot(t);
  const repoRoot = await createMonorepoCheckout({ rootDir, checkoutPath: join('pr', '123-fix') });
  await mkdir(join(repoRoot, 'apps', 'cli', 'nested'), { recursive: true });
  const inferred = inferComponentFromCwd({
    rootDir,
    invokedCwd: join(repoRoot, 'apps', 'cli', 'nested'),
    components: ['happier-ui', 'happier-cli', 'happier-server'],
    env: workspaceEnv(rootDir),
  });
  assert.deepEqual(inferred, { component: 'happier-cli', repoDir: repoRoot });
});

test('inferComponentFromCwd returns null outside known component roots', async (t) => {
  const rootDir = await withTempRoot(t);
  const invokedCwd = join(rootDir, 'somewhere', 'else');
  await mkdir(invokedCwd, { recursive: true });
  const inferred = inferComponentFromCwd({
    rootDir,
    invokedCwd,
    components: ['happier-ui'],
    env: workspaceEnv(rootDir),
  });
  assert.equal(inferred, null);
});

test('inferComponentFromCwd uses the provided env (does not depend on process.env)', async (t) => {
  const rootDir = await withTempRoot(t);
  const repoRoot = await createMonorepoCheckout({ rootDir, checkoutPath: 'main' });
  const inferred = inferComponentFromCwd({
    rootDir,
    invokedCwd: join(repoRoot, 'apps', 'ui'),
    components: ['happier-ui'],
    env: workspaceEnv(rootDir),
  });
  assert.deepEqual(inferred, { component: 'happier-ui', repoDir: repoRoot });
});

test('getInvokedCwd falls back to process.cwd() when PWD is not set (Windows)', async (t) => {
  const dir = await withTempRoot(t);
  const expected = await realpath(dir).catch(() => dir);
  withMockedProcessCwd(t, dir);

  const actual = await realpath(getInvokedCwd({})).catch(() => getInvokedCwd({}));
  assert.equal(actual, expected);
});
