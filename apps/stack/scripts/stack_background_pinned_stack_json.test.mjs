import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { constants as osConstants, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function exitCodeFromSignal(signal) {
  if (!signal) return 0;
  const n = osConstants?.signals?.[signal];
  return 128 + (typeof n === 'number' && Number.isFinite(n) ? n : 1);
}

function runNode(args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code: code ?? exitCodeFromSignal(signal), stdout, stderr }));
  });
}

async function ensureMinimalMonorepo({ monoRoot }) {
  await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
}

test('hstack stack dev <pinned> --background --json does not fail fast (prints dev config)', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-bg-pinned-'));
  try {
    const storageDir = join(tmp, 'storage');
    const monoRoot = join(tmp, 'happier');

    await ensureMinimalMonorepo({ monoRoot });

    await mkdir(join(storageDir, 'main'), { recursive: true });
    const envPath = join(storageDir, 'main', 'env');
    await writeFile(
      envPath,
      [
        'HAPPIER_STACK_STACK=main',
        `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
        'HAPPIER_STACK_SERVER_PORT=4101',
        // Avoid external probes (tailscale) so --json stays hermetic.
        'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
        'HAPPIER_STACK_TAILSCALE_SERVE=0',
        '',
      ].join('\n'),
      'utf-8'
    );

    const env = {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: 'main',
      HAPPIER_STACK_ENV_FILE: envPath,
    };

    const res = await runNode(
      [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'dev', 'main', '--background', '--json'],
      { cwd: rootDir, env }
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed?.mode, 'dev');
    assert.equal(parsed?.serverPort, 4101);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('second background partial dev cannot spawn or delete a live owner runtime state', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-bg-live-owner-'));
  try {
    const storageDir = join(tmp, 'storage');
    const monoRoot = join(tmp, 'happier');
    const stackDir = join(storageDir, 'main');
    await ensureMinimalMonorepo({ monoRoot });
    await mkdir(stackDir, { recursive: true });
    const envPath = join(stackDir, 'env');
    await writeFile(envPath, [
      'HAPPIER_STACK_STACK=main',
      `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
      'HAPPIER_STACK_SERVER_PORT=4101',
      '',
    ].join('\n'), 'utf-8');

    const runtimeStatePath = join(stackDir, 'stack.runtime.json');
    const incumbent = {
      version: 1,
      stackName: 'main',
      script: 'dev.mjs',
      ownerPid: process.pid,
      ports: { server: 4101 },
      processes: { proxyPid: process.pid, watcherPid: process.pid },
      sentinel: 'incumbent-owner-state',
    };
    await writeFile(runtimeStatePath, `${JSON.stringify(incumbent, null, 2)}\n`, 'utf-8');

    const res = await runNode(
      [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'dev', 'main', '--background', '--no-ui', '--no-daemon'],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          HAPPIER_STACK_STORAGE_DIR: storageDir,
          HAPPIER_STACK_STACK: 'main',
          HAPPIER_STACK_ENV_FILE: envPath,
          HAPPIER_STACK_STACK_BACKGROUND_READY_TIMEOUT_MS: '1000',
        },
      },
    );

    assert.ok(
      res.code !== 0 || /already.*running/i.test(res.stdout),
      `second invocation neither observed nor clearly rejected the owner\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
    assert.match(`${res.stdout}\n${res.stderr}`, /live lifecycle owner|already.*running/i);
    assert.deepEqual(JSON.parse(await readFile(runtimeStatePath, 'utf-8')), incumbent);
    const logs = await readdir(join(stackDir, 'logs')).catch(() => []);
    assert.deepEqual(logs.filter((name) => name.startsWith('dev.')), []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
