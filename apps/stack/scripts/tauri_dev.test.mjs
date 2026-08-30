import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { buildStackFixtureEnv } from './testkit/core/env_scope.mjs';

const execFileAsync = promisify(execFile);
let fixtureCargoHome = '';

test.before(async () => {
  fixtureCargoHome = await mkdtemp(join(tmpdir(), 'happier-tauri-dev-cargo-'));
  const cargoBinDir = join(fixtureCargoHome, 'bin');
  const cargoBinary = join(cargoBinDir, process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  await mkdir(cargoBinDir, { recursive: true });
  // A copy of Node is a portable executable fixture: `cargo --version` only needs
  // to prove that the resolved runner can execute for these plan-only CLI tests.
  await copyFile(process.execPath, cargoBinary);
  if (process.platform !== 'win32') await chmod(cargoBinary, 0o755);
});

test.after(async () => {
  if (fixtureCargoHome) await rm(fixtureCargoHome, { recursive: true, force: true });
});

function isolatedTauriEnv(extraEnv = {}) {
  return buildStackFixtureEnv({
    baseEnv: process.env,
    stripStackEnv: true,
    extraEnv: { CARGO_HOME: fixtureCargoHome, ...extraEnv },
  });
}

test('tauri_dev --json prints the resolved launch plan without running build hooks', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauri_dev.mjs');

  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
    cwd: dirname(scriptsDir),
    env: isolatedTauriEnv({
      HAPPIER_STACK_TAURI_WAIT_FOR_EXPO: '0',
    }),
    encoding: 'utf8',
  });

  assert.equal(String(stderr ?? '').trim(), '');
  assert.equal(String(stdout ?? '').trim().startsWith('{'), true);
  assert.equal(stdout.includes('yarn run'), false);
  assert.equal(stdout.includes('prepareTauriSidecar'), false);

  const payload = JSON.parse(stdout);
  assert.equal(payload?.ok, true);
  assert.equal(typeof payload?.devUrl, 'string');
  const normalizedConfigPath = String(payload?.configPath ?? '').trim().replaceAll('\\', '/');
  assert.equal(normalizedConfigPath.endsWith('/apps/ui/src-tauri/tauri.publicdev.conf.json'), true);
});

test('tauri_dev prefers the ready runtime Expo port over an environment pin', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauri_dev.mjs');
  const repoRoot = dirname(scriptsDir);

  const storageRoot = join(tmpdir(), `happier-tauri-dev-storage-${Date.now()}`);
  const stackName = `tauri-port-preference-${Date.now()}`;
  const stackBaseDir = join(storageRoot, stackName);
  const runtimeStatePath = join(stackBaseDir, 'stack.runtime.json');
  await mkdir(stackBaseDir, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify(
      {
        version: 1,
        stackName,
        expo: { webPort: 54321 },
      },
      null,
      2,
    ),
    'utf-8',
  );

  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
    cwd: repoRoot,
    env: isolatedTauriEnv({
      HAPPIER_STACK_TAURI_WAIT_FOR_EXPO: '0',
      HAPPIER_STACK_STORAGE_DIR: storageRoot,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_EXPO_DEV_PORT: '12345',
    }),
    encoding: 'utf8',
  });

  assert.equal(String(stderr ?? '').trim(), '');
  const payload = JSON.parse(stdout);
  assert.equal(payload?.ok, true);
  assert.equal(payload?.stackName, stackName);
  assert.equal(payload?.devUrl?.startsWith('http://localhost:54321'), true);
  assert.equal(payload?.devUrl?.includes('12345'), false);
});

test('tauri_dev prefers the ready runtime Expo port over the stack env-file pin', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauri_dev.mjs');
  const repoRoot = dirname(scriptsDir);

  const storageRoot = join(tmpdir(), `happier-tauri-dev-storage-envfile-${Date.now()}`);
  const stackName = `tauri-envfile-preference-${Date.now()}`;
  const stackBaseDir = join(storageRoot, stackName);
  const runtimeStatePath = join(stackBaseDir, 'stack.runtime.json');
  await mkdir(stackBaseDir, { recursive: true });
  await writeFile(
    runtimeStatePath,
    JSON.stringify(
      {
        version: 1,
        stackName,
        expo: { webPort: 54321 },
      },
      null,
      2,
    ),
    'utf-8',
  );
  await writeFile(join(stackBaseDir, 'env'), 'HAPPIER_STACK_EXPO_DEV_PORT=12345\n', 'utf-8');

  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
    cwd: repoRoot,
    env: isolatedTauriEnv({
      HAPPIER_STACK_TAURI_WAIT_FOR_EXPO: '0',
      HAPPIER_STACK_EXPO_DEV_PORT: '0',
      HAPPIER_STACK_STORAGE_DIR: storageRoot,
      HAPPIER_STACK_STACK: stackName,
    }),
    encoding: 'utf8',
  });

  assert.equal(String(stderr ?? '').trim(), '');
  const payload = JSON.parse(stdout);
  assert.equal(payload?.ok, true);
  assert.equal(payload?.stackName, stackName);
  assert.equal(payload?.devUrl?.startsWith('http://localhost:54321'), true);
  assert.equal(payload?.devUrl?.includes('12345'), false);
});

test('tauri_dev falls back to HAPPIER_STACK_CLI_ROOT_DIR when HAPPIER_STACK_REPO_DIR is misconfigured', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = dirname(scriptsDir);
  const scriptPath = join(scriptsDir, 'tauri_dev.mjs');
  const fakeRepo = await mkdir(join(tmpdir(), `happier-tauri-dev-bad-repo-${Date.now()}`), { recursive: true });

  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
    cwd: repoRoot,
    env: isolatedTauriEnv({
      HAPPIER_STACK_TAURI_WAIT_FOR_EXPO: '0',
      HAPPIER_STACK_REPO_DIR: fakeRepo,
      HAPPIER_STACK_CLI_ROOT_DIR: repoRoot,
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    }),
    encoding: 'utf8',
  });

  assert.equal(String(stderr ?? '').trim(), '');
  const payload = JSON.parse(stdout);
  assert.equal(payload?.ok, true);
  const normalizedUiDir = String(payload?.uiDir ?? '').replaceAll('\\', '/');
  assert.equal(normalizedUiDir.endsWith('/apps/ui'), true);
  const normalizedTauriCwd = String(payload?.tauri?.cwd ?? '').replaceAll('\\', '/');
  assert.equal(normalizedTauriCwd.endsWith('/apps/ui/src-tauri'), true);
  const normalizedTauriArgs = Array.isArray(payload?.tauri?.args) ? payload.tauri.args.map((arg) => String(arg).replaceAll('\\', '/')) : [];
  assert.equal(normalizedTauriArgs.some((arg) => arg.endsWith('/node_modules/@tauri-apps/cli/tauri.js')), true);
});

test('tauri_dev --json falls back to the CLI root repo when the stack repo dir is missing src-tauri', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauri_dev.mjs');
  const repoRoot = dirname(scriptsDir);

  const fakeRepo = await mkdir(join(tmpdir(), `happier-tauri-dev-fallback-repo-${Date.now()}`), { recursive: true });

  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
    cwd: repoRoot,
    env: isolatedTauriEnv({
      HAPPIER_STACK_TAURI_WAIT_FOR_EXPO: '0',
      HAPPIER_STACK_REPO_DIR: fakeRepo,
      HAPPIER_STACK_CLI_ROOT_DIR: repoRoot,
    }),
    encoding: 'utf8',
  });

  assert.equal(String(stderr ?? '').trim(), '');
  const payload = JSON.parse(stdout);
  assert.equal(payload?.ok, true);
  const normalizedConfigPath = String(payload?.configPath ?? '').trim().replaceAll('\\', '/');
  assert.equal(normalizedConfigPath.endsWith('/apps/ui/src-tauri/tauri.publicdev.conf.json'), true);
});
