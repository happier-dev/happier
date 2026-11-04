import test from 'node:test';
import assert from 'node:assert/strict';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { killPidOwnedByStack, killProcessGroupOwnedByStack } from './ownership.mjs';

for (const terminate of [killPidOwnedByStack, killProcessGroupOwnedByStack]) {
  for (const evidence of ['reused', 'previous-boot', 'absent', 'inconclusive']) {
    test(`${terminate.name} retires only proven recorded instances (${evidence})`, async t => {
      const pid = evidence === 'absent' ? 2147483647 : process.pid;
      const kill = process.kill.bind(process);
      t.mock.method(process, 'kill', (target, signal) => {
        assert.equal(signal, 0, 'retirement observation must never signal the unrelated process');
        if (evidence === 'inconclusive') throw Object.assign(new Error('access denied'), { code: 'EACCES' });
        return kill(target, signal);
      });
      const result = await terminate(pid, { stackName: 'retired-stack', json: true,
        processInstanceFingerprint: evidence === 'reused' ? 'previous-incarnation' : readProcessInstanceFingerprintSync(pid),
        recordedStartedAt: evidence === 'previous-boot' ? '2000-01-01T00:00:00.000Z' : null,
        ...(evidence === 'inconclusive' ? { readProcessInstanceFingerprintSyncImpl: () => null } : {}),
      });
      assert.equal(result.killed, evidence !== 'inconclusive');
      if (evidence !== 'inconclusive') assert.equal(result.reason, 'already_exited');
    });
  }
}

for (const terminate of [killPidOwnedByStack, killProcessGroupOwnedByStack]) {
  test(`${terminate.name} completes retirement when reuse is observed during admission`, async t => {
    const fingerprint = readProcessInstanceFingerprintSync(process.pid);
    assert.ok(fingerprint);
    const kill = process.kill.bind(process);
    t.mock.method(process, 'kill', (pid, signal) => {
      assert.equal(signal, 0, 'a process that replaced the recorded instance must never be signalled');
      return kill(pid, signal);
    });
    let reads = 0;
    const result = await terminate(process.pid, {
      json: true,
      processInstanceFingerprint: fingerprint,
      readProcessInstanceFingerprintSyncImpl: () => ++reads === 1 ? fingerprint : 'replacement-incarnation',
    });
    assert.equal(result.killed, true);
    assert.equal(result.reason, 'already_exited');
  });
}
