import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getStackRootFromMeta, runNodeCapture } from './testkit/auth_testkit.mjs';

test('hstack mobile --json reports Expo Tailscale mode from flag', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const mobileScript = join(rootDir, 'scripts', 'mobile.mjs');
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-mobile-expo-ts-'));
  const repoDir = join(tmp, 'repo');
  const storageDir = join(tmp, 'storage');

  try {
    await mkdir(join(repoDir, 'apps', 'ui'), { recursive: true });
    await mkdir(join(storageDir, 'main'), { recursive: true });

    const env = {
      ...process.env,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: 'main',
      HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL: '0',
      HAPPIER_STACK_TAILSCALE_SERVE: '0',
      HAPPIER_STACK_ENV_FILE: join(tmp, 'nonexistent-env'),
    };

    const res = await runNodeCapture([mobileScript, '--json', '--expo-tailscale', '--no-metro'], { cwd: rootDir, env });

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.expoTailscale, true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
