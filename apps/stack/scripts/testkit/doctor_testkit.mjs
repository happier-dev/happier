import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function runNode(args, { cwd, env }) {
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
    proc.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr }));
  });
}

async function writeStubHappierCli({ dir }) {
  await mkdir(join(dir, 'bin'), { recursive: true });
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(
    join(dir, 'bin', 'happier.mjs'),
    [
      `if (process.argv.includes('daemon') && process.argv.includes('status')) {`,
      `  console.log('Daemon is running');`,
      `  process.exit(0);`,
      `}`,
      `console.log('ok');`,
    ].join('\n'),
    'utf-8'
  );
  await writeFile(join(dir, 'dist', 'index.mjs'), `export {};`, 'utf-8');
}

export async function createDoctorWorkspaceFixture(t, { tmpPrefix = 'happier-stack-doctor-' } = {}) {
  const tmp = await mkdtemp(join(tmpdir(), tmpPrefix));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const monoRoot = join(tmp, 'workspace', 'happier');
  const stubServer = join(monoRoot, 'apps', 'server');
  const stubCli = join(monoRoot, 'apps', 'cli');
  const stubUi = join(monoRoot, 'apps', 'ui');
  await mkdir(stubUi, { recursive: true });
  await mkdir(stubServer, { recursive: true });
  await mkdir(stubCli, { recursive: true });
  await writeFile(join(stubUi, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(stubCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(stubServer, 'package.json'), '{}\n', 'utf-8');
  await writeStubHappierCli({ dir: stubCli });

  return { tmp, monoRoot };
}

export function doctorEnv({ monoRoot, extraEnv = {} } = {}) {
  return {
    ...process.env,
    HAPPIER_STACK_REPO_DIR: monoRoot,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    ...extraEnv,
  };
}
