import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCapture } from '../proc/proc.mjs';
import { resolveBaseRef } from './base_ref.mjs';

async function runGit(cwd, args) {
  await runCapture('git', args, { cwd });
}

async function makeRepoWithRemoteHead() {
  const root = await mkdtemp(join(tmpdir(), 'hs-review-base-ref-'));
  const remote = join(root, 'remote.git');
  const local = join(root, 'local');

  await runGit(root, ['init', '--bare', remote]);
  await runGit(root, ['init', '-b', 'main', local]);
  await runGit(local, ['config', 'user.email', 'test@example.com']);
  await runGit(local, ['config', 'user.name', 'Test User']);
  await writeFile(join(local, 'file.txt'), 'hello\n', 'utf-8');
  await runGit(local, ['add', '.']);
  await runGit(local, ['commit', '-m', 'initial']);
  await runGit(local, ['remote', 'add', 'upstream', remote]);
  await runGit(local, ['push', '-u', 'upstream', 'main']);
  // In CI, `git init --bare` may default HEAD to `master`, and `remote set-head --auto` fails
  // with "Cannot determine remote HEAD" if that branch doesn't exist. Make it deterministic.
  await runGit(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  // Ensure refs/remotes/upstream/HEAD exists.
  await runGit(local, ['remote', 'set-head', 'upstream', '--auto']);

  return { root, local };
}

test('resolveBaseRef uses explicit --base-ref override', async () => {
  const { root, local } = await makeRepoWithRemoteHead();
  try {
    const res = await resolveBaseRef({ cwd: local, baseRefOverride: 'upstream/main' });
    assert.equal(res.baseRef, 'upstream/main');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveBaseRef infers default branch from refs/remotes/<remote>/HEAD', async () => {
  const { root, local } = await makeRepoWithRemoteHead();
  try {
    const res = await resolveBaseRef({ cwd: local, baseRemoteOverride: 'upstream' });
    assert.equal(res.baseRef, 'upstream/main');
    assert.equal(res.remote, 'upstream');
    assert.equal(res.branch, 'main');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

