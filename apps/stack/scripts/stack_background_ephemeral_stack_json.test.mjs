import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNodeCaptureSync } from './testkit/core/run_node_capture.mjs';

async function ensureMinimalMonorepo({ monoRoot }) {
  await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
}

test('hstack stack start <ephemeral> --background --json stays a dry-run and does not create runtime state', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-bg-ephemeral-'));
  try {
    const storageDir = join(tmp, 'storage');
    const monoRoot = join(tmp, 'happier');
    const stackName = 'exp1';
    const stackDir = join(storageDir, stackName);
    const envPath = join(stackDir, 'env');
    const runtimeStatePath = join(stackDir, 'stack.runtime.json');

    await ensureMinimalMonorepo({ monoRoot });
    await mkdir(stackDir, { recursive: true });
    await writeFile(
      envPath,
      [
        `HAPPIER_STACK_STACK=${stackName}`,
        `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
        'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
        'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
        'HAPPIER_STACK_TAILSCALE_SERVE=0',
        '',
      ].join('\n'),
      'utf-8',
    );

    const env = {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
    };

    const res = runNodeCaptureSync(
      [join(rootDir, 'scripts', 'stack.mjs'), 'start', stackName, '--background', '--json'],
      { cwd: rootDir, env, timeout: 5_000 },
    );

    assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const parsed = JSON.parse(String(res.stdout).trim());
    assert.equal(parsed?.mode, 'start');
    assert.equal(parsed?.launchMode, 'source');
    assert.equal(existsSync(runtimeStatePath), false, 'dry-run must not create stack.runtime.json');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
