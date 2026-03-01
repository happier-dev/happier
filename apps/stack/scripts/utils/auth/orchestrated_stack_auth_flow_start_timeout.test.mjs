import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareGuidedLoginWebapp } from './orchestrated_stack_auth_flow.mjs';

test('prepareGuidedLoginWebapp times out if starting stack UI in background hangs (configurable)', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-ui-start-timeout-'));
  const rootDir = join(tmp, 'root');
  const storageDir = join(tmp, 'storage');
  const stackDir = join(storageDir, 'main');
  const envPath = join(stackDir, 'env');

  try {
    await mkdir(join(rootDir, 'scripts'), { recursive: true });
    await mkdir(stackDir, { recursive: true });

    await writeFile(
      join(rootDir, 'scripts', 'stack.mjs'),
      [
        "import { setTimeout as delay } from 'node:timers/promises';",
        'await delay(200);',
        'process.exit(0);',
        '',
      ].join('\n'),
      'utf-8'
    );

    await writeFile(
      envPath,
      [
        'HAPPIER_STACK_STACK=main',
        `HAPPIER_STACK_REPO_DIR=${join(tmp, 'repo')}`,
        'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
        'HAPPIER_STACK_TAILSCALE_SERVE=0',
        '',
      ].join('\n'),
      'utf-8'
    );

    const env = {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: 'main',
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_AUTH_FLOW: '1',
      HAPPIER_STACK_AUTH_UI_READY_TIMEOUT_MS: '1',
      HAPPIER_STACK_AUTH_UI_START_TIMEOUT_MS: '10',
    };

    await assert.rejects(
      async () => {
        await prepareGuidedLoginWebapp({ rootDir, stackName: 'main', env });
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /startup failed/i);
        assert.match(err.message, /timed out/i);
        return true;
      }
    );
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

