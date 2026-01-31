import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

test('happys wt cursor opens the monorepo root (not a subpackage dir) in monorepo worktrees', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-wt-cursor-mono-'));

  const workspaceDir = join(tmp, 'workspace');
  const homeDir = join(tmp, 'home');
  const sandboxDir = join(tmp, 'sandbox');

  const monoRoot = join(workspaceDir, 'components', '.worktrees', 'happy', 'slopus', 'tmp', 'mono-wt');
  await mkdir(join(monoRoot, 'expo-app'), { recursive: true });
  await mkdir(join(monoRoot, 'cli'), { recursive: true });
  await mkdir(join(monoRoot, 'server'), { recursive: true });
  await writeFile(join(monoRoot, '.git'), 'gitdir: dummy\n', 'utf-8');
  await writeFile(join(monoRoot, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'server', 'package.json'), '{}\n', 'utf-8');

  const env = {
    ...process.env,
    HAPPY_STACKS_HOME_DIR: homeDir,
    HAPPY_STACKS_WORKSPACE_DIR: workspaceDir,
    HAPPY_STACKS_SANDBOX_DIR: sandboxDir,
  };

  const resHappy = await runNode(
    [join(rootDir, 'scripts', 'worktrees.mjs'), 'cursor', 'happy', 'slopus/tmp/mono-wt', '--json'],
    { cwd: rootDir, env }
  );
  assert.equal(resHappy.code, 0, `expected exit 0, got ${resHappy.code}\nstdout:\n${resHappy.stdout}\nstderr:\n${resHappy.stderr}`);
  const parsedHappy = JSON.parse(resHappy.stdout);
  assert.equal(parsedHappy.dir, monoRoot);

  const resCli = await runNode(
    [join(rootDir, 'scripts', 'worktrees.mjs'), 'cursor', 'happy-cli', 'slopus/tmp/mono-wt', '--json'],
    { cwd: rootDir, env }
  );
  assert.equal(resCli.code, 0, `expected exit 0, got ${resCli.code}\nstdout:\n${resCli.stdout}\nstderr:\n${resCli.stderr}`);
  const parsedCli = JSON.parse(resCli.stdout);
  assert.equal(parsedCli.dir, monoRoot);

  await rm(tmp, { recursive: true, force: true });
});
