import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, runCapture } from '../proc/proc.mjs';
import { computeDetachedWorktreeDir, withDetachedWorktree } from './detached_worktree.mjs';

function gitEnv() {
  const clean = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('HAPPY_STACKS_') || k.startsWith('HAPPY_LOCAL_')) continue;
    clean[k] = v;
  }
  return {
    ...clean,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

test('computeDetachedWorktreeDir includes nonce to avoid collisions', () => {
  const dir1 = computeDetachedWorktreeDir({ repoRootDir: '/repo', label: 'coderabbit-1-of-21', headCommit: 'abcdef0123456789', nonce: 'n1' });
  const dir2 = computeDetachedWorktreeDir({ repoRootDir: '/repo', label: 'coderabbit-1-of-21', headCommit: 'abcdef0123456789', nonce: 'n2' });
  assert.notEqual(dir1, dir2);
  assert.ok(dir1.includes('coderabbit-1-of-21-abcdef012345-n1'));
  assert.ok(dir2.includes('coderabbit-1-of-21-abcdef012345-n2'));
});

test('withDetachedWorktree can be called repeatedly without directory collisions', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'happy-review-wt-'));
  const env = gitEnv();

  try {
    await run('git', ['init', '-q'], { cwd: repo, env });
    await run('git', ['checkout', '-q', '-b', 'main'], { cwd: repo, env });
    await mkdir(join(repo, 'x'), { recursive: true });
    await writeFile(join(repo, 'x', 'a.txt'), 'a\n', 'utf-8');
    await run('git', ['add', '.'], { cwd: repo, env });
    await run('git', ['commit', '-q', '-m', 'base'], { cwd: repo, env });

    const head = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: repo, env })).trim();

    const seen = [];
    await withDetachedWorktree({ repoDir: repo, headCommit: head, label: 'test', env, nonce: 'one' }, async (dir) => {
      seen.push(dir);
      assert.equal((await runCapture('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, env })).trim(), 'true');
    });
    await withDetachedWorktree({ repoDir: repo, headCommit: head, label: 'test', env, nonce: 'two' }, async (dir) => {
      seen.push(dir);
      assert.equal((await runCapture('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, env })).trim(), 'true');
    });

    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

