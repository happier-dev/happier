import test from 'node:test';
import assert from 'node:assert/strict';

import { applyTuiExitPolicy, resolveTuiExitPolicy } from './exit_semantics.mjs';
import { isAlive, spawnOwnedSleep, waitForProcessAlive, waitForProcessExit } from '../../testkit/stack_stop_sweeps_testkit.mjs';

function terminateTestProcess(child) {
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 1 || !isAlive(pid)) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already exited
    }
  }
}

test('explicit TUI quit stops the owner while an unexpected terminal exit detaches from it', () => {
  assert.deepEqual(resolveTuiExitPolicy({ explicit: true }), {
    terminateChild: true,
    terminateTauri: true,
    stopRuntime: true,
  });
  assert.deepEqual(resolveTuiExitPolicy(), {
    terminateChild: false,
    terminateTauri: true,
    stopRuntime: false,
  });
});

test('unexpected TUI exit only tears down its Tauri boundary, while explicit exit reaches the owner stop boundary', async () => {
  const unexpectedEvents = [];
  await applyTuiExitPolicy({
    exitPolicy: resolveTuiExitPolicy(),
    terminateChildren: async () => unexpectedEvents.push('children'),
    terminateTauri: async () => unexpectedEvents.push('tauri'),
    stopRuntime: async () => unexpectedEvents.push('runtime'),
  });
  assert.deepEqual(unexpectedEvents, ['tauri']);

  const explicitEvents = [];
  await applyTuiExitPolicy({
    exitPolicy: resolveTuiExitPolicy({ explicit: true }),
    terminateChildren: async () => explicitEvents.push('children'),
    terminateTauri: async () => explicitEvents.push('tauri'),
    stopRuntime: async () => explicitEvents.push('runtime'),
  });
  assert.deepEqual(explicitEvents, ['children', 'tauri', 'runtime']);
});

test('unexpected TUI exit detaches from an isolated live owner while closing its Tauri process', async (t) => {
  const owner = spawnOwnedSleep({ env: process.env });
  const tauri = spawnOwnedSleep({ env: process.env });
  t.after(() => {
    terminateTestProcess(owner);
    terminateTestProcess(tauri);
  });
  await Promise.all([
    waitForProcessAlive({ pid: owner.pid, label: 'detached owner' }),
    waitForProcessAlive({ pid: tauri.pid, label: 'Tauri pane' }),
  ]);

  await applyTuiExitPolicy({
    exitPolicy: resolveTuiExitPolicy(),
    terminateChildren: async () => {
      throw new Error('unexpected TUI exit must not terminate the stack launch boundary');
    },
    terminateTauri: async () => {
      terminateTestProcess(tauri);
      await waitForProcessExit({ pid: tauri.pid, label: 'Tauri pane' });
    },
    stopRuntime: async () => {
      terminateTestProcess(owner);
    },
  });

  assert.equal(isAlive(owner.pid), true);
  assert.equal(isAlive(tauri.pid), false);
});
