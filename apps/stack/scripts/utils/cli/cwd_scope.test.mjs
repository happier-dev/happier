import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { ensureMinimalMonorepoLayout } from '../../testkit/core/minimal_monorepo_layout.mjs';
import { getInvokedCwd, inferComponentFromCwd } from './cwd_scope.mjs';

async function createMonorepoCheckout({ rootDir, checkoutPath }) {
  const repoRoot = join(rootDir, checkoutPath);
  await ensureMinimalMonorepoLayout(repoRoot, { writeGitDirMarker: true });
  await mkdir(join(repoRoot, 'apps', 'cli', 'src'), { recursive: true });
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
  const fixture = await createTempFixture(t, { prefix: 'happier-stacks-cwd-scope-' });
  const rootDir = fixture.root;
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
  const fixture = await createTempFixture(t, { prefix: 'happier-stacks-cwd-scope-' });
  const rootDir = fixture.root;
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
  const fixture = await createTempFixture(t, { prefix: 'happier-stacks-cwd-scope-' });
  const rootDir = fixture.root;
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
  const fixture = await createTempFixture(t, { prefix: 'happier-stacks-cwd-scope-' });
  const rootDir = fixture.root;
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
  const fixture = await createTempFixture(t, { prefix: 'happier-stacks-cwd-scope-' });
  const rootDir = fixture.root;
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
  const fixture = await createTempFixture(t, { prefix: 'happier-stacks-cwd-scope-' });
  const dir = fixture.root;
  const expected = await realpath(dir).catch(() => dir);
  withMockedProcessCwd(t, dir);

  const actual = await realpath(getInvokedCwd({})).catch(() => getInvokedCwd({}));
  assert.equal(actual, expected);
});

test('getInvokedCwd prefers OLDPWD when it looks like the real repo/worktree root', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'happier-stacks-cwd-scope-' });
  const rootDir = fixture.root;
  const oldPwd = join(rootDir, 'dev');
  const pwd = join(rootDir, 'main');
  await mkdir(oldPwd, { recursive: true });
  await mkdir(pwd, { recursive: true });
  await ensureMinimalMonorepoLayout(oldPwd, { writeGitDirMarker: true });

  withMockedProcessCwd(t, pwd);
  const actual = getInvokedCwd({ PWD: pwd, OLDPWD: oldPwd });
  assert.equal(actual, oldPwd);
});

test('getInvokedCwd prefers PWD when both PWD and OLDPWD look like repo/worktree roots', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'happier-stacks-cwd-scope-' });
  const rootDir = fixture.root;
  const oldPwd = join(rootDir, 'dev');
  const pwd = join(rootDir, 'main');
  await ensureMinimalMonorepoLayout(oldPwd, { writeGitDirMarker: true });
  await ensureMinimalMonorepoLayout(pwd, { writeGitDirMarker: true });

  withMockedProcessCwd(t, pwd);
  const actual = getInvokedCwd({ PWD: pwd, OLDPWD: oldPwd });
  assert.equal(actual, pwd);
});

test('getInvokedCwd falls back to OLDPWD when PWD does not look like a checkout/worktree root', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'happier-stacks-cwd-scope-' });
  const rootDir = fixture.root;
  const oldPwd = join(rootDir, 'dev');
  const pwd = join(rootDir, 'not-a-worktree');
  await mkdir(oldPwd, { recursive: true });
  await mkdir(pwd, { recursive: true });
  await ensureMinimalMonorepoLayout(oldPwd, { writeGitDirMarker: true });

  withMockedProcessCwd(t, pwd);
  const actual = getInvokedCwd({ PWD: pwd, OLDPWD: oldPwd });
  assert.equal(actual, oldPwd);
});
