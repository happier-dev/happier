import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SELF_HOST_PORT_MIN = 20_000;
const SELF_HOST_PORT_MAX = 29_999;
const SELF_HOST_PORT_ATTEMPTS = 40;

export function commandExists(cmd) {
  const name = String(cmd ?? '').trim();
  if (!name) return false;
  if (process.platform === 'win32') {
    return spawnSync('where', [name], { stdio: 'ignore' }).status === 0;
  }
  return spawnSync('sh', ['-lc', `command -v ${name} >/dev/null 2>&1`], { stdio: 'ignore' }).status === 0;
}

export function run(cmd, args, { label, cwd, env, timeoutMs = 0, allowFail = false, stdio = 'pipe' } = {}) {
  const prefix = label ? `[${label}] ` : '';
  const result = spawnSync(cmd, args, {
    cwd,
    env: env ?? process.env,
    encoding: 'utf-8',
    stdio,
    timeout: timeoutMs || undefined,
  });
  const timedOut = result.error && result.error.code === 'ETIMEDOUT';
  if (!allowFail && (timedOut || (result.status ?? 1) !== 0)) {
    const stderr = String(result.stderr ?? '').trim();
    const stdout = String(result.stdout ?? '').trim();
    const reason = timedOut ? 'timed out' : `exited with status ${result.status}`;
    throw new Error(`${prefix}${cmd} ${args.join(' ')} ${reason}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return result;
}

export async function extractBinaryFromArtifact({ artifactPath, binaryName, label } = {}) {
  const path = String(artifactPath ?? '').trim();
  const name = String(binaryName ?? '').trim();
  assert.ok(path, 'artifactPath is required');
  assert.ok(name, 'binaryName is required');
  const extractDir = await mkdtemp(join(tmpdir(), 'happier-self-host-artifact-'));
  run('tar', ['-xzf', path, '-C', extractDir], { label, timeoutMs: 60_000 });
  const roots = await readdir(extractDir);
  assert.ok(roots.length > 0, `expected extracted root directory for ${path}`);
  return {
    extractDir,
    binaryPath: join(extractDir, roots[0], name),
  };
}

export async function waitForHealth(url, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(String(url), {
        headers: { accept: 'application/json' },
      });
      if (response.ok) {
        const payload = await response.json().catch(() => ({}));
        if (payload?.ok === true) return true;
      }
    } catch {
      // keep polling until timeout
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 1500));
  }
  return false;
}

async function canBindLocalhostPort(port) {
  return await new Promise((resolvePort) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolvePort(false));
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => resolvePort(!error));
    });
  });
}

export async function reserveLocalhostPort() {
  for (let attempt = 0; attempt < SELF_HOST_PORT_ATTEMPTS; attempt += 1) {
    const candidate =
      SELF_HOST_PORT_MIN + Math.floor(Math.random() * (SELF_HOST_PORT_MAX - SELF_HOST_PORT_MIN + 1));
    if (await canBindLocalhostPort(candidate)) return candidate;
  }
  throw new Error('failed to reserve localhost port from non-ephemeral range');
}

