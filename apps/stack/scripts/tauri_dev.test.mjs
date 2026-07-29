import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

function cleanTauriDevTestEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('HAPPIER_STACK_')) {
      delete env[key];
    }
  }
  delete env.HAPPIER_HOME_DIR;
  delete env.HAPPIER_SERVER_URL;
  delete env.HAPPIER_WEBAPP_URL;
  delete env.HAPPIER_ACTIVE_SERVER_ID;
  return {
    ...env,
    HAPPIER_STACK_HOME_DIR: join(tmpdir(), `happier-tauri-dev-home-${process.pid}`),
    HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    ...overrides,
  };
}

test('tauri_dev --json prints the resolved launch plan without running build hooks', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauri_dev.mjs');

  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
    cwd: dirname(scriptsDir),
    env: cleanTauriDevTestEnv({
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
  const configJson = JSON.parse(await readFile(payload.configPath, 'utf8'));
  assert.equal(configJson?.app?.windows?.[0]?.incognito, true);
  const url = new URL(String(payload.devUrl));
  assert.equal(url.searchParams.has('happier_tauri_ts'), true);
  assert.equal(url.searchParams.has('happier_tauri_launch_id'), true);
  assert.match(String(url.searchParams.get('happier_tauri_launch_id') ?? ''), /^[0-9a-f-]{36}$/i);
});

test('tauri_dev --json can disable the cache-busting params when explicitly requested', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauri_dev.mjs');

  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
    cwd: dirname(scriptsDir),
    env: cleanTauriDevTestEnv({
      HAPPIER_STACK_TAURI_WAIT_FOR_EXPO: '0',
      HAPPIER_STACK_TAURI_DEV_URL_CACHE_BUST: '0',
    }),
    encoding: 'utf8',
  });

  assert.equal(String(stderr ?? '').trim(), '');
  const payload = JSON.parse(stdout);
  assert.equal(payload?.ok, true);
  const url = new URL(String(payload.devUrl));
  assert.equal(url.searchParams.has('happier_tauri_ts'), false);
  assert.equal(url.searchParams.has('happier_tauri_launch_id'), false);
});

test('tauri_dev prefers the explicit stack expo dev port over stale runtime state ports', async (t) => {
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
    env: cleanTauriDevTestEnv({
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
  assert.equal(payload?.devUrl?.startsWith('http://127.0.0.1:12345'), true);
  assert.equal(payload?.devUrlSource, 'env');
  assert.equal(payload?.devUrl?.includes('54321'), false);
});

test('tauri_dev prefers the pinned expo dev port from the stack env file over stale runtime state ports', async () => {
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
    env: cleanTauriDevTestEnv({
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
  assert.equal(payload?.devUrl?.startsWith('http://127.0.0.1:12345'), true);
  assert.equal(payload?.devUrlSource, 'stackEnvFile');
  assert.equal(payload?.devUrl?.includes('54321'), false);
});

test('tauri_dev reads the pinned expo dev port from HAPPIER_STACK_ENV_FILE when provided', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauri_dev.mjs');
  const repoRoot = dirname(scriptsDir);

  const storageRoot = join(tmpdir(), `happier-tauri-dev-storage-explicit-envfile-${Date.now()}`);
  const stackName = `tauri-explicit-envfile-${Date.now()}`;
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

  const explicitEnvFile = join(tmpdir(), `happier-tauri-dev-explicit-env-${Date.now()}.env`);
  await writeFile(explicitEnvFile, 'HAPPIER_STACK_EXPO_DEV_PORT=12345\n', 'utf-8');

  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
    cwd: repoRoot,
    env: cleanTauriDevTestEnv({
      HAPPIER_STACK_TAURI_WAIT_FOR_EXPO: '0',
      HAPPIER_STACK_EXPO_DEV_PORT: '0',
      HAPPIER_STACK_STORAGE_DIR: storageRoot,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: explicitEnvFile,
    }),
    encoding: 'utf8',
  });

  assert.equal(String(stderr ?? '').trim(), '');
  const payload = JSON.parse(stdout);
  assert.equal(payload?.ok, true);
  assert.equal(payload?.stackName, stackName);
  assert.equal(payload?.devUrl?.startsWith('http://127.0.0.1:12345'), true);
  assert.equal(payload?.devUrlSource, 'stackEnvFile');
  assert.equal(payload?.devUrl?.includes('54321'), false);
});

test('tauri_dev fails fast with a clear error when repo dir does not contain src-tauri', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(scriptsDir, 'tauri_dev.mjs');

  const fakeRepo = await mkdir(join(tmpdir(), `happier-tauri-dev-missing-repo-${Date.now()}`), { recursive: true });

  let stderr = '';
  try {
    await execFileAsync(process.execPath, [scriptPath], {
      cwd: dirname(scriptsDir),
      env: cleanTauriDevTestEnv({
        HAPPIER_STACK_TAURI_WAIT_FOR_EXPO: '0',
        HAPPIER_STACK_REPO_DIR: fakeRepo,
      }),
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
    env: cleanTauriDevTestEnv({
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
    env: cleanTauriDevTestEnv({
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
