import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inferComponentFromCwd } from './cwd_scope.mjs';

async function withTempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-cwd-scope-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('inferComponentFromCwd resolves the default monorepo checkout under <workspace>/happier', async (t) => {
  const rootDir = await withTempRoot(t);
  const prevWorkspace = process.env.HAPPIER_STACK_WORKSPACE_DIR;
  process.env.HAPPIER_STACK_WORKSPACE_DIR = rootDir;
  t.after(() => {
    if (prevWorkspace == null) {
      delete process.env.HAPPIER_STACK_WORKSPACE_DIR;
    } else {
      process.env.HAPPIER_STACK_WORKSPACE_DIR = prevWorkspace;
    }
  });

  const repoRoot = join(rootDir, 'happier');
  await mkdir(join(repoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(repoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(repoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(repoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(repoRoot, '.git'), 'gitdir: /tmp/fake\n', 'utf-8');

  const invokedCwd = join(repoRoot, 'apps', 'ui');
  const inferred = inferComponentFromCwd({ rootDir, invokedCwd, components: ['happy', 'happy-cli'] });
  assert.deepEqual(inferred, { component: 'happy', repoDir: repoRoot });
});

test('inferComponentFromCwd resolves happier monorepo subpackages under <workspace>/happier', async (t) => {
  const rootDir = await withTempRoot(t);
  const prevWorkspace = process.env.HAPPIER_STACK_WORKSPACE_DIR;
  process.env.HAPPIER_STACK_WORKSPACE_DIR = rootDir;
  t.after(() => {
    if (prevWorkspace == null) {
      delete process.env.HAPPIER_STACK_WORKSPACE_DIR;
    } else {
      process.env.HAPPIER_STACK_WORKSPACE_DIR = prevWorkspace;
    }
  });

  const monoRoot = join(rootDir, 'happier');
  await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli', 'src'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, '.git'), 'gitdir: /tmp/fake\n', 'utf-8');

  const invokedCwd = join(monoRoot, 'apps', 'cli', 'src');
  const inferred = inferComponentFromCwd({
    rootDir,
    invokedCwd,
    components: ['happy', 'happy-cli', 'happy-server'],
  });
  assert.deepEqual(inferred, { component: 'happy-cli', repoDir: monoRoot });
});

test('inferComponentFromCwd resolves happy monorepo worktree roots under <workspace>/.worktrees', async (t) => {
  const rootDir = await withTempRoot(t);
  const prevWorkspace = process.env.HAPPIER_STACK_WORKSPACE_DIR;
  process.env.HAPPIER_STACK_WORKSPACE_DIR = rootDir;
  t.after(() => {
    if (prevWorkspace == null) {
      delete process.env.HAPPIER_STACK_WORKSPACE_DIR;
    } else {
      process.env.HAPPIER_STACK_WORKSPACE_DIR = prevWorkspace;
    }
  });

  const repoRoot = join(rootDir, '.worktrees', 'slopus', 'pr', '123-fix');
  await mkdir(join(repoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'cli', 'nested'), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(repoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(repoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(repoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(repoRoot, '.git'), 'gitdir: /tmp/fake\n', 'utf-8');

  const invokedCwd = join(repoRoot, 'apps', 'cli', 'nested');
  const inferred = inferComponentFromCwd({ rootDir, invokedCwd, components: ['happy', 'happy-cli', 'happy-server'] });
  assert.deepEqual(inferred, { component: 'happy-cli', repoDir: repoRoot });
});

test('inferComponentFromCwd returns null outside known component roots', async (t) => {
  const rootDir = await withTempRoot(t);
  const prevWorkspace = process.env.HAPPIER_STACK_WORKSPACE_DIR;
  process.env.HAPPIER_STACK_WORKSPACE_DIR = rootDir;
  t.after(() => {
    if (prevWorkspace == null) {
      delete process.env.HAPPIER_STACK_WORKSPACE_DIR;
    } else {
      process.env.HAPPIER_STACK_WORKSPACE_DIR = prevWorkspace;
    }
  });

  const invokedCwd = join(rootDir, 'somewhere', 'else');
  await mkdir(invokedCwd, { recursive: true });
  const inferred = inferComponentFromCwd({ rootDir, invokedCwd, components: ['happy'] });
  assert.equal(inferred, null);
});
