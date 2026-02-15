import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getStackRootFromMeta, runNodeCapture } from './testkit/auth_testkit.mjs';

test('hstack mobile --prebuild does not crash with undefined happyDir', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const mobileScript = join(rootDir, 'scripts', 'mobile.mjs');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-mobile-'));
  const repoDir = join(tmp, 'repo');
  const storageDir = join(tmp, 'storage');

  try {
    // Minimal fixture: the script expects a "happier-ui" dir to exist at <repo>/apps/ui.
    // Avoid creating package.json to keep the run hermetic (ensureDepsInstalled will no-op).
    await mkdir(join(repoDir, 'apps', 'ui'), { recursive: true });

    // Ensure stack storage stays within this tmp dir (avoid touching real ~/.happier paths).
    await mkdir(join(storageDir, 'main'), { recursive: true });

    const env = {
      ...process.env,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: 'main',
      // Keep resolveServerUrls from probing tailscale in tests.
      HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL: '0',
      HAPPIER_STACK_TAILSCALE_SERVE: '0',
      // Prevent env auto-loading from a real machine stack env file.
      HAPPIER_STACK_ENV_FILE: join(tmp, 'nonexistent-env'),
    };

    const res = await runNodeCapture([mobileScript, '--prebuild', '--no-metro'], { cwd: rootDir, env });
    assert.doesNotMatch(
      res.stderr,
      /\bhappyDir is not defined\b/,
      `expected prebuild to fail for a real reason (e.g. missing expo), not a ReferenceError\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
