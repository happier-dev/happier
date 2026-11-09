import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { createRuntimeSnapshotFixture } from './testkit/runtime_snapshot_testkit.mjs';
import { readStackInfoSnapshot } from './stack/stack_info_snapshot.mjs';

test('named stack sign-in discovery ignores another consumer of its retained Home identity', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'qa-home-origin' });
  const otherConsumer = 'https://laptop.example.test:8443';
  const homeIdentity = 'srv_shared_home';
  withPatchedProcessEnv(t, {
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_CANONICAL_SERVER_URL: otherConsumer,
    HAPPIER_PUBLIC_SERVER_URL: otherConsumer,
  });
  await writeFile(join(fixture.stackDir, 'env'), 'HAPPIER_STACK_SERVER_PORT=3101\n');
  const cliDir = join(fixture.stackDir, 'cli');
  await mkdir(cliDir, { recursive: true });
  const settingsPath = join(cliDir, 'settings.json');
  const retained = JSON.stringify({ activeServerId: homeIdentity, servers: {
    [homeIdentity]: { id: homeIdentity, serverUrl: otherConsumer,
      publicServerUrl: otherConsumer, serverIdentityId: homeIdentity },
  } });
  await writeFile(settingsPath, retained);
  const readInfo = () => readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName,
    observeRemoteSourceRuntime: false, synchronizeDaemonState: false });
  const local = await readInfo();
  assert.equal(local.urls.canonicalServerUrl, 'http://happier-qa-home-origin.localhost:3101');
  assert.equal(await readFile(settingsPath, 'utf8'), retained, 'discovery must leave retained Home state intact');

  // A deliberate stack-owned signing identity remains authoritative.
  await writeFile(join(fixture.stackDir, 'env'),
    'HAPPIER_STACK_SERVER_PORT=3101\nHAPPIER_CANONICAL_SERVER_URL=https://qa.example.test\n');
  const configured = await readInfo();
  assert.equal(configured.urls.canonicalServerUrl, 'https://qa.example.test');
});
