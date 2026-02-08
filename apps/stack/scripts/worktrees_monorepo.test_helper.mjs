import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      const resolvedCode = code ?? (signal ? 1 : 0);
      const signalSuffix = signal ? `\nprocess terminated by signal: ${signal}` : '';
      resolve({ code: resolvedCode, stdout, stderr: `${stderr}${signalSuffix}` });
    });
  });
}

export function createMonorepoWorktreeEnv({ homeDir, workspaceDir, sandboxDir, extraEnv = {} }) {
  return {
    ...process.env,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_OWNER: 'test',
    HAPPIER_STACK_SANDBOX_DIR: sandboxDir,
    ...extraEnv,
  };
}

export async function createMonorepoWorktreeFixture(t, { prefix }) {
  const tmp = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const workspaceDir = join(tmp, 'workspace');
  const homeDir = join(tmp, 'home');
  const sandboxDir = join(tmp, 'sandbox');
  const monoRoot = join(workspaceDir, 'tmp', 'test', 'mono-wt');

  await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(monoRoot, '.git'), 'gitdir: dummy\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');

  return { homeDir, monoRoot, sandboxDir, tmp, workspaceDir };
}
