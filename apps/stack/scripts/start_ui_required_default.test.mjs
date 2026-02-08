import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
    proc.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('hstack start fails closed when UI serving is enabled and index.html is missing (default uiRequired)', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-start-ui-required-'));
  try {
    const monoRoot = join(tmp, 'happier');

    await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
    await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
    await mkdir(join(monoRoot, 'apps', 'server'), { recursive: true });
    await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');

    const uiBuildDir = join(tmp, 'ui');
    await mkdir(uiBuildDir, { recursive: true });
    await writeFile(join(uiBuildDir, 'canvaskit.wasm'), 'stub\n', 'utf-8');

    const env = {
      ...process.env,
      HAPPIER_STACK_REPO_DIR: monoRoot,
      HAPPIER_STACK_SERVE_UI: '1',
      HAPPIER_STACK_UI_BUILD_DIR: uiBuildDir,
      // Ensure we do not spawn real services during this test.
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      HAPPIER_STACK_TAILSCALE_SERVE: '0',
    };

    const res = await runNode([join(rootDir, 'scripts', 'run.mjs'), '--json'], { cwd: rootDir, env });
    assert.ok(
      res.code === 0 && !res.signal,
      `sanity: --json should exit cleanly\ncode: ${res.code}\nsignal: ${res.signal}\nstderr:\n${res.stderr}`
    );

    const res2 = await runNode([join(rootDir, 'scripts', 'run.mjs')], { cwd: rootDir, env });
    assert.ok(res2.code !== 0 || Boolean(res2.signal), `expected non-zero exit\ncode: ${res2.code}\nsignal: ${res2.signal}`);
    assert.match(res2.stderr + res2.stdout, /index\.html/i);
    assert.match(res2.stderr + res2.stdout, /hstack build/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
