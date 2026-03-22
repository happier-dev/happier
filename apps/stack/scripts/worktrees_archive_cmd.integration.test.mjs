import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCommandCapture, runNodeCapture } from './testkit/stack_script_command_testkit.mjs';
import { createStackArchiveFixture } from './testkit/stack_archive_command_testkit.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

async function runOk(cmd, args, { cwd, env }) {
  const res = await runCommandCapture(cmd, args, { cwd, env });
  assert.equal(res.code, 0, `expected exit 0 for ${cmd} ${args.join(' ')}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  return res;
}

test('hstack wt archive detaches and moves a git worktree (preserving uncommitted changes)', async (t) => {
  const { baseEnv, repoDir, workspaceDir, worktreeDir } = await createStackArchiveFixture(t, {
    worktreeSlug: 'test-archive',
    attachStack: false,
  });

  await writeFile(join(worktreeDir, 'staged.txt'), 'staged\n', 'utf-8');
  await runOk('git', ['add', 'staged.txt'], { cwd: worktreeDir, env: baseEnv });
  await writeFile(join(worktreeDir, 'untracked.txt'), 'untracked\n', 'utf-8');
  await writeFile(join(worktreeDir, 'README.md'), 'hello\nchanged\n', 'utf-8');

  const beforeStatus = await runOk('git', ['status', '--porcelain'], { cwd: worktreeDir, env: baseEnv });
  assert.ok(beforeStatus.stdout.includes('A  staged.txt'), `expected staged file in status\n${beforeStatus.stdout}`);
  assert.ok(beforeStatus.stdout.includes(' M README.md'), `expected modified file in status\n${beforeStatus.stdout}`);
  assert.ok(beforeStatus.stdout.includes('?? untracked.txt'), `expected untracked file in status\n${beforeStatus.stdout}`);

  const date = '2000-01-02';
  const nodeEnv = { ...baseEnv, PATH: '' };
  const res = await runNodeCapture([join(rootDir, 'scripts', 'worktrees.mjs'), 'archive', 'pr/test-archive', `--date=${date}`, '--json'], {
    cwd: rootDir,
    env: nodeEnv,
  });
  assert.equal(res.code, 0, `expected archive exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, true, `expected ok=true JSON output\n${res.stdout}`);

  const archivedDir = join(workspaceDir, 'archive', 'worktrees', date, 'pr', 'test-archive');
  assert.equal(parsed.destDir, archivedDir, `expected destDir in JSON output to match archive path\n${res.stdout}`);
  const legacyGitFile = await stat(join(archivedDir, '.git.worktree')).catch(() => null);
  assert.equal(legacyGitFile, null, 'expected .git.worktree to be removed (avoid untracked noise)');
  const gitStat = await stat(join(archivedDir, '.git'));
  assert.ok(gitStat.isDirectory(), 'expected archived .git to be a directory (detached repo)');

  const meta = await readFile(join(archivedDir, 'ARCHIVE_META.txt'), 'utf-8');
  assert.ok(meta.includes('component=happier-ui'), `expected component in ARCHIVE_META.txt\n${meta}`);
  assert.ok(meta.includes('ref=pr/test-archive'), `expected ref in ARCHIVE_META.txt\n${meta}`);

  const afterStatus = await runOk('git', ['status', '--porcelain'], { cwd: archivedDir, env: baseEnv });
  assert.ok(afterStatus.stdout.includes('A  staged.txt'), `expected staged file preserved\n${afterStatus.stdout}`);
  assert.ok(afterStatus.stdout.includes(' M README.md'), `expected modified file preserved\n${afterStatus.stdout}`);
  assert.ok(afterStatus.stdout.includes('?? untracked.txt'), `expected untracked file preserved\n${afterStatus.stdout}`);

  const list = await runOk('git', ['worktree', 'list', '--porcelain'], { cwd: repoDir, env: baseEnv });
  assert.ok(!list.stdout.includes(worktreeDir), `expected source repo worktree entry pruned\n${list.stdout}`);

  const branchExists = await runCommandCapture('git', ['show-ref', '--verify', 'refs/heads/pr/test-archive'], { cwd: repoDir, env: baseEnv });
  assert.notEqual(branchExists.code, 0, 'expected source repo branch deleted');
});

test('hstack wt archive refuses to break stacks unless --detach-stacks is provided', async (t) => {
  const { baseEnv, storageDir, workspaceDir, worktreeDir, stackName } = await createStackArchiveFixture(t, {
    stackName: 'exp-test',
    worktreeSlug: 'linked-to-stack',
  });
  const envPath = join(storageDir, stackName, 'env');

  const date = '2000-01-03';
  const nodeEnv = { ...baseEnv, PATH: '' };

  const denied = await runNodeCapture(
    [join(rootDir, 'scripts', 'worktrees.mjs'), 'archive', 'pr/linked-to-stack', `--date=${date}`],
    { cwd: rootDir, env: nodeEnv }
  );
  assert.notEqual(denied.code, 0, `expected archive to refuse without --detach-stacks\nstdout:\n${denied.stdout}\nstderr:\n${denied.stderr}`);

  const ok = await runNodeCapture(
    [
      join(rootDir, 'scripts', 'worktrees.mjs'),
      'archive',
      'pr/linked-to-stack',
      `--date=${date}`,
      '--detach-stacks',
      '--json',
    ],
    { cwd: rootDir, env: nodeEnv }
  );
  assert.equal(ok.code, 0, `expected archive to succeed with --detach-stacks\nstdout:\n${ok.stdout}\nstderr:\n${ok.stderr}`);

  const nextEnv = await readFile(envPath, 'utf-8');
  assert.ok(!nextEnv.includes('HAPPIER_STACK_REPO_DIR='), `expected stack env to detach from worktree\n${nextEnv}`);

  const archivedDir = join(workspaceDir, 'archive', 'worktrees', date, 'pr', 'linked-to-stack');
  const gitStat = await stat(join(archivedDir, '.git'));
  assert.ok(gitStat.isDirectory(), 'expected archived .git to be a directory (detached repo)');
});

test('hstack wt archive can archive a broken git worktree (missing .git/worktrees entry)', async (t) => {
  const { baseEnv, workspaceDir, worktreeDir } = await createStackArchiveFixture(t, {
    worktreeSlug: 'broken-worktree',
    attachStack: false,
  });

  await writeFile(join(worktreeDir, 'untracked.txt'), 'untracked\n', 'utf-8');
  await writeFile(join(worktreeDir, 'README.md'), 'hello\nchanged\n', 'utf-8');

  const gitFile = await readFile(join(worktreeDir, '.git'), 'utf-8');
  const gitdirLine = gitFile
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('gitdir:'));
  assert.ok(gitdirLine, `expected .git file to include gitdir line\n${gitFile}`);
  const gitdir = gitdirLine.slice('gitdir:'.length).trim();
  assert.ok(gitdir, `expected gitdir path\n${gitFile}`);
  // Use an absolute path so we can rm it reliably.
  const gitdirAbs = gitdir.startsWith('/') ? gitdir : join(worktreeDir, gitdir);
  await rm(gitdirAbs, { recursive: true, force: true });

  const date = '2000-01-05';
  const nodeEnv = { ...baseEnv, PATH: '' };
  const res = await runNodeCapture([join(rootDir, 'scripts', 'worktrees.mjs'), 'archive', 'pr/broken-worktree', `--date=${date}`, '--json'], {
    cwd: rootDir,
    env: nodeEnv,
  });
  assert.equal(res.code, 0, `expected archive exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, true, `expected ok=true JSON output\n${res.stdout}`);
  assert.equal(parsed.branch, 'pr/broken-worktree', 'expected branch name to be preserved');

  const archivedDir = join(workspaceDir, 'archive', 'worktrees', date, 'pr', 'broken-worktree');
  const gitStat = await stat(join(archivedDir, '.git'));
  assert.ok(gitStat.isDirectory(), 'expected archived .git to be a directory (detached repo)');

  const afterStatus = await runOk('git', ['status', '--porcelain'], { cwd: archivedDir, env: baseEnv });
  assert.ok(afterStatus.stdout.includes(' M README.md'), `expected modified file preserved\n${afterStatus.stdout}`);
  assert.ok(afterStatus.stdout.includes('?? untracked.txt'), `expected untracked file preserved\n${afterStatus.stdout}`);
});
