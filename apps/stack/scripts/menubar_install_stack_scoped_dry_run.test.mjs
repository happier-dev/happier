import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function runHstack(args, { env } = {}) {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const repoRoot = resolve(rootDir, '..', '..');
  const hstackBin = resolve(repoRoot, 'apps', 'stack', 'bin', 'hstack.mjs');

  return spawnSync(process.execPath, [hstackBin, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      HAPPIER_STACK_UPDATE_CHECK: '0',
      ...env,
    },
    encoding: 'utf8',
  });
}

test('hstack menubar install --dry-run derives a unique plugin basename for non-main stacks', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-menubar-dryrun-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  const storageDir = join(tmp, 'stacks');
  const stackName = 'repo-foo-1234567890';
  const stackDir = join(storageDir, stackName);
  await mkdir(stackDir, { recursive: true });
  const envFile = join(stackDir, 'env');
  await writeFile(envFile, 'HAPPIER_STACK_STACK=repo-foo-1234567890\n', 'utf8');

  const res = runHstack(['menubar', 'install', '--dry-run', '--json'], {
    env: {
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envFile,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
    },
  });
  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.stack?.name, stackName);
  assert.equal(data.swiftbar?.wrapper, true);
  assert.match(String(data.swiftbar?.pluginBasename ?? ''), /^hstack-[a-z0-9-]+-[a-f0-9]{6}$/);
  assert.equal(data.swiftbar?.pluginBasename === 'hstack', false);
  assert.equal(data.swiftbar?.pluginFile, `${data.swiftbar.pluginBasename}.5m.sh`);
});

test('hstack menubar install --dry-run keeps the default plugin basename for main', () => {
  const res = runHstack(['menubar', 'install', '--dry-run', '--json'], {
    env: {
      HAPPIER_STACK_STACK: 'main',
    },
  });
  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.stack?.name, 'main');
  assert.equal(data.swiftbar?.wrapper, false);
  assert.equal(data.swiftbar?.pluginBasename, 'hstack');
  assert.equal(data.swiftbar?.pluginFile, 'hstack.5m.sh');
});

test('hstack menubar install --dry-run uses the explicit stack env file instead of a stale exported env file', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-menubar-explicit-stack-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  const storageDir = join(tmp, 'stacks');
  const mainDir = join(storageDir, 'main');
  const devBuiltDir = join(storageDir, 'dev-built');
  await mkdir(mainDir, { recursive: true });
  await mkdir(devBuiltDir, { recursive: true });

  const mainEnvFile = join(mainDir, 'env');
  const devBuiltEnvFile = join(devBuiltDir, 'env');
  await writeFile(mainEnvFile, 'HAPPIER_STACK_STACK=main\n', 'utf8');
  await writeFile(devBuiltEnvFile, 'HAPPIER_STACK_STACK=dev-built\n', 'utf8');

  const res = runHstack(['menubar', 'install', '--stack=dev-built', '--dry-run', '--json'], {
    env: {
      HAPPIER_STACK_STACK: 'main',
      HAPPIER_STACK_ENV_FILE: mainEnvFile,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
    },
  });
  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.stack?.name, 'dev-built');
  assert.equal(data.stack?.envFile, devBuiltEnvFile);
});

test('hstack menubar install --dry-run honors an explicit mode flag', () => {
  const res = runHstack(['menubar', 'install', '--stack=dev-built', '--mode=selfhost', '--dry-run', '--json'], {
    env: {
      HAPPIER_STACK_STACK: 'main',
    },
  });
  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.mode, 'selfhost');
});
