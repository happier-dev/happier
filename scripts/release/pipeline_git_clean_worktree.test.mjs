import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { assertCleanWorktree } from '../pipeline/git/ensure-clean-worktree.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('assertCleanWorktree passes on a clean repo', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'happier-git-clean-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);

  await writeFile(path.join(dir, 'a.txt'), 'hello\n', 'utf8');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-m', 'init']);

  assertCleanWorktree({ cwd: dir, allowDirty: false });
});

test('assertCleanWorktree fails when repo has uncommitted changes (unless allowDirty)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'happier-git-dirty-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);

  await writeFile(path.join(dir, 'a.txt'), 'hello\n', 'utf8');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-m', 'init']);

  await writeFile(path.join(dir, 'a.txt'), 'changed\n', 'utf8');

  assert.throws(() => assertCleanWorktree({ cwd: dir, allowDirty: false }), /git worktree is dirty/i);
  assert.doesNotThrow(() => assertCleanWorktree({ cwd: dir, allowDirty: true }));
});

