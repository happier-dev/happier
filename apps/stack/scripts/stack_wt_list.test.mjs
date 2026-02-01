import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const cleanEnv = {};
    for (const [k, v] of Object.entries(env ?? {})) {
      if (v == null) continue;
      cleanEnv[k] = String(v);
    }
    const proc = spawn(process.execPath, args, { cwd, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

async function touchWorktree(dir) {
  await mkdir(dir, { recursive: true });
  // In a git worktree, ".git" is often a file; our detection treats either file or dir as truthy.
  await writeFile(join(dir, '.git'), 'gitdir: /dev/null\n', 'utf-8');
}

test('hstack stack wt <stack> -- list defaults to active-only (no exhaustive enumeration)', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-wt-list-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');
  const stackName = 'exp-test';

  // Create isolated monorepo worktrees on disk (repo-scoped, inside our temp workspace).
  const wtRoot = join(workspaceDir, '.worktrees');
  const monoActive = join(wtRoot, 'slopus', 'pr', 'active-branch');
  const monoOther = join(wtRoot, 'slopus', 'pr', 'other-branch');
  await touchWorktree(monoActive);
  await touchWorktree(monoOther);
  await mkdir(join(monoActive, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoActive, 'apps', 'cli'), { recursive: true });
  await mkdir(join(monoActive, 'apps', 'server'), { recursive: true });
  await writeFile(join(monoActive, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoActive, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoActive, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await mkdir(join(monoOther, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoOther, 'apps', 'cli'), { recursive: true });
  await mkdir(join(monoOther, 'apps', 'server'), { recursive: true });
  await writeFile(join(monoOther, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoOther, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoOther, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');

  // Stack env selects the active worktrees.
  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_REPO_DIR=${monoActive}`,
      '',
    ].join('\n'),
    'utf-8'
  );

  const baseEnv = {
    ...process.env,
    // Prevent loading the user's real ~/.happier-stack/.env via canonical discovery.
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
  };

  const res = await runNode([join(rootDir, 'scripts', 'stack.mjs'), 'wt', stackName, '--', 'list'], { cwd: rootDir, env: baseEnv });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  assert.ok(
    res.stdout.includes(`- active: ${monoActive}`),
    `expected happy active in output\n${res.stdout}`
  );

  // Should NOT enumerate other worktrees unless --all was passed.
  assert.ok(!res.stdout.includes(`- ${monoOther}`), `expected other to be omitted\n${res.stdout}`);
});

test('hstack stack wt <stack> -- list --all shows all worktrees (opt-in)', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-wt-list-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');
  const stackName = 'exp-test';

  const wtRoot = join(workspaceDir, '.worktrees');
  const monoActive = join(wtRoot, 'slopus', 'pr', 'active-branch');
  const monoOther = join(wtRoot, 'slopus', 'pr', 'other-branch');
  await touchWorktree(monoActive);
  await touchWorktree(monoOther);
  await mkdir(join(monoActive, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoActive, 'apps', 'cli'), { recursive: true });
  await mkdir(join(monoActive, 'apps', 'server'), { recursive: true });
  await writeFile(join(monoActive, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoActive, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoActive, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await mkdir(join(monoOther, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoOther, 'apps', 'cli'), { recursive: true });
  await mkdir(join(monoOther, 'apps', 'server'), { recursive: true });
  await writeFile(join(monoOther, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoOther, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoOther, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');

  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_REPO_DIR=${monoActive}`,
      '',
    ].join('\n'),
    'utf-8'
  );

  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
  };

  const res = await runNode([join(rootDir, 'scripts', 'stack.mjs'), 'wt', stackName, '--', 'list', '--all'], {
    cwd: rootDir,
    env: baseEnv,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  assert.ok(
    res.stdout.includes(`- active: ${monoActive}`),
    `expected happy active in output\n${res.stdout}`
  );
  assert.ok(
    res.stdout.includes(`- ${monoOther}`),
    `expected happy other to be listed with --all\n${res.stdout}`
  );
});
