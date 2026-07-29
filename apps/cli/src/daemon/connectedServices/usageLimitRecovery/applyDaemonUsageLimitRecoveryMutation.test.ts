import { describe, expect, it } from 'vitest';

import { applyDaemonUsageLimitRecoveryMutation } from './applyDaemonUsageLimitRecoveryMutation';

function recovery(status: 'waiting' | 'cancelled', armedAtMs = 1) {
  return {
    v: 1,
    status,
    issueFingerprint: 'usage-limit:one',
    armedAtMs,
    resetAtMs: 2,
    nextCheckAtMs: status === 'cancelled' ? null : 2,
    attemptCount: 0,
    maxAttempts: 3,
    lastProbeError: null,
    resumePromptMode: 'standard',
    selectedAuth: { kind: 'native' },
  } as const;
}

describe('applyDaemonUsageLimitRecoveryMutation', () => {
  it('merges only the dedicated daemon usage-limit field', () => {
    expect(applyDaemonUsageLimitRecoveryMutation({ untouched: true }, {
      v: 1,
      sessionId: 'session-1',
      mutationId: 'mutation-1',
      fieldId: 'runtime.usageLimitRecovery',
      deliveryClass: 'durable_required',
      source: 'daemon',
      observedAt: 1,
      op: { kind: 'set', value: recovery('waiting') },
    })).toEqual({
      untouched: true,
      sessionUsageLimitRecoveryV1: recovery('waiting'),
    });
  });

  it('rejects a non-usage or non-daemon field before applying metadata', () => {
    const usage = {
      v: 1 as const,
      sessionId: 'session-1',
      mutationId: 'mutation-1',
      fieldId: 'runtime.usageLimitRecovery' as const,
      deliveryClass: 'durable_required' as const,
      source: 'runtime' as const,
      observedAt: 1,
      op: { kind: 'set' as const, value: recovery('waiting') },
    };

    expect(() => applyDaemonUsageLimitRecoveryMutation({}, usage as never))
      .toThrow('invalid_daemon_usage_limit_recovery_mutation');
  });
});
