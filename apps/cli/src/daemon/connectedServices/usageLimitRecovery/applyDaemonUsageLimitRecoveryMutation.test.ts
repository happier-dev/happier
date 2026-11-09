import { describe, expect, it } from 'vitest';
import type { ConnectedServiceQuotaRecoveryCreditsV1 } from '@happier-dev/protocol';

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
  it('retains cancellation when an unbased older pending SET arrives', () => {
    const cancelled = recovery('cancelled');
    expect(applyDaemonUsageLimitRecoveryMutation({ sessionUsageLimitRecoveryV1: cancelled }, {
      v: 1, sessionId: 'session', mutationId: 'stale-set', fieldId: 'runtime.usageLimitRecovery',
      deliveryClass: 'durable_required', source: 'daemon', observedAt: 10,
      op: { kind: 'set', value: recovery('waiting') },
    })).toEqual({ sessionUsageLimitRecoveryV1: cancelled });
  });

  it('preserves reset credits on an updated runtime-auth wait, but not a new attempt', () => {
    const recoveryCredits = {
      availableCount: 1, totalCount: 1,
      source: 'provider_api', confidence: 'exact', credits: [],
    } satisfies ConnectedServiceQuotaRecoveryCreditsV1;
    const current = { sessionUsageLimitRecoveryV1: {
      ...recovery('waiting'), runtimeAuthRecoveryAttemptId: 'attempt', recoveryCredits,
    } };
    const apply = (attemptId: string, armedAtMs: number) => applyDaemonUsageLimitRecoveryMutation(current, {
      v: 1, sessionId: 'session', mutationId: 'projection', fieldId: 'runtime.usageLimitRecovery',
      deliveryClass: 'durable_required', source: 'daemon', observedAt: 10,
      op: { kind: 'set', value: {
        ...recovery('waiting', armedAtMs), runtimeAuthRecoveryAttemptId: attemptId, nextCheckAtMs: 31000,
      } },
    });
    expect(apply('attempt', 1)).toMatchObject({ sessionUsageLimitRecoveryV1: { recoveryCredits, nextCheckAtMs: 31000 } });
    expect(apply('replacement', 2).sessionUsageLimitRecoveryV1).not.toHaveProperty('recoveryCredits');
  });
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
