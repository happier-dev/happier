import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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

test('dev --json reports local server mode by default', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root
  const devScript = join(packageRoot, 'scripts', 'dev.mjs');

  const res = await runNode([devScript, '--json'], { cwd: repoRoot, env: process.env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.startServer, true);
  assert.equal(parsed.serverConnectionSource, 'local');
});

test('dev --no-server --json fails without an external server URL', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root
  const devScript = join(packageRoot, 'scripts', 'dev.mjs');

  const res = await runNode([devScript, '--no-server', '--json'], { cwd: repoRoot, env: process.env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /--no-server requires an external server URL/);
});

test('dev --server-url uses remote server mode', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root
  const devScript = join(packageRoot, 'scripts', 'dev.mjs');

  const res = await runNode(
    [devScript, '--json', '--server-url=https://api.example.com'],
    { cwd: repoRoot, env: process.env }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.startServer, false);
  assert.equal(parsed.serverConnectionSource, 'cli-arg');
  assert.equal(parsed.internalServerUrl, 'https://api.example.com');
  assert.equal(parsed.publicServerUrl, 'https://api.example.com');
});
