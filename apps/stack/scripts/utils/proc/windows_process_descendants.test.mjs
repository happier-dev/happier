import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

import { isPidAlive } from './pids.mjs';
import { observeWindowsProcessDescendants } from './windows_process_descendants.mjs';

const LEADER = 'win32-cim:2026-11-07T04:27:00.0000000Z';
const BEFORE_LEADER = '2026-11-07T04:00:00.0000000Z';
const AFTER_LEADER = '2026-11-07T04:27:05.0000000Z';
const LATER = '2026-11-07T04:27:09.0000000Z';

function observeRows(rows) {
  return observeWindowsProcessDescendants(100, {
    fingerprint: LEADER,
    runCaptureImpl: async () => JSON.stringify(rows),
  });
}

test('descendants are followed through the tree of the exited leader', async () => {
  const result = await observeRows([
    { pid: 200, parentPid: 100, creationDate: AFTER_LEADER },
    { pid: 300, parentPid: 200, creationDate: LATER },
    { pid: 400, parentPid: 999, creationDate: LATER },
  ]);

  assert.deepEqual(result, { status: 'present', pids: [200, 300] });
});

test('a process older than the leader only shares a stale parent PID, so it is not a descendant', async () => {
  const result = await observeRows([{ pid: 200, parentPid: 100, creationDate: BEFORE_LEADER }]);

  assert.deepEqual(result, { status: 'none' });
});

test('a process on the leader PID leaves the tree unproven', async () => {
  const result = await observeRows([{ pid: 100, parentPid: 4, creationDate: AFTER_LEADER }]);

  assert.equal(result.status, 'inconclusive');
});

test('unreadable tree evidence is inconclusive', async () => {
  const observations = [
    await observeRows([{ pid: 200, parentPid: 100 }]),
    await observeWindowsProcessDescendants(100, { fingerprint: LEADER, runCaptureImpl: async () => 'not json' }),
    await observeWindowsProcessDescendants(100, {
      fingerprint: LEADER,
      runCaptureImpl: async () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); },
    }),
    await observeWindowsProcessDescendants(100, { fingerprint: 'linux-proc:12', runCaptureImpl: async () => '[]' }),
  ];

  assert.deepEqual(observations.map((observation) => observation.status), Array(4).fill('inconclusive'));
});

test('the real process table shows a child that outlives its leader', { skip: process.platform !== 'win32' }, async (t) => {
  const leader = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    child.unref();
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  const [chunk] = await once(leader.stdout, 'data');
  const childPid = Number(String(chunk).trim());
  t.after(() => {
    try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
  });
  const fingerprint = readProcessInstanceFingerprintSync(leader.pid);
  assert.ok(fingerprint);

  leader.kill('SIGKILL');
  await once(leader, 'exit');
  assert.equal(isPidAlive(leader.pid), false);

  const surviving = await observeWindowsProcessDescendants(leader.pid, { fingerprint });
  assert.equal(surviving.status, 'present');
  assert.equal(surviving.pids.includes(childPid), true);

  process.kill(childPid, 'SIGKILL');
  while (isPidAlive(childPid)) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(await observeWindowsProcessDescendants(leader.pid, { fingerprint }), { status: 'none' });
});
