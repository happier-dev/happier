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

test('happys stack wt <stack> -- list defaults to active-only (no exhaustive enumeration)', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-wt-list-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');
  const componentsDir = join(workspaceDir, 'components');
  const stackName = 'exp-test';

  // Create isolated worktrees on disk (inside our temp workspace).
  const wtRoot = join(componentsDir, '.worktrees');
  const happyActive = join(wtRoot, 'happy', 'slopus', 'pr', 'active-branch');
  const happyOther = join(wtRoot, 'happy', 'slopus', 'pr', 'other-branch');
  const cliActive = join(wtRoot, 'happy-cli', 'slopus', 'pr', 'cli-active');
  const cliOther = join(wtRoot, 'happy-cli', 'slopus', 'pr', 'cli-other');
  await touchWorktree(happyActive);
  await touchWorktree(happyOther);
  await touchWorktree(cliActive);
  await touchWorktree(cliOther);

  // Stack env selects the active worktrees.
  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(
    envPath,
    [
      `HAPPY_STACKS_STACK=${stackName}`,
      `HAPPY_STACKS_COMPONENT_DIR_HAPPY=${happyActive}`,
      `HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI=${cliActive}`,
      '',
    ].join('\n'),
    'utf-8'
  );

  const baseEnv = {
    ...process.env,
    // Prevent loading the user's real ~/.happy-stacks/.env via canonical discovery.
    HAPPY_STACKS_HOME_DIR: homeDir,
    HAPPY_STACKS_STORAGE_DIR: storageDir,
    HAPPY_STACKS_WORKSPACE_DIR: workspaceDir,
  };

  const res = await runNode([join(rootDir, 'scripts', 'stack.mjs'), 'wt', stackName, '--', 'list'], { cwd: rootDir, env: baseEnv });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  assert.ok(res.stdout.includes(`- active: ${happyActive}`), `expected happy active in output\n${res.stdout}`);
  assert.ok(res.stdout.includes(`- active: ${cliActive}`), `expected happy-cli active in output\n${res.stdout}`);

  // Should NOT enumerate other worktrees unless --all was passed.
  assert.ok(!res.stdout.includes(`- ${happyOther}`), `expected happy other to be omitted\n${res.stdout}`);
  assert.ok(!res.stdout.includes(`- ${cliOther}`), `expected happy-cli other to be omitted\n${res.stdout}`);
});

test('happys stack wt <stack> -- list --all shows all worktrees (opt-in)', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-wt-list-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');
  const componentsDir = join(workspaceDir, 'components');
  const stackName = 'exp-test';

  const wtRoot = join(componentsDir, '.worktrees');
  const happyActive = join(wtRoot, 'happy', 'slopus', 'pr', 'active-branch');
  const happyOther = join(wtRoot, 'happy', 'slopus', 'pr', 'other-branch');
  await touchWorktree(happyActive);
  await touchWorktree(happyOther);

  const envPath = join(storageDir, stackName, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(
    envPath,
    [`HAPPY_STACKS_STACK=${stackName}`, `HAPPY_STACKS_COMPONENT_DIR_HAPPY=${happyActive}`, ''].join('\n'),
    'utf-8'
  );

  const baseEnv = {
    ...process.env,
    HAPPY_STACKS_HOME_DIR: homeDir,
    HAPPY_STACKS_STORAGE_DIR: storageDir,
    HAPPY_STACKS_WORKSPACE_DIR: workspaceDir,
  };

  const res = await runNode([join(rootDir, 'scripts', 'stack.mjs'), 'wt', stackName, '--', 'list', '--all'], {
    cwd: rootDir,
    env: baseEnv,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  assert.ok(res.stdout.includes(`- active: ${happyActive}`), `expected happy active in output\n${res.stdout}`);
  assert.ok(res.stdout.includes(`- ${happyOther}`), `expected happy other to be listed with --all\n${res.stdout}`);
});

