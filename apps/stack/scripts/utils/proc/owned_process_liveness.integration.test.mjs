import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { spawnDetachedTestProcess } from '../../testkit/core/spawn_test_process.mjs';
import { killProcessGroupOwnedByStack } from './ownership.mjs';

test('inconclusive liveness refuses termination even when the recorded fingerprint and Stack markers match', async t => {
  const child = spawnDetachedTestProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: { ...process.env, HAPPIER_STACK_STACK: 'inconclusive-retirement',
      HAPPIER_STACK_ENV_FILE: '/inconclusive-retirement/env', HAPPIER_STACK_PROCESS_KIND: 'infra' },
  });
  await once(child, 'spawn');
  t.after(async () => {
    t.mock.restoreAll();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  });
  const fingerprint = readProcessInstanceFingerprintSync(child.pid);
  assert.ok(fingerprint);
  const signals = [];
  const kill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid, signal) => {
    if (Math.abs(pid) !== child.pid) return kill(pid, signal);
    if (signal !== 0) signals.push(signal);
    // Keep the group probe conclusive: a later group check must not erase
    // the earlier inconclusive observation of the recorded leader.
    if (pid < 0 && signal === 0) return kill(pid, signal);
    throw Object.assign(new Error('OS observation unavailable'), { code: 'EIO' });
  });
  const result = await killProcessGroupOwnedByStack(child.pid, {
    stackName: 'inconclusive-retirement', envPath: '/inconclusive-retirement/env',
    processInstanceFingerprint: fingerprint, json: true,
  });
  assert.equal(result.killed, false);
  assert.deepEqual(signals, [], 'unknown liveness must refuse before attempting a signal');
});
