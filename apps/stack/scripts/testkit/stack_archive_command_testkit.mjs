import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCommandCapture } from './stack_script_command_testkit.mjs';

async function runGitOk(args, { cwd, env }) {
  const res = await runCommandCapture('git', args, { cwd, env });
  assert.equal(res.code, 0, `expected git exit 0 for git ${args.join(' ')}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  return res;
}

export async function createStackArchiveFixture(t, { stackName = 'exp-test', worktreeSlug = 'archived-by-stack' } = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-archive-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');
  const repoDir = join(workspaceDir, 'main');
  const worktreeDir = join(workspaceDir, 'pr', worktreeSlug);
  const baseEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HAPPIER_STACK_'))),
    GIT_TERMINAL_PROMPT: '0',
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
  };

  await mkdir(repoDir, { recursive: true });
  await runGitOk(['init', '-b', 'main'], { cwd: repoDir, env: baseEnv });
  await runGitOk(['config', 'user.name', 'Test'], { cwd: repoDir, env: baseEnv });
  await runGitOk(['config', 'user.email', 'test@example.com'], { cwd: repoDir, env: baseEnv });
  await writeFile(join(repoDir, 'README.md'), 'hello\n', 'utf-8');
  await runGitOk(['add', 'README.md'], { cwd: repoDir, env: baseEnv });
  await runGitOk(['commit', '-m', 'init'], { cwd: repoDir, env: baseEnv });

  await mkdir(dirname(worktreeDir), { recursive: true });
  await runGitOk(['worktree', 'add', '-b', `pr/${worktreeSlug}`, worktreeDir, 'main'], { cwd: repoDir, env: baseEnv });
  await writeFile(join(worktreeDir, 'untracked.txt'), 'untracked\n', 'utf-8');

  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(envPath, [`HAPPIER_STACK_STACK=${stackName}`, `HAPPIER_STACK_REPO_DIR=${worktreeDir}`, ''].join('\n'), 'utf-8');

  return {
    stackName,
    storageDir,
    workspaceDir,
    worktreeDir,
    baseEnv,
  };
}
