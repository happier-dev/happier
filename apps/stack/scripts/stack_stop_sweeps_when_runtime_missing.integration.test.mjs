import test from 'node:test';
import assert from 'node:assert/strict';
import { isAlive, setupStackStopSweepFixture, spawnOwnedSleep, waitForProcessExit } from './testkit/stack_stop_sweeps_testkit.mjs';

test('hstack stack stop sweeps owned processes when stack.runtime.json is missing', async (t) => {
  const fixture = await setupStackStopSweepFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'hstack-stack-stop-sweep-',
  });

  const owned = fixture.trackChild(spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_PROCESS_KIND: 'infra',
    },
  }));
  assert.ok(Number(owned.pid) > 1, 'expected child pid');
  assert.ok(isAlive(owned.pid), 'expected owned child to be alive');

  const sessionLike = fixture.trackChild(spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_PROCESS_KIND: 'session',
    },
  }));
  assert.ok(Number(sessionLike.pid) > 1, 'expected session-like child pid');
  assert.ok(isAlive(sessionLike.pid), 'expected session-like child to be alive');

  const res = await fixture.runStackStop(['--json']);
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  await waitForProcessExit({ pid: owned.pid, timeoutMs: 10_000, intervalMs: 50, label: 'infra process' });
  assert.ok(!isAlive(owned.pid), `expected owned pid ${owned.pid} to be stopped`);
  assert.ok(isAlive(sessionLike.pid), `expected session-like pid ${sessionLike.pid} to still be alive`);
});
