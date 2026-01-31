import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
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

test('hapsta stack archive moves the stack and archives its referenced worktrees', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-archive-'));

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

  // Create a minimal git repo and a worktree under <workspace>/.worktrees.
  const repoDir = join(workspaceDir, 'happier');
  await mkdir(repoDir, { recursive: true });
  await runOk('git', ['init', '-b', 'main'], { cwd: repoDir, env: baseEnv });
  await runOk('git', ['config', 'user.name', 'Test'], { cwd: repoDir, env: baseEnv });
  await runOk('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, env: baseEnv });
  await writeFile(join(repoDir, 'README.md'), 'hello\n', 'utf-8');
  await runOk('git', ['add', 'README.md'], { cwd: repoDir, env: baseEnv });
  await runOk('git', ['commit', '-m', 'init'], { cwd: repoDir, env: baseEnv });

  const worktreeDir = join(workspaceDir, '.worktrees', 'slopus', 'pr', 'archived-by-stack');
  await mkdir(dirname(worktreeDir), { recursive: true });
  await runOk('git', ['worktree', 'add', '-b', 'slopus/pr/archived-by-stack', worktreeDir, 'main'], { cwd: repoDir, env: baseEnv });
  await writeFile(join(worktreeDir, 'untracked.txt'), 'untracked\n', 'utf-8');

  const stackName = 'exp-test';
  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(envPath, [`HAPPIER_STACK_STACK=${stackName}`, `HAPPIER_STACK_COMPONENT_DIR_HAPPY=${worktreeDir}`, ''].join('\n'), 'utf-8');

  const date = '2000-01-04';
  const nodeEnv = { ...baseEnv, PATH: '' };
  const res = await runNode([join(rootDir, 'scripts', 'stack.mjs'), 'archive', stackName, `--date=${date}`, '--json'], {
    cwd: rootDir,
    env: nodeEnv,
  });
  assert.equal(res.code, 0, `expected stack archive exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, true, `expected ok=true JSON output\n${res.stdout}`);

  const archivedStackDir = join(storageDir, '.archived', date, stackName);
  assert.equal(parsed.archivedStackDir, archivedStackDir, `expected archivedStackDir in JSON output\n${res.stdout}`);
  await stat(join(archivedStackDir, 'env'));

  const archivedWorktreeDir = join(workspaceDir, '.worktrees-archive', date, 'slopus', 'pr', 'archived-by-stack');
  const gitStat = await stat(join(archivedWorktreeDir, '.git'));
  assert.ok(gitStat.isDirectory(), 'expected archived worktree to be detached (standalone .git dir)');
});
