import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function runCmd(cmd, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const cleanEnv = {};
    for (const [k, v] of Object.entries(env ?? {})) {
      if (v == null) continue;
      cleanEnv[k] = String(v);
    }
    const proc = spawn(cmd, args, { cwd, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

function runNode(args, { cwd, env }) {
  return runCmd(process.execPath, args, { cwd, env });
}

async function runOk(cmd, args, { cwd, env }) {
  const res = await runCmd(cmd, args, { cwd, env });
  assert.equal(res.code, 0, `expected exit 0 for ${cmd} ${args.join(' ')}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  return res;
}

test('hapsta wt archive detaches and moves a git worktree (preserving uncommitted changes)', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-wt-archive-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');

  const baseEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HAPPIER_STACK_'))),
    GIT_TERMINAL_PROMPT: '0',
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
  };

  const repoDir = join(workspaceDir, 'happier');
  await mkdir(repoDir, { recursive: true });
  await runOk('git', ['init', '-b', 'main'], { cwd: repoDir, env: baseEnv });
  await runOk('git', ['config', 'user.name', 'Test'], { cwd: repoDir, env: baseEnv });
  await runOk('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, env: baseEnv });
  await writeFile(join(repoDir, 'README.md'), 'hello\n', 'utf-8');
  await runOk('git', ['add', 'README.md'], { cwd: repoDir, env: baseEnv });
  await runOk('git', ['commit', '-m', 'init'], { cwd: repoDir, env: baseEnv });

  const worktreeDir = join(workspaceDir, '.worktrees', 'slopus', 'pr', 'test-archive');
  await mkdir(dirname(worktreeDir), { recursive: true });
  await runOk('git', ['worktree', 'add', '-b', 'slopus/pr/test-archive', worktreeDir, 'main'], { cwd: repoDir, env: baseEnv });

  await writeFile(join(worktreeDir, 'staged.txt'), 'staged\n', 'utf-8');
  await runOk('git', ['add', 'staged.txt'], { cwd: worktreeDir, env: baseEnv });
  await writeFile(join(worktreeDir, 'untracked.txt'), 'untracked\n', 'utf-8');
  await writeFile(join(worktreeDir, 'README.md'), 'hello\nchanged\n', 'utf-8');

  const beforeStatus = await runOk('git', ['status', '--porcelain'], { cwd: worktreeDir, env: baseEnv });
  assert.ok(beforeStatus.stdout.includes('A  staged.txt'), `expected staged file in status\n${beforeStatus.stdout}`);
  assert.ok(beforeStatus.stdout.includes(' M README.md'), `expected modified file in status\n${beforeStatus.stdout}`);
  assert.ok(beforeStatus.stdout.includes('?? untracked.txt'), `expected untracked file in status\n${beforeStatus.stdout}`);

  const date = '2000-01-02';
  // Simulate a minimal PATH environment like launchd/SwiftBar shells.
  const nodeEnv = { ...baseEnv, PATH: '' };
  const res = await runNode([join(rootDir, 'scripts', 'worktrees.mjs'), 'archive', 'slopus/pr/test-archive', `--date=${date}`, '--json'], {
    cwd: rootDir,
    env: nodeEnv,
  });
  assert.equal(res.code, 0, `expected archive exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, true, `expected ok=true JSON output\n${res.stdout}`);

  const archivedDir = join(workspaceDir, '.worktrees-archive', date, 'slopus', 'pr', 'test-archive');
  assert.equal(parsed.destDir, archivedDir, `expected destDir in JSON output to match archive path\n${res.stdout}`);
  const legacyGitFile = await stat(join(archivedDir, '.git.worktree')).catch(() => null);
  assert.equal(legacyGitFile, null, 'expected .git.worktree to be removed (avoid untracked noise)');
  const gitStat = await stat(join(archivedDir, '.git'));
  assert.ok(gitStat.isDirectory(), 'expected archived .git to be a directory (detached repo)');

  const meta = await readFile(join(archivedDir, 'ARCHIVE_META.txt'), 'utf-8');
  assert.ok(meta.includes('component=happy'), `expected component in ARCHIVE_META.txt\n${meta}`);
  assert.ok(meta.includes('ref=slopus/pr/test-archive'), `expected ref in ARCHIVE_META.txt\n${meta}`);

  const afterStatus = await runOk('git', ['status', '--porcelain'], { cwd: archivedDir, env: baseEnv });
  assert.ok(afterStatus.stdout.includes('A  staged.txt'), `expected staged file preserved\n${afterStatus.stdout}`);
  assert.ok(afterStatus.stdout.includes(' M README.md'), `expected modified file preserved\n${afterStatus.stdout}`);
  assert.ok(afterStatus.stdout.includes('?? untracked.txt'), `expected untracked file preserved\n${afterStatus.stdout}`);

  const list = await runOk('git', ['worktree', 'list', '--porcelain'], { cwd: repoDir, env: baseEnv });
  assert.ok(!list.stdout.includes(worktreeDir), `expected source repo worktree entry pruned\n${list.stdout}`);

  const branchExists = await runCmd('git', ['show-ref', '--verify', 'refs/heads/slopus/pr/test-archive'], { cwd: repoDir, env: baseEnv });
  assert.notEqual(branchExists.code, 0, 'expected source repo branch deleted');
});

test('hapsta wt archive refuses to break stacks unless --detach-stacks is provided', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-wt-archive-stacks-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');

  const baseEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
  };

  const repoDir = join(workspaceDir, 'happier');
  await mkdir(repoDir, { recursive: true });
  await runOk('git', ['init', '-b', 'main'], { cwd: repoDir, env: baseEnv });
  await runOk('git', ['config', 'user.name', 'Test'], { cwd: repoDir, env: baseEnv });
  await runOk('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, env: baseEnv });
  await writeFile(join(repoDir, 'README.md'), 'hello\n', 'utf-8');
  await runOk('git', ['add', 'README.md'], { cwd: repoDir, env: baseEnv });
  await runOk('git', ['commit', '-m', 'init'], { cwd: repoDir, env: baseEnv });

  const worktreeDir = join(workspaceDir, '.worktrees', 'slopus', 'pr', 'linked-to-stack');
  await mkdir(dirname(worktreeDir), { recursive: true });
  await runOk('git', ['worktree', 'add', '-b', 'slopus/pr/linked-to-stack', worktreeDir, 'main'], { cwd: repoDir, env: baseEnv });
  await writeFile(join(worktreeDir, 'untracked.txt'), 'untracked\n', 'utf-8');

  const stackName = 'exp-test';
  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(envPath, [`HAPPIER_STACK_STACK=${stackName}`, `HAPPIER_STACK_REPO_DIR=${worktreeDir}`, ''].join('\n'), 'utf-8');

  const date = '2000-01-03';
  const nodeEnv = { ...baseEnv, PATH: '' };

  const denied = await runNode(
    [join(rootDir, 'scripts', 'worktrees.mjs'), 'archive', 'slopus/pr/linked-to-stack', `--date=${date}`],
    { cwd: rootDir, env: nodeEnv }
  );
  assert.notEqual(denied.code, 0, `expected archive to refuse without --detach-stacks\nstdout:\n${denied.stdout}\nstderr:\n${denied.stderr}`);

  const ok = await runNode(
    [
      join(rootDir, 'scripts', 'worktrees.mjs'),
      'archive',
      'slopus/pr/linked-to-stack',
      `--date=${date}`,
      '--detach-stacks',
      '--json',
    ],
    { cwd: rootDir, env: nodeEnv }
  );
  assert.equal(ok.code, 0, `expected archive to succeed with --detach-stacks\nstdout:\n${ok.stdout}\nstderr:\n${ok.stderr}`);

  const nextEnv = await readFile(envPath, 'utf-8');
  assert.ok(!nextEnv.includes('HAPPIER_STACK_REPO_DIR='), `expected stack env to detach from worktree\n${nextEnv}`);

  const archivedDir = join(workspaceDir, '.worktrees-archive', date, 'slopus', 'pr', 'linked-to-stack');
  const gitStat = await stat(join(archivedDir, '.git'));
  assert.ok(gitStat.isDirectory(), 'expected archived .git to be a directory (detached repo)');
});

test('hapsta wt archive can archive a broken git worktree (missing .git/worktrees entry)', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-wt-archive-broken-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');

  const baseEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HAPPIER_STACK_'))),
    GIT_TERMINAL_PROMPT: '0',
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
  };

  const repoDir = join(workspaceDir, 'happier');
  await mkdir(repoDir, { recursive: true });
  await runOk('git', ['init', '-b', 'main'], { cwd: repoDir, env: baseEnv });
  await runOk('git', ['config', 'user.name', 'Test'], { cwd: repoDir, env: baseEnv });
  await runOk('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, env: baseEnv });
  await writeFile(join(repoDir, 'README.md'), 'hello\n', 'utf-8');
  await runOk('git', ['add', 'README.md'], { cwd: repoDir, env: baseEnv });
  await runOk('git', ['commit', '-m', 'init'], { cwd: repoDir, env: baseEnv });

  const worktreeDir = join(workspaceDir, '.worktrees', 'slopus', 'pr', 'broken-worktree');
  await mkdir(dirname(worktreeDir), { recursive: true });
  await runOk('git', ['worktree', 'add', '-b', 'slopus/pr/broken-worktree', worktreeDir, 'main'], { cwd: repoDir, env: baseEnv });

  // Create uncommitted changes (no staging; the index will be deleted when we break the worktree).
  await writeFile(join(worktreeDir, 'untracked.txt'), 'untracked\n', 'utf-8');
  await writeFile(join(worktreeDir, 'README.md'), 'hello\nchanged\n', 'utf-8');

  // Simulate a corrupted linked worktree by removing its gitdir entry from the source repo.
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
  const res = await runNode([join(rootDir, 'scripts', 'worktrees.mjs'), 'archive', 'slopus/pr/broken-worktree', `--date=${date}`, '--json'], {
    cwd: rootDir,
    env: nodeEnv,
  });
  assert.equal(res.code, 0, `expected archive exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, true, `expected ok=true JSON output\n${res.stdout}`);
  assert.equal(parsed.branch, 'slopus/pr/broken-worktree', 'expected branch name to be preserved');

  const archivedDir = join(workspaceDir, '.worktrees-archive', date, 'slopus', 'pr', 'broken-worktree');
  const gitStat = await stat(join(archivedDir, '.git'));
  assert.ok(gitStat.isDirectory(), 'expected archived .git to be a directory (detached repo)');

  const afterStatus = await runOk('git', ['status', '--porcelain'], { cwd: archivedDir, env: baseEnv });
  assert.ok(afterStatus.stdout.includes(' M README.md'), `expected modified file preserved\n${afterStatus.stdout}`);
  assert.ok(afterStatus.stdout.includes('?? untracked.txt'), `expected untracked file preserved\n${afterStatus.stdout}`);
});
