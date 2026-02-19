import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createAuthStackFixture, getStackRootFromMeta, hstackBinPath, runNodeCapture } from './testkit/auth_testkit.mjs';

test('hstack auth login --print --json uses stack.runtime.json server port when HAPPIER_STACK_SERVER_PORT is missing', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const fixture = await createAuthStackFixture({
    prefix: 'hstack-auth-runtime-port-',
    stackName: 'dev-auth',
    stackEnvLines: [
      'HAPPIER_STACK_STACK=dev-auth',
      'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
      'HAPPIER_STACK_TAILSCALE_SERVE=0',
    ],
  });
  try {
    const runtimeStatePath = join(fixture.storageDir, 'dev-auth', 'stack.runtime.json');
    await writeFile(
      runtimeStatePath,
      JSON.stringify({ version: 1, stackName: 'dev-auth', ownerPid: process.pid, ports: { server: 3010 } }) + '\n',
      'utf-8'
    );

    const res = await runNodeCapture(
      [hstackBinPath(rootDir), 'auth', 'login', '--print', '--no-open', '--json'],
      {
        cwd: rootDir,
        env: fixture.buildEnv({
          HAPPIER_SERVER_URL: '',
          HAPPIER_STACK_SERVER_PORT: '',
        }),
      }
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const parsed = JSON.parse(res.stdout.trim());

    assert.equal(parsed.stackName, 'dev-auth');
    assert.equal(parsed.internalServerUrl, 'http://127.0.0.1:3010');
    assert.equal(parsed.publicServerUrl, 'http://localhost:3010');
  } finally {
    await fixture.cleanup();
  }
});

