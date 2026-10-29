import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { setupStackStopSweepFixture, spawnOwnedSleep, isAlive } from './testkit/stack_stop_sweeps_testkit.mjs';
import { killDetachedProcessGroup } from './testkit/core/spawn_daemon_like_process.mjs';
import { createRuntimeSnapshotFixture } from './testkit/runtime_snapshot_testkit.mjs';
import { recordStackRuntimeStart } from './utils/stack/runtime_state.mjs';

test('metadata-only snapshot fixtures leave separately-owned test processes to their creating scope', async t => {
  let peer;
  t.after(() => {
    if (peer?.exitCode === null && peer.signalCode === null) killDetachedProcessGroup(peer.pid, 'SIGKILL');
  });
  await t.test('a reader fixture records a process it did not start', async scope => {
    const fixture = await createRuntimeSnapshotFixture(scope, { stackName: 'metadata-process-control' });
    peer = spawnOwnedSleep({ env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
      HAPPIER_STACK_CLI_HOME_DIR: join(fixture.stackDir, 'cli'),
      HAPPIER_STACK_PROCESS_KIND: 'server',
    } });
    await recordStackRuntimeStart(join(fixture.stackDir, 'stack.runtime.json'), {
      stackName: fixture.stackName, ownerPid: peer.pid, processes: { serverPid: peer.pid },
    });
    assert.equal(isAlive(peer.pid), true);
  });
  assert.equal(isAlive(peer.pid), true, 'recording a process for a reader does not transfer its teardown ownership');
});

test('native fixture teardown retires tracked infra and session controls while preserving an untracked peer', async t => {
  const children = [];
  const peer = spawnOwnedSleep({ env: process.env });
  t.after(() => {
    for (const child of [...children, peer]) {
      if (child.exitCode === null && child.signalCode === null) killDetachedProcessGroup(child.pid, 'SIGKILL');
    }
  });
  await t.test('the fixture owns both process kinds', async scope => {
    const fixture = await setupStackStopSweepFixture({ importMetaUrl: import.meta.url, t: scope });
    for (const kind of ['infra', 'session']) {
      children.push(fixture.trackChild(spawnOwnedSleep({ env: {
        ...fixture.baseEnv,
        HAPPIER_STACK_STACK: fixture.stackName,
        HAPPIER_STACK_ENV_FILE: fixture.envPath,
        HAPPIER_STACK_PROCESS_KIND: kind,
      } })));
    }
    assert.equal(children.filter(child => isAlive(child.pid)).length, 2, 'the control must start real children');
  });
  assert.equal(children.filter(child => isAlive(child.pid)).length, 0, 'no fixture-owned process may survive its native test scope');
  assert.equal(isAlive(peer.pid), true, 'teardown must preserve a process the fixture did not create');
});
