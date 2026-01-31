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

test('inferComponentFromCwd resolves components/<component> repo root', async (t) => {
  const rootDir = await withTempRoot(t);
  const prevWorkspace = process.env.HAPPY_STACKS_WORKSPACE_DIR;
  process.env.HAPPY_STACKS_WORKSPACE_DIR = rootDir;
  t.after(() => {
    if (prevWorkspace == null) {
      delete process.env.HAPPY_STACKS_WORKSPACE_DIR;
    } else {
      process.env.HAPPY_STACKS_WORKSPACE_DIR = prevWorkspace;
    }
  });

  const repoRoot = join(rootDir, 'components', 'happy');
  await mkdir(join(repoRoot, 'src'), { recursive: true });
  await writeFile(join(repoRoot, '.git'), 'gitdir: /tmp/fake\n', 'utf-8');

  const invokedCwd = join(repoRoot, 'src');
  const inferred = inferComponentFromCwd({ rootDir, invokedCwd, components: ['happy', 'happy-cli'] });
  assert.deepEqual(inferred, { component: 'happy', repoDir: repoRoot });
});

test('inferComponentFromCwd resolves happy monorepo subpackages under components/happy', async (t) => {
  const rootDir = await withTempRoot(t);
  const prevWorkspace = process.env.HAPPY_STACKS_WORKSPACE_DIR;
  process.env.HAPPY_STACKS_WORKSPACE_DIR = rootDir;
  t.after(() => {
    if (prevWorkspace == null) {
      delete process.env.HAPPY_STACKS_WORKSPACE_DIR;
    } else {
      process.env.HAPPY_STACKS_WORKSPACE_DIR = prevWorkspace;
    }
  });

  const monoRoot = join(rootDir, 'components', 'happy');
  await mkdir(join(monoRoot, 'packages', 'app'), { recursive: true });
  await mkdir(join(monoRoot, 'packages', 'cli', 'src'), { recursive: true });
  await mkdir(join(monoRoot, 'packages', 'server'), { recursive: true });
  await writeFile(join(monoRoot, 'packages', 'app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'packages', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'packages', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, '.git'), 'gitdir: /tmp/fake\n', 'utf-8');

  const invokedCwd = join(monoRoot, 'packages', 'cli', 'src');
  const inferred = inferComponentFromCwd({
    rootDir,
    invokedCwd,
    components: ['happy', 'happy-cli', 'happy-server'],
  });
  assert.deepEqual(inferred, { component: 'happy-cli', repoDir: monoRoot });
});

test('inferComponentFromCwd resolves happy monorepo worktree roots under components/.worktrees/happy', async (t) => {
  const rootDir = await withTempRoot(t);
  const prevWorkspace = process.env.HAPPY_STACKS_WORKSPACE_DIR;
  process.env.HAPPY_STACKS_WORKSPACE_DIR = rootDir;
  t.after(() => {
    if (prevWorkspace == null) {
      delete process.env.HAPPY_STACKS_WORKSPACE_DIR;
    } else {
      process.env.HAPPY_STACKS_WORKSPACE_DIR = prevWorkspace;
    }
  });

  const repoRoot = join(rootDir, 'components', '.worktrees', 'happy', 'slopus', 'pr', '123-fix');
  await mkdir(join(repoRoot, 'packages', 'app'), { recursive: true });
  await mkdir(join(repoRoot, 'packages', 'cli', 'nested'), { recursive: true });
  await mkdir(join(repoRoot, 'packages', 'server'), { recursive: true });
  await writeFile(join(repoRoot, 'packages', 'app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(repoRoot, 'packages', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(repoRoot, 'packages', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(repoRoot, '.git'), 'gitdir: /tmp/fake\n', 'utf-8');

  const invokedCwd = join(repoRoot, 'packages', 'cli', 'nested');
  const inferred = inferComponentFromCwd({ rootDir, invokedCwd, components: ['happy', 'happy-cli', 'happy-server'] });
  assert.deepEqual(inferred, { component: 'happy-cli', repoDir: repoRoot });
});

test('inferComponentFromCwd returns null outside known component roots', async (t) => {
  const rootDir = await withTempRoot(t);
  const prevWorkspace = process.env.HAPPY_STACKS_WORKSPACE_DIR;
  process.env.HAPPY_STACKS_WORKSPACE_DIR = rootDir;
  t.after(() => {
    if (prevWorkspace == null) {
      delete process.env.HAPPY_STACKS_WORKSPACE_DIR;
    } else {
      process.env.HAPPY_STACKS_WORKSPACE_DIR = prevWorkspace;
    }
  });

  const invokedCwd = join(rootDir, 'somewhere', 'else');
  await mkdir(invokedCwd, { recursive: true });
  const inferred = inferComponentFromCwd({ rootDir, invokedCwd, components: ['happy'] });
  assert.equal(inferred, null);
});
