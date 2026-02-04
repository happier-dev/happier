import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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

test('hstack stack auth copy-from skips pglite DB seed when lock is held by a live pid', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-copy-from-pglite-lock-in-use-'));
  const homeDir = join(tmp, 'home');
  const storageDir = join(tmp, 'storage');
  const workspaceDir = join(tmp, 'workspace');
  await mkdir(homeDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  // Stub yarn to keep this test fast/deterministic. This is an external boundary.
  const binDir = join(tmp, 'bin');
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(yarnPath, '#!/bin/bash\nexit 0\n', 'utf-8');
  await chmod(yarnPath, 0o755);

  const repoRoot = dirname(rootDir); // .../apps/stack -> .../ (monorepo root)

  const mkStackEnv = async (name) => {
    const baseDir = join(storageDir, name);
    const dataDir = join(baseDir, 'server-light');
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(baseDir, 'env'),
      [
        `HAPPIER_STACK_STACK=${name}`,
        `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
        `HAPPIER_STACK_REPO_DIR=${repoRoot}`,
        `HAPPIER_SERVER_LIGHT_DATA_DIR=${dataDir}`,
        `HAPPIER_SERVER_LIGHT_FILES_DIR=${join(dataDir, 'files')}`,
        `HAPPIER_SERVER_LIGHT_DB_DIR=${join(dataDir, 'pglite')}`,
        '',
      ].join('\n'),
      'utf-8'
    );
    return { baseDir, dataDir };
  };

  const source = await mkStackEnv('dev-auth');
  await mkStackEnv('dev');

  const lockPath = join(source.dataDir, '.happier.pglite.lock');
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  assert.ok(holder.pid && holder.pid > 1);
  try {
    await writeFile(
      lockPath,
      JSON.stringify({ pid: holder.pid, createdAt: new Date().toISOString(), purpose: 'test', dbDir: join(source.dataDir, 'pglite') }) + '\n',
      'utf-8'
    );

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HAPPIER_STACK_HOME_DIR: homeDir,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
      HAPPIER_STACK_STACK: 'dev',
      HAPPIER_STACK_ENV_FILE: join(storageDir, 'dev', 'env'),
    };

    const res = await runNode([join(rootDir, 'scripts', 'auth.mjs'), 'copy-from', 'dev-auth'], { cwd: rootDir, env });
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.ok(
      res.stdout.includes('db seed skipped') || res.stderr.includes('db seed skipped'),
      `expected db seed to be skipped\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );
    assert.ok(
      res.stdout.includes('pglite db dir is in use by pid=') ||
        res.stderr.includes('pglite db dir is in use by pid=') ||
        res.stdout.includes('pglite db dir is in use by pid') ||
        res.stderr.includes('pglite db dir is in use by pid'),
      `expected message about live pglite lock\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );
  } finally {
    holder.kill('SIGKILL');
  }
});

