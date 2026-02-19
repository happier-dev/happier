import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

function runNode(args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
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

async function pickFreeLocalPort() {
  const srv = net.createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    srv.once('error', rejectPromise);
    srv.listen({ host: '127.0.0.1', port: 0 }, () => resolvePromise());
  });
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? Number(addr.port) : NaN;
  await new Promise((resolvePromise) => srv.close(() => resolvePromise()));
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`failed to pick a free local port (got: ${String(port)})`);
  }
  return port;
}

test('hstack stack auth <stack> login --print prefers pinned env port over stale runtime port', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-pinned-port-'));
  try {
    const storageDir = join(tmp, 'storage');
    const monoRoot = join(tmp, 'happier');
    await ensureMinimalMonorepo({ monoRoot });

    const stackName = 'dev';
    const stackDir = join(storageDir, stackName);
    await mkdir(stackDir, { recursive: true });

    const envPath = join(stackDir, 'env');
    await writeFile(
      envPath,
      [
        `HAPPIER_STACK_STACK=${stackName}`,
        `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
        'HAPPIER_STACK_SERVER_PORT=4101',
        // Avoid external probes so --json stays hermetic.
        'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
        'HAPPIER_STACK_TAILSCALE_SERVE=0',
        '',
      ].join('\n'),
      'utf-8'
    );

    // Simulate a stale runtime state with a different port recorded.
    await writeFile(
      join(stackDir, 'stack.runtime.json'),
      JSON.stringify({ version: 1, ownerPid: 0, ports: { server: 4999 } }, null, 2) + '\n',
      'utf-8'
    );

    const env = {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
    };

    const res = await runNode(
      [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'auth', stackName, 'login', '--print', '--no-open', '--json'],
      { cwd: rootDir, env }
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed?.internalServerUrl, 'http://127.0.0.1:4101');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('hstack stack auth <stack> login --print uses last runtime port when stack env is ephemeral', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-ephemeral-port-'));
  try {
    const storageDir = join(tmp, 'storage');
    const monoRoot = join(tmp, 'happier');
    await ensureMinimalMonorepo({ monoRoot });

    const stackName = 'dev';
    const stackDir = join(storageDir, stackName);
    await mkdir(stackDir, { recursive: true });

    const envPath = join(stackDir, 'env');
    await writeFile(
      envPath,
      [
        `HAPPIER_STACK_STACK=${stackName}`,
        `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
        // Intentionally omit HAPPIER_STACK_SERVER_PORT (ephemeral model).
        'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
        'HAPPIER_STACK_TAILSCALE_SERVE=0',
        '',
      ].join('\n'),
      'utf-8'
    );

    await writeFile(
      join(stackDir, 'stack.runtime.json'),
      JSON.stringify({ version: 1, ownerPid: 0, ports: { server: 4999 } }, null, 2) + '\n',
      'utf-8'
    );

    const env = {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
    };

    const res = await runNode(
      [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'auth', stackName, 'login', '--print', '--no-open', '--json'],
      { cwd: rootDir, env }
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed?.internalServerUrl, 'http://127.0.0.1:4999');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('hstack stack dev <stack> --json reuses recorded runtime port for ephemeral stacks', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-ephemeral-reuse-'));
  try {
    const storageDir = join(tmp, 'storage');
    const monoRoot = join(tmp, 'happier');
    await ensureMinimalMonorepo({ monoRoot });

    const stackName = 'dev';
    const stackDir = join(storageDir, stackName);
    await mkdir(stackDir, { recursive: true });

    const envPath = join(stackDir, 'env');
    await writeFile(
      envPath,
      [
        `HAPPIER_STACK_STACK=${stackName}`,
        `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
        // Intentionally omit HAPPIER_STACK_SERVER_PORT (ephemeral model).
        'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
        'HAPPIER_STACK_TAILSCALE_SERVE=0',
        '',
      ].join('\n'),
      'utf-8'
    );

    const runtimePort = await pickFreeLocalPort();
    await writeFile(
      join(stackDir, 'stack.runtime.json'),
      JSON.stringify({ version: 1, ownerPid: 0, ports: { server: runtimePort } }, null, 2) + '\n',
      'utf-8'
    );

    const env = {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
    };

    const res = await runNode(
      [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'dev', stackName, '--json'],
      { cwd: rootDir, env }
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed?.serverPort, runtimePort);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
