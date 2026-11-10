import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { buildNativeAdmissionFixtureEnv, installNativeAdmissionFixture } from './testkit/core/native_admission_fixture.mjs';
import { readAdmissionMemorySample } from './utils/proc/admission_broker.mjs';

const GiB = 1024 * 1024;

test('waiter credit excludes descendants, shared-page duplication and admitted trees', async () => {
  const sample = await readAdmissionMemorySample({
    slots: [{ pid: 10, floorKiB: 100 }],
    waiters: [{ pid: 11 }, { pid: 20 }, { pid: 20 }, { pid: 30 }],
    readProcesses: () => new Map([
      [10, { pid: 10, parentPid: 1, pssKiB: 10 }],
      [11, { pid: 11, parentPid: 10, pssKiB: 20 }],
      [20, { pid: 20, parentPid: 1, pssKiB: 40, rssKiB: 80 }],
      [21, { pid: 21, parentPid: 20, pssKiB: 200 }],
      [30, { pid: 30, parentPid: 1, pssKiB: null, rssKiB: 80 }],
    ]),
    readMemory: ({ waitingResidentMemoryKiB }) => ({ availableMemoryKiB: 100 + waitingResidentMemoryKiB, totalMemoryKiB: 1000 }),
  });
  assert.equal(sample.waitingResidentMemoryKiB, 40);
  assert.equal(sample.availableMemoryKiB, 140);
  assert.equal(sample.creditedResidentMemoryKiB, 30);
  assert.equal(sample.unreservedMemoryKiB, 70);
});

test('queued native clients do not reduce available memory or lose arrival order', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'waiter-memory-' });
  const native = await installNativeAdmissionFixture({ root: fixture.root, totalCpuCores: 1 });
  await native.setMemoryObservation({ availableMemoryKiB: 3 * GiB, totalMemoryKiB: 26 * GiB });
  const start = () => {
    const child = spawn('/bin/sh', [native.launcher, '--heavyweight-admission', '--class=validation',
      '--machine=fixture', '--', '/bin/sh', '-c', 'printf admitted; read release'],
    { env: buildNativeAdmissionFixtureEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const exited = new Promise(resolve => child.once('close', status => resolve(status)));
    t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; });
    return { child, exited, admitted: () => output === 'admitted', queued: () => errors.includes('waiting for admission') };
  };
  const until = async predicate => {
    for (let i = 0; i < 1000; i++) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('fixture admission condition did not settle');
  };
  const owner = start();
  await until(owner.admitted);
  const baseline = await native.brokerStatus();
  const queued = [];
  // OS-boundary pages reproduce the measured 70 MiB/client without allocating
  // GiB on the shared host. Launcher, client and broker remain real processes.
  for (let i = 0; i < 4; i++) {
    const client = start();
    queued.push(client);
    await until(client.queued);
  }
  await writeFile(native.observedPidsPath, JSON.stringify(queued.map(item => item.child.pid)));
  await writeFile(native.processMemoryKiBPath, JSON.stringify(Object.fromEntries(queued.map(item => [item.child.pid, 70 * 1024]))));
  await native.setMemoryObservation({ availableMemoryKiB: 3 * GiB - queued.length * 70 * 1024, totalMemoryKiB: 26 * GiB });
  // Wait for the broker's existing external-memory catch-up, not a new sampler.
  const previousSampleCount = (await native.brokerStatus()).sampleCount;
  await until(async () => (await native.brokerStatus()).sampleCount > previousSampleCount);
  const after = await native.brokerStatus();
  t.diagnostic(`queued clients=4, attributed pages=286720 KiB, available before=${baseline.availableMemoryKiB}, after=${after.availableMemoryKiB}`);
  assert.equal(after.availableMemoryKiB, baseline.availableMemoryKiB);
  assert.equal(after.waitingCount, 4);
  owner.child.stdin.end('release\n');
  assert.equal(await owner.exited, 0);
  for (let i = 0; i < queued.length; i++) {
    await until(queued[i].admitted);
    assert.ok(queued.slice(i + 1).every(item => !item.admitted()), 'arrival order is preserved');
    queued[i].child.stdin.end('release\n');
    assert.equal(await queued[i].exited, 0);
  }
});
