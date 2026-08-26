import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { resolveRepoStackIdentity } from './repo_stack_identity.mjs';

function createWindowsFileOps(filesByPath) {
  const normalized = (path) => String(path).replaceAll('/', '\\').toLowerCase();
  const files = new Map(Object.entries(filesByPath).map(([path, contents]) => [normalized(path), contents]));
  const writes = [];
  return {
    writes,
    existsSync(path) {
      return files.has(normalized(path));
    },
    readFileSync(path) {
      const contents = files.get(normalized(path));
      if (contents == null) throw new Error(`missing fixture file: ${path}`);
      return contents;
    },
    writeFileSync(path, contents) {
      const value = String(contents);
      files.set(normalized(path), value);
      writes.push({ path, contents: value });
    },
  };
}

test('repo Stack identity reuses the Git-owned stable id across paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-repo-identity-'));
  const repoRoot = join(root, 'Happier Dev');
  const stacksStorageRoot = join(root, 'stacks');
  await mkdir(join(repoRoot, '.git'), { recursive: true });
  await writeFile(join(repoRoot, '.git', 'happier-stack-stackless-id'), 'abcdef0123456789\n');
  try {
    const identity = resolveRepoStackIdentity({ repoRoot, stacksStorageRoot });
    assert.equal(identity.stackName, 'repo-happier-dev-abcdef0123');
    assert.equal(identity.stackBaseDir, join(stacksStorageRoot, identity.stackName));
    assert.equal(identity.devTargetsConfigPath, join(identity.stackBaseDir, 'dev-targets.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repo Stack identity reuses the Git-owned stable basename after the checkout moves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-repo-identity-base-'));
  const repoRoot = join(root, '0.3');
  const stacksStorageRoot = join(root, 'stacks');
  await mkdir(join(repoRoot, '.git'), { recursive: true });
  await writeFile(join(repoRoot, '.git', 'happier-stack-stackless-id'), 'abcdef0123456789\n');
  await writeFile(join(repoRoot, '.git', 'happier-stack-stackless-base'), 'dev\n');
  try {
    const identity = resolveRepoStackIdentity({ repoRoot, stacksStorageRoot });
    assert.equal(identity.stackName, 'repo-dev-abcdef0123');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('read-only identity resolution preserves the legacy path hash without creating Git state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-repo-identity-readonly-'));
  const repoRoot = join(root, 'checkout');
  await mkdir(join(repoRoot, '.git'), { recursive: true });
  try {
    const expectedId = createHash('sha256').update(repoRoot).digest('hex').slice(0, 10);
    const identity = resolveRepoStackIdentity({
      repoRoot,
      stacksStorageRoot: join(root, 'stacks'),
      createIfMissing: false,
    });
    assert.equal(basename(identity.stackBaseDir), `repo-checkout-${expectedId}`);
    await assert.rejects(access(join(repoRoot, '.git', 'happier-stack-stackless-id')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows linked worktrees share the common Git-owned stack identity', () => {
  const storageRoot = 'C:\\Users\\qa\\.happier\\stacks';
  const commonGitDir = 'C:\\src\\happier\\.git';
  const firstWorktree = 'C:\\src\\worktrees\\one\\Happier Dev';
  const secondWorktree = 'C:\\src\\worktrees\\two\\Happier Dev';
  const firstGitDir = `${commonGitDir}\\worktrees\\one`;
  const secondGitDir = `${commonGitDir}\\worktrees\\two`;
  const fileOps = createWindowsFileOps({
    [`${firstWorktree}\\.git`]: `gitdir: ${firstGitDir}\n`,
    [`${secondWorktree}\\.git`]: `gitdir: ${secondGitDir}\n`,
    [`${firstGitDir}\\commondir`]: '..\\..\n',
    [`${secondGitDir}\\commondir`]: '..\\..\n',
  });

  const first = resolveRepoStackIdentity({
    repoRoot: firstWorktree,
    stacksStorageRoot: storageRoot,
    createIfMissing: true,
    fileOps,
  });
  const second = resolveRepoStackIdentity({
    repoRoot: secondWorktree,
    stacksStorageRoot: storageRoot,
    createIfMissing: true,
    fileOps,
  });

  assert.equal(first.stackName, second.stackName);
  assert.match(first.stackName, /^repo-happier-dev-[a-f0-9]{10}$/);
  assert.equal(fileOps.writes.length, 2);
  assert.deepEqual(fileOps.writes.map((write) => write.path).sort(), [
    `${commonGitDir}\\happier-stack-stackless-base`,
    `${commonGitDir}\\happier-stack-stackless-id`,
  ]);
  assert.equal(first.stackBaseDir, `${storageRoot}\\${first.stackName}`);
});
