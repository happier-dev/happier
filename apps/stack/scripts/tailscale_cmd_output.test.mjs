import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

function stripAnsi(s) {
  return String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

test('tailscale enable output includes stack context + upstream', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const tmp = mkdtempSync(join(tmpdir(), 'happier-tailscale-test-'));
  try {
    const binDir = join(tmp, 'bin');
    mkdirSync(binDir, { recursive: true });
    const tailscaleBin = join(binDir, 'tailscale');
    const internalPort = 55555;
    const httpsUrl = 'https://happier-test.ts.net';

    // Fake tailscale CLI: enough behavior for `tailscale serve --bg <upstream>` + `tailscale serve status`.
    writeFileSync(
      tailscaleBin,
      [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        "if (args[0] === 'serve' && args[1] === 'status') {",
        `  process.stdout.write('${httpsUrl}\\n');`,
        `  process.stdout.write('|-- / proxy http://127.0.0.1:${internalPort}\\n');`,
        '  process.exit(0);',
        '}',
        "if (args[0] === 'serve' && args.includes('--bg')) {",
        '  process.exit(0);',
        '}',
        "if (args[0] === 'serve' && args[1] === 'reset') {",
        '  process.exit(0);',
        '}',
        'process.exit(0);',
        '',
      ].join('\n')
    );
    chmodSync(tailscaleBin, 0o755);

    const envPath = join(tmp, 'stack.env');
    writeFileSync(envPath, '');

    const res = await runNode([join(packageRoot, 'scripts', 'tailscale.mjs'), 'enable'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HAPPIER_STACK_TAILSCALE_BIN: tailscaleBin,
        HAPPIER_STACK_SERVER_PORT: String(internalPort),
        HAPPIER_STACK_STACK: 'repo-test-1234',
        HAPPIER_STACK_ENV_FILE: envPath,
        // Prevent any other behavior from probing global state.
        HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: '1',
      },
    });

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    const out = stripAnsi(res.stdout);
    assert.match(out, /tailscale serve enabled/i);
    assert.match(out, new RegExp(`\\b${httpsUrl.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`));
    assert.match(out, /\bstack:\s+repo-test-1234\b/i);
    assert.match(out, new RegExp(`\\bupstream:\\s+http://127\\.0\\.0\\.1:${internalPort}\\b`, 'i'));
    assert.match(out, new RegExp(`\\benv:\\s+${envPath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

