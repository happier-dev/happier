import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStressHostObserver } from './stress-host.mjs';

test('isolated stress observation uses real container identity and physical SQL totals; unknown daemon CPU stays unavailable', async () => {
  let calls = 37;
  const observer = await createStressHostObserver({
    context: { composeProjectName: 'happier-stress-perf-test', uiDir: '/export', containers: [{ id: 'owned-api', service: 'api', image: 'sha256:actual-image' }], postgresContainerId: 'owned-postgres' },
    inspect: async () => [{ Id: 'owned-api', Image: 'sha256:actual-image', Config: { Labels: { 'com.docker.compose.project': 'happier-stress-perf-test' } }, State: { Running: true } }],
    sqlStatements: async () => calls++,
  });
  const before = await observer.sample();
  const after = await observer.sample();
  assert.equal(before.identity.roles.server.loaded, 'sha256:actual-image');
  assert.equal(before.server.cpuSeconds, null);
  assert.equal(before.daemon, null);
  assert.equal(after.sqlStatements - before.sqlStatements, 1);
  assert.equal((await observer.stop()).status, 'CLOSED');
});

test('an isolated observer refuses foreign or stopped containers instead of certifying them', async () => {
  for (const [project, running] of [
    ['other-project', true],
    ['happier-stress-perf-test', false],
  ]) {
    await assert.rejects(createStressHostObserver({
      context: { composeProjectName: 'happier-stress-perf-test', uiDir: '/export', containers: [{ id: 'owned-api', service: 'api', image: 'sha256:image' }], postgresContainerId: 'owned-postgres' },
      inspect: async () => [{ Id: 'owned-api', Image: 'sha256:image', Config: { Labels: { 'com.docker.compose.project': project } }, State: { Running: running } }],
      sqlStatements: async () => 0,
    }), /ownership/);
  }
});

test('a replaced image cannot masquerade as the source selected before the measurement', async () => {
  await assert.rejects(createStressHostObserver({
    context: { composeProjectName: 'happier-stress-perf-test', uiDir: '/export', containers: [{ id: 'owned-api', image: 'sha256:selected' }], postgresContainerId: 'owned-postgres' },
    inspect: async () => [{ Id: 'owned-api', Image: 'sha256:different', Config: { Labels: { 'com.docker.compose.project': 'happier-stress-perf-test' } }, State: { Running: true } }],
    sqlStatements: async () => 0,
  }), /identity/);
});

test('an unavailable informational SQL counter is explicit, never invented zero', async () => {
  let unavailable = true, reads = 0;
  const observer = await createStressHostObserver({
    context: { composeProjectName: 'happier-stress-perf-test', uiDir: '/export', containers: [{ id: 'owned-api', image: 'sha256:image' }], postgresContainerId: 'owned-postgres' },
    inspect: async () => [{ Id: 'owned-api', Image: 'sha256:image', Config: { Labels: { 'com.docker.compose.project': 'happier-stress-perf-test' } }, State: { Running: true } }],
    sqlStatements: async () => {
      reads++;
      if (unavailable) throw new Error('counter unavailable; private SQL diagnostic');
      return { calls: 0, statsReset: 'stable', dealloc: 0 };
    },
  });
  assert.equal(observer.readiness.initial.sqlStatements, null);
  const failed = await observer.sample();
  assert.equal(failed.sqlStatements, null);
  assert.equal(failed.sqlStatistics, null);
  assert.match(failed.unavailable.join(' '), /SQL/);
  assert.ok(!JSON.stringify(failed).includes('private SQL diagnostic'));
  unavailable = false;
  const recovered = await observer.sample();
  assert.equal(recovered.sqlStatements, 0, 'a successful zero remains distinct from unavailable');
  assert.deepEqual(recovered.sqlStatistics, { statsReset: 'stable', dealloc: 0 });
  assert.ok(!recovered.unavailable.some(reason => /SQL/.test(reason)));
  assert.equal(reads, 3, 'one SQL probe per initial/requested sample; no failure retry or stale-cache substitution');
  await observer.stop();
});
