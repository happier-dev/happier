import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';

import { createTempFixture } from './temp_fixture.mjs';
import { prepareRuntimeSnapshotFixtureLifetime } from './runtime_snapshot_lifetime.mjs';
import { stopRuntimeSnapshotFixture } from './runtime_snapshot_cleanup.mjs';
import { killDetachedProcessGroup, spawnDaemonLikeProcess } from './spawn_daemon_like_process.mjs';
import { removeDirForce } from '../../utils/test/test_cleanup.mjs';

test('started snapshot fixture cleanup retains its directory when its configuration disappears', async t => {
  const stackName = 'missing-config-fixture';
  const fixture = await createTempFixture(null, {
    beforeCleanup: root => stopRuntimeSnapshotFixture({ root, stackName }),
  });
  const stackDir = fixture.path('storage', stackName);
  const envPath = join(stackDir, 'env');
  await prepareRuntimeSnapshotFixtureLifetime(stackDir);
  await writeFile(envPath, '');
  const child = spawnDaemonLikeProcess({
    cliHomeDir: join(stackDir, 'cli'),
    statePaths: [join(stackDir, 'cli', 'daemon.state.json')],
    env: { HAPPIER_STACK_STACK: stackName, HAPPIER_STACK_ENV_FILE: envPath },
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      killDetachedProcessGroup(child.pid, 'SIGKILL');
      await exited;
    }
    await removeDirForce(fixture.root);
  });
  await rm(envPath);
  await assert.rejects(fixture.cleanup(), { code: 'ESTACKFIXTURECLEANUPINCOMPLETE' });
  await access(fixture.root);
});

test('fixture cleanup retains evidence when its resource teardown fails and permits retry', async t => {
  let resourceRunning = true;
  const fixture = await createTempFixture(null, {
    beforeCleanup: async root => {
      if (resourceRunning) {
        assert.equal(await readFile(`${root}/owner`, 'utf8'), 'fixture owner');
        throw Object.assign(new Error('resource is still running'), { code: 'ECLEANUPINCOMPLETE' });
      }
    },
  });
  t.after(async () => {
    resourceRunning = false;
    await fixture.cleanup();
  });
  await writeFile(fixture.path('owner'), 'fixture owner');
  await assert.rejects(fixture.cleanup(), { code: 'ECLEANUPINCOMPLETE' });
  assert.equal(await readFile(fixture.path('owner'), 'utf8'), 'fixture owner');
  resourceRunning = false;
  await fixture.cleanup();
  await assert.rejects(readFile(fixture.path('owner')), { code: 'ENOENT' });
});
