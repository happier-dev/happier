import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr }));
  });
}

test('hstack init shim preserves HAPPIER_STACK_INVOKED_CWD before changing directories', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-init-shim-'));

  const homeDir = join(tmp, 'home');
  const canonicalHomeDir = join(tmp, 'canonical');
  const workspaceDir = join(tmp, 'workspace');

  try {
    const res = await runNode(
      [
        join(rootDir, 'scripts', 'init.mjs'),
        `--home-dir=${homeDir}`,
        `--canonical-home-dir=${canonicalHomeDir}`,
        `--workspace-dir=${workspaceDir}`,
        '--no-runtime',
        '--no-bootstrap',
      ],
      { cwd: rootDir, env: { ...process.env } }
    );
    assert.equal(res.code, 0, `expected init to exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

    const shimPath = join(homeDir, 'bin', 'hstack');
    const shim = await readFile(shimPath, 'utf-8');
    assert.match(shim, /HAPPIER_STACK_INVOKED_CWD/, 'expected shim to reference HAPPIER_STACK_INVOKED_CWD');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

