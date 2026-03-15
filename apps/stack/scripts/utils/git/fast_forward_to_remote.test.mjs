import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { fastForwardBranchToRemote } from './fast_forward_to_remote.mjs';

function git(cwd, args, { allowFail = false } = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (!allowFail && res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (cwd=${cwd})\n${res.stderr || res.stdout || ''}`.trim());
  }
  return String(res.stdout ?? '').trim();
}

function commitAll(cwd, message) {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', message]);
}

async function setupRemoteAndClone(t) {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-ff-remote-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const remoteBare = join(tmp, 'remote.git');
  git(tmp, ['init', '--bare', remoteBare]);

  const work = join(tmp, 'work');
  git(tmp, ['clone', remoteBare, work]);
  await writeFile(join(work, 'README.md'), 'one\n', 'utf-8');
  commitAll(work, 'init');
  git(work, ['branch', '-M', 'main']);
  git(work, ['push', 'origin', 'main']);

  const local = join(tmp, 'local');
  git(tmp, ['clone', remoteBare, local]);
  git(local, ['checkout', '-q', 'main']);

  return { tmp, remoteBare, work, local };
}

test('fastForwardBranchToRemote fast-forwards a clean repo that is behind', async (t) => {
  const { work, local } = await setupRemoteAndClone(t);

  const beforeLocal = git(local, ['rev-parse', 'HEAD']);

  await writeFile(join(work, 'README.md'), 'two\n', 'utf-8');
  commitAll(work, 'bump');
  git(work, ['push', 'origin', 'main']);
  const remoteHead = git(work, ['rev-parse', 'HEAD']);

  const res = await fastForwardBranchToRemote({ dir: local, remote: 'origin', branch: 'main' });
  assert.equal(res.ok, true);
  assert.equal(res.updated, true);

  const afterLocal = git(local, ['rev-parse', 'HEAD']);
  assert.notEqual(afterLocal, beforeLocal);
  assert.equal(afterLocal, remoteHead);
});

test('fastForwardBranchToRemote refuses to update a dirty working tree', async (t) => {
  const { work, local } = await setupRemoteAndClone(t);

  await writeFile(join(local, 'DIRTY.txt'), 'x\n', 'utf-8');

  await writeFile(join(work, 'README.md'), 'two\n', 'utf-8');
  commitAll(work, 'bump');
  git(work, ['push', 'origin', 'main']);

  const beforeLocal = git(local, ['rev-parse', 'HEAD']);
  const res = await fastForwardBranchToRemote({ dir: local, remote: 'origin', branch: 'main' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'dirty');
  assert.equal(git(local, ['rev-parse', 'HEAD']), beforeLocal);
});

test('fastForwardBranchToRemote refuses to update when local is ahead of remote', async (t) => {
  const { local } = await setupRemoteAndClone(t);

  await writeFile(join(local, 'AHEAD.txt'), 'x\n', 'utf-8');
  commitAll(local, 'ahead');

  const res = await fastForwardBranchToRemote({ dir: local, remote: 'origin', branch: 'main' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'ahead');
});
