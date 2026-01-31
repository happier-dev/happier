import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

test('hapsta wt use switches all monorepo group components when target is a monorepo worktree', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-wt-use-mono-'));

  const workspaceDir = join(tmp, 'workspace');
  const homeDir = join(tmp, 'home');
  const sandboxDir = join(tmp, 'sandbox');
  const envFile = join(tmp, 'env');

  const monoRoot = join(workspaceDir, '.worktrees', 'slopus', 'tmp', 'mono-wt');
  await mkdir(join(monoRoot, 'packages', 'app'), { recursive: true });
  await mkdir(join(monoRoot, 'packages', 'cli'), { recursive: true });
  await mkdir(join(monoRoot, 'packages', 'server'), { recursive: true });
  await writeFile(join(monoRoot, '.git'), 'gitdir: dummy\n', 'utf-8');
  await writeFile(join(monoRoot, 'packages', 'app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'packages', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'packages', 'server', 'package.json'), '{}\n', 'utf-8');

  await writeFile(envFile, '', 'utf-8');

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: 'exp',
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_SANDBOX_DIR: sandboxDir,
    HAPPIER_STACK_ENV_FILE: envFile,
  };

  const res = await runNode(
    [join(rootDir, 'scripts', 'worktrees.mjs'), 'use', 'slopus/tmp/mono-wt', '--force', '--json'],
    { cwd: rootDir, env }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const parsed = JSON.parse(res.stdout);
  assert.deepEqual(parsed.updatedComponents, ['happy', 'happy-cli', 'happy-server']);

  const contents = await readFile(envFile, 'utf-8');
  assert.ok(contents.includes(`HAPPIER_STACK_COMPONENT_DIR_HAPPY=${monoRoot}\n`), contents);
  assert.ok(contents.includes(`HAPPIER_STACK_COMPONENT_DIR_HAPPY_CLI=${monoRoot}\n`), contents);
  assert.ok(contents.includes(`HAPPIER_STACK_COMPONENT_DIR_HAPPY_SERVER=${monoRoot}\n`), contents);

  await rm(tmp, { recursive: true, force: true });
});
