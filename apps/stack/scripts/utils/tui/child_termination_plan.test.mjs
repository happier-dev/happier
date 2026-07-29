import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTuiChildTerminationPlan } from './child_termination_plan.mjs';
import { killProcessGroupOwnedByStack } from '../proc/ownership.mjs';

test('resolveTuiChildTerminationPlan returns none for invalid child pid', () => {
  assert.deepEqual(resolveTuiChildTerminationPlan({ childPid: 0, childPgid: 0, selfPgid: 0 }), { strategy: 'none', target: null });
  assert.deepEqual(resolveTuiChildTerminationPlan({ childPid: null }), { strategy: 'none', target: null });
});

test('resolveTuiChildTerminationPlan delegates a detached child to the ownership owner', () => {
  assert.deepEqual(
    resolveTuiChildTerminationPlan({
      childPid: 123,
      childPgid: 456,
      selfPgid: 999,
      processInstanceFingerprint: 'producer-recorded',
    }),
    {
      strategy: 'owned',
      target: 123,
      processInstanceFingerprint: 'producer-recorded',
    },
  );
});

test('resolveTuiChildTerminationPlan keeps the producer identity when the child shares the caller pgid', () => {
  assert.deepEqual(
    resolveTuiChildTerminationPlan({
      childPid: 123,
      childPgid: 777,
      selfPgid: 777,
      processInstanceFingerprint: 'producer-recorded',
    }),
    {
      strategy: 'owned',
      target: 123,
      processInstanceFingerprint: 'producer-recorded',
    },
  );
});

test('resolveTuiChildTerminationPlan carries missing identity to the fail-closed ownership owner', () => {
  assert.deepEqual(
    resolveTuiChildTerminationPlan({ childPid: 123, childPgid: null, selfPgid: 777 }),
    {
      strategy: 'owned',
      target: 123,
      processInstanceFingerprint: null,
    },
  );
});

test('TUI producer identity makes the Windows owner refuse a same-pid successor', async () => {
  const plan = resolveTuiChildTerminationPlan({
    childPid: 123,
    processInstanceFingerprint: 'win32-cim:recorded-child',
  });
  let terminationCalls = 0;
  const result = await killProcessGroupOwnedByStack(plan.target, {
    platform: 'win32',
    processInstanceFingerprint: plan.processInstanceFingerprint,
    readProcessInstanceFingerprintSyncImpl: () => 'win32-cim:successor',
    observePidLivenessImpl: () => ({ status: 'alive' }),
    terminateProcessGroupImpl: async () => {
      terminationCalls += 1;
      return { ok: true };
    },
  });

  assert.deepEqual(result, { killed: false, reason: 'process_instance_changed' });
  assert.equal(terminationCalls, 0);
});
