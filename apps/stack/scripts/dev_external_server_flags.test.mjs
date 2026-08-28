import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

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
    [devScript, '--json', '--server-url=https://api.example.com', '--no-dev-targets'],
    { cwd: repoRoot, env: process.env }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.startServer, false);
  assert.equal(parsed.serverConnectionSource, 'cli-arg');
  assert.equal(parsed.internalServerUrl, 'https://api.example.com');
  assert.equal(parsed.publicServerUrl, 'https://api.example.com');
});

test('external-server startup sanitizes parent preflight authority before descendant orchestration', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(join(scriptsDir, 'dev.mjs'), 'utf8');
  const orchestrationEnvBoundary = source.indexOf('const baseEnv = { ...process.env };');
  const runtimeStartBoundary = source.indexOf('await recordStackRuntimeStart');
  const watchdogBoundary = source.indexOf('spawnStackOwnerDeathWatchdog({');
  const optionalServerBoundary = source.indexOf('const { serverEnv, serverScript, serverProc }');
  const descendantBoundary = source.indexOf('const accountProbe');
  const sanitationBoundary = source.indexOf('delete baseEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE');

  assert.ok(
    orchestrationEnvBoundary >= 0
      && sanitationBoundary > orchestrationEnvBoundary
      && runtimeStartBoundary > sanitationBoundary
      && watchdogBoundary > runtimeStartBoundary
      && optionalServerBoundary > watchdogBoundary
      && descendantBoundary > optionalServerBoundary,
    'the long-lived env must be sanitized before runtime publication, watchdog spawn, and optional descendants',
  );
  assert.match(source.slice(optionalServerBoundary, descendantBoundary), /parentServerRestartPreflightAlreadyDone/);
});

test('dev --tauri --json reports desktop tauri mode', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root
  const devScript = join(packageRoot, 'scripts', 'dev.mjs');

  const res = await runNode(
    [devScript, '--json', '--tauri'],
    { cwd: repoRoot, env: process.env }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.startTauri, true);
  assert.equal(parsed.startUi, true);
});

test('dev --expo-tailscale --json enables mobile dev-client mode', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root
  const devScript = join(packageRoot, 'scripts', 'dev.mjs');

  const res = await runNode(
    [devScript, '--json', '--expo-tailscale', '--server-url=https://api.example.com', '--no-daemon', '--no-dev-targets'],
    { cwd: repoRoot, env: process.env }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.startMobile, true);
});

test('dev --json discovers stack-scoped remote development targets without starting Mutagen', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const repoRoot = dirname(dirname(packageRoot));
  const devScript = join(packageRoot, 'scripts', 'dev.mjs');
  const storageDir = await mkdtemp(join(tmpdir(), 'hstack-dev-json-targets-'));
  const stackName = 'repo-json-targets';
  try {
    const stackDir = join(storageDir, stackName);
    await mkdir(stackDir, { recursive: true });
    await writeFile(
      join(stackDir, 'dev-targets.json'),
      JSON.stringify({
        version: 1,
        targets: [
          {
            name: 'linux',
            platform: 'posix',
            ssh: 'happier-stack-linux',
            repoDir: '/home/dev/happier',
            cliHomeDir: '/home/dev/.happier/linux',
          },
        ],
      }),
    );
    const res = await runNode([devScript, '--json'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_HOME_DIR: join(storageDir, 'home'),
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        HAPPIER_STACK_SANDBOX_DIR: join(storageDir, 'sandbox'),
        HAPPIER_STACK_REPO_DIR: '',
        HAPPIER_STACK_ENV_FILE: '',
        HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
      },
    });
    assert.equal(res.code, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.deepEqual(parsed.devTargets.map((target) => target.name), ['linux']);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('--no-dev-targets cannot bypass persisted remote server placement into the local Stack', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const repoRoot = dirname(dirname(packageRoot));
  const devScript = join(packageRoot, 'scripts', 'dev.mjs');
  const storageDir = await mkdtemp(join(tmpdir(), 'hstack-dev-remote-server-authority-'));
  const stackName = 'repo-remote-server-authority';
  try {
    const stackDir = join(storageDir, stackName);
    await mkdir(stackDir, { recursive: true });
    await writeFile(
      join(stackDir, 'dev-targets.json'),
      JSON.stringify({
        version: 2,
        targets: [{
          name: 'mac',
          platform: 'posix',
          ssh: 'happier-stack-mac',
          repoDir: '/Users/dev/happier',
          cliHomeDir: '/Users/dev/.happier/mac',
        }],
        runtimePlacement: {
          server: { mode: 'prefer-target', target: 'mac' },
        },
      }),
    );
    const res = await runNode([devScript, '--json', '--no-dev-targets'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_HOME_DIR: join(storageDir, 'home'),
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        HAPPIER_STACK_SANDBOX_DIR: join(storageDir, 'sandbox'),
        HAPPIER_STACK_REPO_DIR: '',
        HAPPIER_STACK_ENV_FILE: '',
        HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
      },
    });
    assert.equal(res.code, 1, `unexpected success:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /--no-dev-targets.*remote server placement/i);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('configured dev targets fail closed when dev uses an external server', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const repoRoot = dirname(dirname(packageRoot));
  const devScript = join(packageRoot, 'scripts', 'dev.mjs');
  const storageDir = await mkdtemp(join(tmpdir(), 'hstack-dev-external-targets-'));
  const stackName = 'repo-external-targets';
  try {
    const stackDir = join(storageDir, stackName);
    await mkdir(stackDir, { recursive: true });
    await writeFile(
      join(stackDir, 'dev-targets.json'),
      JSON.stringify({
        version: 1,
        targets: [
          {
            name: 'linux',
            platform: 'posix',
            ssh: 'happier-stack-linux',
            repoDir: '/home/dev/happier',
            cliHomeDir: '/home/dev/.happier/linux',
          },
        ],
      }),
    );
    const res = await runNode([devScript, '--json', '--server-url=https://api.example.com'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_HOME_DIR: join(storageDir, 'home'),
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        HAPPIER_STACK_SANDBOX_DIR: join(storageDir, 'sandbox'),
        HAPPIER_STACK_REPO_DIR: '',
        HAPPIER_STACK_ENV_FILE: '',
        HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
      },
    });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /remote runtime placement.*external --server-url/i);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
