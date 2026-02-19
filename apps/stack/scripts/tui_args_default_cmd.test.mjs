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

test('tui without args defaults to command execution path (non-tty requires tty)', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root
  const tuiScript = join(packageRoot, 'scripts', 'tui.mjs');

  const res = await runNode([tuiScript], { cwd: repoRoot, env: process.env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /\[tui\] failed: Error: \[tui\] requires a TTY/);
});

test('tui help remains explicit', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root
  const tuiScript = join(packageRoot, 'scripts', 'tui.mjs');

  const res = await runNode([tuiScript, '--help'], { cwd: repoRoot, env: process.env });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /\[tui\] usage:/);
  assert.match(res.stdout, /hstack tui \[\<hstack args\.\.\.\>\]/);
  assert.match(res.stdout, /hstack tui\s+=> hstack tui dev/);
});
