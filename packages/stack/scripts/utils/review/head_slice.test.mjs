import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, runCapture } from '../proc/proc.mjs';
import { createHeadSliceCommits, getChangedOps } from './head_slice.mjs';

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

test('createHeadSliceCommits produces a focused diff while keeping full HEAD code', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'happy-review-head-slice-'));
  const env = gitEnv();

  const wt = join(repo, 'wt');
  try {
    await run('git', ['init', '-q'], { cwd: repo, env });
    await run('git', ['checkout', '-q', '-b', 'main'], { cwd: repo, env });
    await mkdir(join(repo, 'packages', 'app'), { recursive: true });
    await mkdir(join(repo, 'packages', 'cli'), { recursive: true });
    await mkdir(join(repo, 'packages', 'server'), { recursive: true });
    await writeFile(join(repo, 'packages', 'app', 'a.txt'), 'base-a\n', 'utf-8');
    await writeFile(join(repo, 'packages', 'cli', 'c.txt'), 'base-c\n', 'utf-8');
    await writeFile(join(repo, 'packages', 'server', 'b.txt'), 'base-b\n', 'utf-8');
    await run('git', ['add', '.'], { cwd: repo, env });
    await run('git', ['commit', '-q', '-m', 'chore: base'], { cwd: repo, env });

    // HEAD commit with mixed changes across areas.
    await writeFile(join(repo, 'packages', 'app', 'a.txt'), 'head-a\n', 'utf-8');
    await writeFile(join(repo, 'packages', 'app', 'new.txt'), 'new\n', 'utf-8');
    await writeFile(join(repo, 'packages', 'cli', 'c.txt'), 'head-c\n', 'utf-8');
    await rm(join(repo, 'packages', 'server', 'b.txt'));
    await run('git', ['add', '-A'], { cwd: repo, env });
    await run('git', ['commit', '-q', '-m', 'feat: head'], { cwd: repo, env });

    const headCommit = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: repo, env })).trim();
    const baseCommit = (await runCapture('git', ['rev-parse', 'HEAD^'], { cwd: repo, env })).trim();

    // Create an ephemeral worktree to run the slice commit builder in isolation.
    await run('git', ['worktree', 'add', '--detach', wt, baseCommit], { cwd: repo, env });

    const ops = await getChangedOps({ cwd: repo, baseRef: baseCommit, headRef: headCommit, env });
    const { baseSliceCommit, headSliceCommit } = await createHeadSliceCommits({
      cwd: wt,
      env,
      baseRef: baseCommit,
      headCommit,
      ops,
      slicePaths: ['packages/app/a.txt', 'packages/app/new.txt'],
      label: 'packages/app',
    });

    // Working tree should match full HEAD.
    const a = await readFile(join(wt, 'packages', 'app', 'a.txt'), 'utf-8');
    const c = await readFile(join(wt, 'packages', 'cli', 'c.txt'), 'utf-8');
    assert.equal(a, 'head-a\n');
    assert.equal(c, 'head-c\n');
    await assert.rejects(async () => await readFile(join(wt, 'packages', 'server', 'b.txt'), 'utf-8'));

    // Diff between slice commits should include only packages/app changes.
    const diffNames = (
      await runCapture('git', ['diff', '--name-only', `${baseSliceCommit}...${headSliceCommit}`], { cwd: wt, env })
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .sort();
    assert.deepEqual(diffNames, ['packages/app/a.txt', 'packages/app/new.txt']);
  } finally {
    try {
      await run('git', ['worktree', 'remove', '--force', wt], { cwd: repo, env });
      await run('git', ['worktree', 'prune'], { cwd: repo, env });
    } catch {
      // ignore cleanup errors (best-effort)
    }
    await rm(repo, { recursive: true, force: true });
  }
});
