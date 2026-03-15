import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCapture as runNode } from './testkit/stack_script_command_testkit.mjs';

function resolveStackRootDir() {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  return dirname(scriptsDir);
}

async function writeJson(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

async function createLocalRepoFixture() {
  const rootDir = resolveStackRootDir();
  const baseDir = await mkdtemp(join(tmpdir(), 'hstack-stable-branch-'));
  const sandboxDir = join(baseDir, 'sandbox');
  const fakeRepoDir = join(baseDir, 'fake-repo');

  await mkdir(sandboxDir, { recursive: true });
  await mkdir(fakeRepoDir, { recursive: true });

  // Minimal monorepo markers for isHappyMonorepoRoot().
  await writeJson(join(fakeRepoDir, 'apps', 'ui', 'package.json'), { name: 'ui', private: true });
  await writeJson(join(fakeRepoDir, 'apps', 'cli', 'package.json'), { name: 'cli', private: true });
  await writeJson(join(fakeRepoDir, 'apps', 'server', 'package.json'), { name: 'server', private: true });

  return { rootDir, baseDir, sandboxDir, fakeRepoDir };
}

test('hstack setup-from-source --stable-branch persists HAPPIER_STACK_STABLE_BRANCH', async () => {
  const { rootDir, baseDir, sandboxDir, fakeRepoDir } = await createLocalRepoFixture();

  // Pre-create the "local" stack so local-repo profile can reuse it without running stack creation.
  const localStackEnvPath = join(sandboxDir, 'storage', 'local', 'env');
  await mkdir(dirname(localStackEnvPath), { recursive: true });
  await writeFile(localStackEnvPath, `HAPPIER_STACK_REPO_DIR=${fakeRepoDir}\n`, 'utf-8');

  try {
    const res = await runNode(
      [
        join(rootDir, 'bin', 'hstack.mjs'),
        `--sandbox-dir=${sandboxDir}`,
        'setup-from-source',
        '--profile=local-repo',
        `--repo-dir=${fakeRepoDir}`,
        '--stable-branch=preview',
        '--server=happier-server-light',
        '--non-interactive',
        '--no-auth',
        '--no-tailscale',
        '--no-autostart',
        '--no-menubar',
        '--no-start-now',
      ],
      { cwd: rootDir, env: { ...process.env, HAPPIER_STACK_TEST_TTY: '0' } }
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

    const mainEnvPath = join(sandboxDir, 'storage', 'main', 'env');
    const mainEnv = await readFile(mainEnvPath, 'utf-8');
    assert.match(mainEnv, /^HAPPIER_STACK_STABLE_BRANCH=preview$/m);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('hstack setup-from-source --stable-branch rejects whitespace', async () => {
  const { rootDir, baseDir, sandboxDir, fakeRepoDir } = await createLocalRepoFixture();
  try {
    const res = await runNode(
      [
        join(rootDir, 'bin', 'hstack.mjs'),
        `--sandbox-dir=${sandboxDir}`,
        'setup-from-source',
        '--profile=local-repo',
        `--repo-dir=${fakeRepoDir}`,
        '--stable-branch=bad branch',
        '--server=happier-server-light',
        '--non-interactive',
        '--no-auth',
        '--no-tailscale',
        '--no-autostart',
        '--no-menubar',
        '--no-start-now',
      ],
      { cwd: rootDir, env: { ...process.env, HAPPIER_STACK_TEST_TTY: '0' } }
    );
    assert.notEqual(res.code, 0, `expected non-zero exit\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.match(res.stderr, /--stable-branch must not contain whitespace/);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('hstack setup-from-source rejects conflicting --stable-branch and --branch', async () => {
  const { rootDir, baseDir, sandboxDir, fakeRepoDir } = await createLocalRepoFixture();
  try {
    const res = await runNode(
      [
        join(rootDir, 'bin', 'hstack.mjs'),
        `--sandbox-dir=${sandboxDir}`,
        'setup-from-source',
        '--profile=local-repo',
        `--repo-dir=${fakeRepoDir}`,
        '--stable-branch=preview',
        '--branch=main',
        '--server=happier-server-light',
        '--non-interactive',
        '--no-auth',
        '--no-tailscale',
        '--no-autostart',
        '--no-menubar',
        '--no-start-now',
      ],
      { cwd: rootDir, env: { ...process.env, HAPPIER_STACK_TEST_TTY: '0' } }
    );
    assert.notEqual(res.code, 0, `expected non-zero exit\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.match(res.stderr, /conflicting stable branch args/);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
