import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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

test('hstack stack audit --fix-paths prunes legacy DATABASE_URL for light stacks and sets HAPPIER_SERVER_LIGHT_DB_DIR', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-audit-light-'));
  const homeDir = join(tmp, 'home');
  const storageDir = join(tmp, 'storage');
  const workspaceDir = join(tmp, 'workspace');
  const repoDir = join(workspaceDir, 'main');

  await mkdir(homeDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });

  const stackName = 'exp1';
  const baseDir = join(storageDir, stackName);
  const envPath = join(baseDir, 'env');
  const dataDir = join(baseDir, 'server-light');
  await mkdir(dataDir, { recursive: true });

  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light`,
      `HAPPIER_STACK_UI_BUILD_DIR=${join(baseDir, 'ui')}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${join(baseDir, 'cli')}`,
      `HAPPIER_STACK_REPO_DIR=${repoDir}`,
      `HAPPIER_SERVER_LIGHT_DATA_DIR=${dataDir}`,
      `HAPPIER_SERVER_LIGHT_FILES_DIR=${join(dataDir, 'files')}`,
      // Legacy (SQLite-era) light stacks persisted DATABASE_URL=file:...; audit should remove it.
      `DATABASE_URL=file:${join(dataDir, 'happier-server-light.sqlite')}`,
      '',
    ].join('\n'),
    'utf-8'
  );

  const env = {
    ...process.env,
    // Prevent canonical discovery from reading the real machine install.
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
  };

  const res = await runNode([join(rootDir, 'scripts', 'stack.mjs'), 'audit', '--fix-paths', '--json'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const raw = await readFile(envPath, 'utf-8');
  assert.ok(raw.includes('HAPPIER_SERVER_LIGHT_DB_DIR='), `expected HAPPIER_SERVER_LIGHT_DB_DIR to be set\n${raw}`);
  assert.ok(!raw.includes('\nDATABASE_URL='), `expected legacy DATABASE_URL to be pruned for light stacks\n${raw}`);
});

