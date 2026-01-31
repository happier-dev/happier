import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findGitRootForPath, normalizeGitRoots } from './git_roots.mjs';

async function withTempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-edison-git-roots-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('findGitRootForPath returns nearest ancestor containing .git marker', async (t) => {
  const root = await withTempRoot(t);
  const repoRoot = join(root, 'repo');
  await mkdir(join(repoRoot, 'a', 'b'), { recursive: true });
  await writeFile(join(repoRoot, '.git'), 'gitdir: /tmp/fake\n', 'utf-8');

  assert.equal(findGitRootForPath(join(repoRoot, 'a', 'b')), repoRoot);
});

test('normalizeGitRoots de-duplicates multiple paths inside the same repo', async (t) => {
  const root = await withTempRoot(t);
  const repoRoot = join(root, 'repo');
  await mkdir(join(repoRoot, 'packages', 'app'), { recursive: true });
  await mkdir(join(repoRoot, 'packages', 'cli'), { recursive: true });
  await writeFile(join(repoRoot, '.git'), 'gitdir: /tmp/fake\n', 'utf-8');

  const roots = normalizeGitRoots([join(repoRoot, 'packages', 'app'), join(repoRoot, 'packages', 'cli')]);
  assert.deepEqual(roots, [repoRoot]);
});
