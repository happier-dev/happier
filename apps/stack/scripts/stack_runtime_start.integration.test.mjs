import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import {
  createStartableRuntimeSnapshotFixture,
  runNode,
  waitForHealth,
} from './testkit/runtime_snapshot_start_testkit.mjs';

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

test('hstack stack start --runtime --background launches the active runtime snapshot', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createStartableRuntimeSnapshotFixture(t, { stackName: 'runtime-prod', serverPort: 4315 });

  const env = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
  };

  const startRes = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'start', fixture.stackName, '--background', '--runtime', '--no-browser'],
    { cwd: rootDir, env },
  );
  assert.equal(startRes.code, 0, `stdout:\n${startRes.stdout}\nstderr:\n${startRes.stderr}`);

  try {
    await waitForHealth(fixture.baseUrl, { timeoutMs: 30_000 });
    const indexRes = await fetch(fixture.baseUrl);
    const indexHtml = await indexRes.text();
    assert.equal(indexRes.status, 200);
    assert.match(indexHtml, /RUNTIME SNAPSHOT UI/);

    const runtimeState = JSON.parse(await readFile(join(fixture.stackDir, 'stack.runtime.json'), 'utf8'));
    assert.equal(runtimeState.runtimeSnapshotId, 'snap-startable');

    const serverRuntimeEnv = JSON.parse(await readFile(fixture.serverEnvCapturePath, 'utf8'));
    assert.equal(serverRuntimeEnv.HAPPIER_SQLITE_AUTO_MIGRATE, '1');
    assert.equal(
      serverRuntimeEnv.HAPPIER_SQLITE_MIGRATIONS_DIR,
      join(fixture.stackDir, 'runtime', 'current', 'server', 'prisma', 'sqlite', 'migrations'),
    );
    assert.equal(
      serverRuntimeEnv.DATABASE_URL,
      `file:${join(fixture.stackDir, 'server-light', 'happier-server-light.sqlite')}`,
    );
    assert.equal(serverRuntimeEnv.HAPPIER_SERVER_LIGHT_DATA_DIR, join(fixture.stackDir, 'server-light'));

    const daemonStatusRes = await runNode(
      [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'daemon', fixture.stackName, 'status', '--json'],
      { cwd: rootDir, env },
    );
    assert.equal(daemonStatusRes.code, 0, `stdout:\n${daemonStatusRes.stdout}\nstderr:\n${daemonStatusRes.stderr}`);
    let daemonStatus = JSON.parse(daemonStatusRes.stdout.trim());
    const startedAt = Date.now();
    while (!/running/i.test(String(daemonStatus?.status ?? '')) && Date.now() - startedAt < 10_000) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const nextStatusRes = await runNode(
        [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'daemon', fixture.stackName, 'status', '--json'],
        { cwd: rootDir, env },
      );
      assert.equal(nextStatusRes.code, 0, `stdout:\n${nextStatusRes.stdout}\nstderr:\n${nextStatusRes.stderr}`);
      daemonStatus = JSON.parse(nextStatusRes.stdout.trim());
    }
    assert.match(String(daemonStatus?.status ?? ''), /running/i);
  } finally {
    await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'stop', fixture.stackName, '--yes'], {
      cwd: rootDir,
      env,
    });
  }
});
