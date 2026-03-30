import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

test('tauri_dev --json prints the resolved launch plan without running build hooks', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauri_dev.mjs');

  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
    cwd: dirname(scriptsDir),
    env: {
      ...process.env,
      HAPPIER_STACK_TAURI_WAIT_FOR_EXPO: '0',
    },
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

test('tauri_dev fails fast with a clear error when repo dir does not contain src-tauri', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauri_dev.mjs');

  const fakeRepo = await mkdir(join(tmpdir(), `happier-tauri-dev-missing-repo-${Date.now()}`), { recursive: true });

  let stderr = '';
  try {
    await execFileAsync(process.execPath, [scriptPath], {
      cwd: dirname(scriptsDir),
      env: {
        ...process.env,
        HAPPIER_STACK_TAURI_WAIT_FOR_EXPO: '0',
        HAPPIER_STACK_REPO_DIR: fakeRepo,
      },
      encoding: 'utf8',
    });
    assert.fail('expected tauri_dev to fail');
  } catch (error) {
    stderr = String(error?.stderr ?? '');
  }

  assert.match(
    stderr,
    /\[tauri-dev\] failed: \[tauri-dev\] expected a Happier repo checkout containing apps\/ui\/src-tauri/i
  );
});

test('tauri_dev falls back to HAPPIER_STACK_CLI_ROOT_DIR when HAPPIER_STACK_REPO_DIR is misconfigured', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = dirname(scriptsDir);
  const scriptPath = join(scriptsDir, 'tauri_dev.mjs');
  const fakeRepo = await mkdir(join(tmpdir(), `happier-tauri-dev-bad-repo-${Date.now()}`), { recursive: true });

  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HAPPIER_STACK_TAURI_WAIT_FOR_EXPO: '0',
      HAPPIER_STACK_REPO_DIR: fakeRepo,
      HAPPIER_STACK_CLI_ROOT_DIR: repoRoot,
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    },
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
    env: {
      ...process.env,
      HAPPIER_STACK_TAURI_WAIT_FOR_EXPO: '0',
      HAPPIER_STACK_REPO_DIR: fakeRepo,
      HAPPIER_STACK_CLI_ROOT_DIR: repoRoot,
    },
    encoding: 'utf8',
  });

  assert.equal(String(stderr ?? '').trim(), '');
  const payload = JSON.parse(stdout);
  assert.equal(payload?.ok, true);
  const normalizedConfigPath = String(payload?.configPath ?? '').trim().replaceAll('\\', '/');
  assert.equal(normalizedConfigPath.endsWith('/apps/ui/src-tauri/tauri.publicdev.conf.json'), true);
});
