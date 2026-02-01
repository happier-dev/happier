import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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
    proc.on('exit', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

async function writeStubHappyCli({ dir }) {
  await mkdir(join(dir, 'bin'), { recursive: true });
  await mkdir(join(dir, 'dist'), { recursive: true });

  // `scripts/doctor.mjs` runs: node <cliBin> daemon status
  await writeFile(
    join(dir, 'bin', 'happy.mjs'),
    [
      `if (process.argv.includes('daemon') && process.argv.includes('status')) {`,
      `  console.log('Daemon is running');`,
      `  process.exit(0);`,
      `}`,
      `console.log('ok');`,
    ].join('\n'),
    'utf-8'
  );

  // Keep dist present to avoid incidental MODULE_NOT_FOUND in other helper paths.
  await writeFile(join(dir, 'dist', 'index.mjs'), `export {};`, 'utf-8');
}

test('doctor does not crash in non-json mode (kv helper not shadowed)', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-doctor-'));
  const monoRoot = join(tmp, 'workspace', 'happier');
  const stubServer = join(monoRoot, 'apps', 'server');
  const stubCli = join(monoRoot, 'apps', 'cli');
  await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(stubServer, { recursive: true });
  await mkdir(stubCli, { recursive: true });
  await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeStubHappyCli({ dir: stubCli });

  const env = {
    ...process.env,
    HAPPIER_STACK_REPO_DIR: monoRoot,
    // Avoid UI build dir checks (keeps this test hermetic).
    HAPPIER_STACK_SERVE_UI: '0',
    // Avoid any side effects in temp runs.
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
  };

  const res = await runNode([join(rootDir, 'scripts', 'doctor.mjs')], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /doctor/i);
  assert.match(res.stdout, /Details/);
});
