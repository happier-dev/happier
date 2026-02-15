import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCommandCapture, runNodeCapture } from './testkit/stack_script_command_testkit.mjs';

async function git(dir, args, env) {
  const res = await runCommandCapture('git', args, { cwd: dir, env });
  assert.equal(res.code, 0, `git ${args.join(' ')} failed\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
}

test('hstack wt status defaults to active repo dir when no worktree spec is provided', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-wt-status-default-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  const workspaceDir = join(tmp, 'workspace');
  const homeDir = join(tmp, 'home');
  const repoDir = join(workspaceDir, 'dev');
  await mkdir(repoDir, { recursive: true });

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'QA',
    GIT_AUTHOR_EMAIL: 'qa@example.com',
    GIT_COMMITTER_NAME: 'QA',
    GIT_COMMITTER_EMAIL: 'qa@example.com',
  };
  await git(repoDir, ['init'], gitEnv);
  await writeFile(join(repoDir, 'README.md'), '# repo\n', 'utf-8');
  await git(repoDir, ['add', 'README.md'], gitEnv);
  await git(repoDir, ['commit', '-m', 'init'], gitEnv);

  const env = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_REPO_DIR: repoDir,
    HAPPIER_STACK_OWNER: 'test',
  };

  const res = await runNodeCapture([join(rootDir, 'scripts', 'worktrees.mjs'), 'status', '--json'], {
    cwd: rootDir,
    env,
  });

  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.dir, repoDir);
});
