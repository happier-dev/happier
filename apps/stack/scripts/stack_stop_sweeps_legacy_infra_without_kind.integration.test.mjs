import test from 'node:test';
import assert from 'node:assert/strict';
import { isAlive, setupStackStopSweepFixture, spawnOwnedSleep, waitForProcessExit } from './testkit/stack_stop_sweeps_testkit.mjs';

test('hstack stack stop sweeps legacy infra without HAPPIER_STACK_PROCESS_KIND=infra', async (t) => {
  const fixture = await setupStackStopSweepFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'hstack-stack-stop-sweep-legacy-',
  });
  const legacyInfra = fixture.trackChild(spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      // Simulate a yarn/npm-managed infra process from older stacks (no kind tag).
      npm_lifecycle_event: 'dev:light',
      npm_package_name: '@happier-dev/server',
    },
  }));
  assert.ok(Number(legacyInfra.pid) > 1, 'expected legacy infra pid');
  assert.ok(isAlive(legacyInfra.pid), 'expected legacy infra child to be alive');

  const sessionLike = fixture.trackChild(spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      // Deliberately no npm_lifecycle_event and no process kind tag.
    },
  }));
  assert.ok(Number(sessionLike.pid) > 1, 'expected session-like child pid');
  assert.ok(isAlive(sessionLike.pid), 'expected session-like child to be alive');

  const res = await fixture.runStackStop(['--json']);
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.equal(res.signal, null, `expected process to exit normally, got signal ${res.signal}`);

  await waitForProcessExit({ pid: legacyInfra.pid, timeoutMs: 10_000, intervalMs: 50, label: 'legacy infra process' });
  assert.ok(!isAlive(legacyInfra.pid), `expected legacy infra pid ${legacyInfra.pid} to be stopped`);
  assert.ok(isAlive(sessionLike.pid), `expected session-like pid ${sessionLike.pid} to still be alive`);
});
