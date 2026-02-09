import test from 'node:test';
import assert from 'node:assert/strict';
import { isAlive, setupStackStopSweepFixture, spawnOwnedSleep, waitForProcessExit } from './testkit/stack_stop_sweeps_testkit.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test('hstack stack stop sweeps infra when stack.runtime.json exists but ownerPid is stale', async (t) => {
  const fixture = await setupStackStopSweepFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'hstack-stack-stop-sweep-stale-',
  });

  await writeFile(
    join(fixture.baseDir, 'stack.runtime.json'),
    JSON.stringify({ version: 1, stackName: fixture.stackName, ownerPid: 999999, processes: {} }),
    'utf-8'
  );

  const infra = fixture.trackChild(spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_PROCESS_KIND: 'infra',
    },
  }));
  assert.ok(Number(infra.pid) > 1, 'expected infra pid');
  assert.ok(isAlive(infra.pid), 'expected infra child to be alive');

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

  await waitForProcessExit({ pid: infra.pid, timeoutMs: 10_000, intervalMs: 50, label: 'infra process (stale runtime)' });
  assert.ok(!isAlive(infra.pid), `expected infra pid ${infra.pid} to be stopped`);
  assert.ok(isAlive(sessionLike.pid), `expected session-like pid ${sessionLike.pid} to still be alive`);
});
