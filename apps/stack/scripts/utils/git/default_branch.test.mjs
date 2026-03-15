import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCapture } from '../proc/proc.mjs';

import { resolveDefaultRemoteBranch } from './default_branch.mjs';

async function initRepo(dir) {
  await runCapture('git', ['init'], { cwd: dir });
  await runCapture('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await runCapture('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'hello\n', 'utf-8');
  await runCapture('git', ['add', '.'], { cwd: dir });
  await runCapture('git', ['commit', '-m', 'seed'], { cwd: dir });
}

test('resolveDefaultRemoteBranch reads origin/HEAD symbolic ref', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-default-branch-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  await initRepo(dir);
  const head = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: dir })).trim();

  await runCapture('git', ['update-ref', 'refs/remotes/origin/dev', head], { cwd: dir });
  await runCapture('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/dev'], { cwd: dir });

  const branch = await resolveDefaultRemoteBranch({ dir, remote: 'origin' });
  assert.equal(branch, 'dev');
});

test('resolveDefaultRemoteBranch returns empty when remote head is missing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-default-branch-missing-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  await initRepo(dir);

  const branch = await resolveDefaultRemoteBranch({ dir, remote: 'origin' });
  assert.equal(branch, '');
});
