import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStackFixtureEnv } from './testkit/core/env_scope.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';

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

for (const [entry, action] of ['direct', 'stack'].flatMap(entry =>
  ['enable', 'url', 'disable'].map(action => [entry, action]))) {
  test(`${entry} tailscale ${action} honors an explicit HTTPS listener without changing another listener`, async (t) => {
    const fixture = await createTempFixture(t, { prefix: 'tailscale-cli-port-' });
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const upstream = 'http://127.0.0.1:35550';
    const originalRoot = action === 'url' ? upstream : 'http://127.0.0.1:3999';
    const configPath = fixture.path('serve.json');
    writeFileSync(configPath, JSON.stringify({
      443: { '/': originalRoot },
      ...(action === 'enable' ? {} : { 8443: { '/': upstream } }),
    }));
    // Model the external Tailscale process; keep Stack routing and ownership checks real.
    const { binPath } = writeFakeBin({ root: fixture.root, name: 'tailscale', content: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const configPath = process.env.TEST_SERVE_CONFIG;
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (args[0] !== 'serve') process.exit(1);
if (args[1] === 'status') {
  for (const [port, routes] of Object.entries(config)) {
    console.log('https://qa.example.ts.net' + (port === '443' ? '' : ':' + port));
    for (const [route, upstream] of Object.entries(routes)) console.log('|-- ' + route + ' proxy ' + upstream);
  }
} else {
  const port = args.find(a => a.startsWith('--https='))?.split('=')[1] || '443';
  if (args.at(-1) === 'off') delete config[port];
  else (config[port] ||= {})['/'] = args.at(-1);
  fs.writeFileSync(configPath, JSON.stringify(config));
}
` });
    const envPath = fixture.path('storage', 'repo-port-test', 'env');
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, 'HAPPIER_STACK_SERVER_PORT=35550\n');
    const command = entry === 'stack'
      ? ['apps/stack/scripts/stack.mjs', `tailscale:${action}`, 'repo-port-test', '--']
      : ['apps/stack/scripts/tailscale.mjs', action];
    const result = await runNode([...command, '--https-port=8443', '--json'], {
      cwd: repoRoot,
      env: buildStackFixtureEnv({ homeDir: fixture.path('home'), storageDir: fixture.path('storage'),
        stackName: 'repo-port-test', envPath, stripStackEnv: true,
        extraEnv: { HAPPIER_TAILSCALE_BIN: binPath, TEST_SERVE_CONFIG: configPath,
          HAPPIER_STACK_SERVER_PORT: '35550', HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: '1' },
      }),
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(config['443'], { '/': originalRoot });
    if (action === 'disable') assert.equal(config['8443'], undefined);
    else {
      assert.deepEqual(config['8443'], { '/': upstream });
      assert.equal(action === 'url' ? output.url : output.httpsUrl, 'https://qa.example.ts.net:8443');
    }
  });
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
    writeFileSync(envPath, `HAPPIER_STACK_SERVER_PORT=${internalPort}\n`);

    const res = await runNode([join(packageRoot, 'scripts', 'tailscale.mjs'), 'enable'], {
      cwd: repoRoot,
      env: buildStackFixtureEnv({
        homeDir: join(tmp, 'home'),
        storageDir: join(tmp, 'storage'),
        stackName: 'repo-test-1234',
        envPath,
        stripStackEnv: true,
        extraEnv: {
          HAPPIER_TAILSCALE_BIN: tailscaleBin,
          HAPPIER_STACK_SERVER_PORT: String(internalPort),
          // Prevent any other behavior from probing global state.
          HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: '1',
        },
      }),
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

test('tailscale url returns the relay-comparable ts.net URL when multiple serve entries exist', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const repoRoot = dirname(dirname(packageRoot));

  const tmp = mkdtempSync(join(tmpdir(), 'happier-tailscale-url-test-'));
  try {
    const binDir = join(tmp, 'bin');
    mkdirSync(binDir, { recursive: true });
    const tailscaleBin = join(binDir, 'tailscale');
    const relayPort = 35555;
    const otherUrl = 'https://other-service.ts.net';
    const relayUrl = 'https://relay-service.ts.net';

    writeFileSync(
      tailscaleBin,
      [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        "if (args[0] === 'serve' && args[1] === 'status') {",
        `  process.stdout.write('${otherUrl}\\n');`,
        '  process.stdout.write("|-- / proxy http://127.0.0.1:8080\\n");',
        `  process.stdout.write('${relayUrl}\\n');`,
        `  process.stdout.write('|-- / proxy http://127.0.0.1:${relayPort}\\n');`,
        '  process.exit(0);',
        '}',
        'process.exit(0);',
        '',
      ].join('\n')
    );
    chmodSync(tailscaleBin, 0o755);

    const res = await runNode([join(packageRoot, 'scripts', 'tailscale.mjs'), 'url'], {
      cwd: repoRoot,
      env: buildStackFixtureEnv({
        homeDir: join(tmp, 'home'),
        storageDir: join(tmp, 'storage'),
        stripStackEnv: true,
        extraEnv: {
          HAPPIER_TAILSCALE_BIN: tailscaleBin,
          HAPPIER_STACK_SERVER_PORT: String(relayPort),
          HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: '1',
        },
      }),
    });

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.equal(stripAnsi(res.stdout).trim(), relayUrl);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('tailscale url fails closed when serve status points at a different local port', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const repoRoot = dirname(dirname(packageRoot));

  const tmp = mkdtempSync(join(tmpdir(), 'happier-tailscale-url-mismatch-test-'));
  try {
    const binDir = join(tmp, 'bin');
    mkdirSync(binDir, { recursive: true });
    const tailscaleBin = join(binDir, 'tailscale');

    writeFileSync(
      tailscaleBin,
      [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        "if (args[0] === 'serve' && args[1] === 'status') {",
        "  process.stdout.write('https://other-service.ts.net\\n');",
        "  process.stdout.write('|-- / proxy http://127.0.0.1:8080\\n');",
        '  process.exit(0);',
        '}',
        'process.exit(0);',
        '',
      ].join('\n')
    );
    chmodSync(tailscaleBin, 0o755);

    const res = await runNode([join(packageRoot, 'scripts', 'tailscale.mjs'), 'url'], {
      cwd: repoRoot,
      env: buildStackFixtureEnv({
        homeDir: join(tmp, 'home'),
        storageDir: join(tmp, 'storage'),
        stripStackEnv: true,
        extraEnv: {
          HAPPIER_TAILSCALE_BIN: tailscaleBin,
          HAPPIER_STACK_SERVER_PORT: '35555',
          HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: '1',
        },
      }),
    });

    assert.notEqual(res.code, 0, `expected non-zero exit, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.match(stripAnsi(res.stderr), /no https:\/\/ URL found/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
