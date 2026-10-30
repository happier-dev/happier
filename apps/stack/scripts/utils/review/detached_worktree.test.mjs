import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGitIdentityEnv } from '../../testkit/core/env_scope.mjs';
import { run, runCapture } from '../proc/proc.mjs';
import { withDetachedWorktree } from './detached_worktree.mjs';

test('withDetachedWorktree can be called repeatedly without directory collisions', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'happy-review-wt-'));
  const env = buildGitIdentityEnv();

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
