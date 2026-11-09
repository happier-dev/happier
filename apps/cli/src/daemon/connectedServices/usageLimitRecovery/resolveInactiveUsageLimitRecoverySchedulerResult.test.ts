import { describe, expect, it } from 'vitest';
import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY } from '@happier-dev/protocol';

import { resolveInactiveUsageLimitRecoverySchedulerResult } from './resolveInactiveUsageLimitRecoverySchedulerResult';

const metadata = {
  [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
    v: 1 as const,
    status: 'waiting' as const,
    issueFingerprint: 'limit',
    armedAtMs: 1_000,
    resetAtMs: 2_000,
    nextCheckAtMs: 2_000,
    attemptCount: 0,
    maxAttempts: 3,
    lastProbeError: null,
    resumePromptMode: 'standard' as const,
    selectedAuth: {
      kind: 'profile' as const,
      serviceId: 'happier.agent.codex/openai-codex' as const,
      profileId: 'work',
    },
  },
};

describe('resolveInactiveUsageLimitRecoverySchedulerResult', () => {
  it('retains an untimed admitted wait without scheduling an invented reset', () => {
    expect(resolveInactiveUsageLimitRecoverySchedulerResult({
      result: { ok: true, status: 'waiting', metadata: {
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: { ...metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY],
          resetAtMs: null, nextCheckAtMs: null },
      } },
    })).toEqual({ status: 'wait', nextCheckAtMs: null, lastProbeError: null,
      selectedAuth: metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY].selectedAuth });
  });

  it('keeps waiting after a transport cancellation without a terminal acknowledgement', () => {
    expect(resolveInactiveUsageLimitRecoverySchedulerResult({
      result: { ok: false, status: 'cancelled', errorCode: 'rpc_cancelled' },
    })).toEqual({ status: 'wait', nextCheckAtMs: null,
      lastProbeError: 'usage_limit_recovery_probe_not_ready' });
  });

  it('settles an acknowledged successful cancellation', () => {
    expect(resolveInactiveUsageLimitRecoverySchedulerResult({
      result: { ok: true, status: 'cancelled' },
    })).toEqual({ status: 'superseded', lastProbeError: null });
  });

  it('retains canonical cancellation metadata when the transport result is unsuccessful', () => {
    expect(resolveInactiveUsageLimitRecoverySchedulerResult({
      result: { ok: false, status: 'cancelled', errorCode: 'rpc_cancelled', metadata: {
        ...metadata,
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
          ...metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY], status: 'cancelled',
        },
      } },
    })).toEqual({ status: 'superseded', lastProbeError: null });
  });

  it('preserves explicit exhaustion when no recovery metadata accompanies it', () => {
    expect(resolveInactiveUsageLimitRecoverySchedulerResult({
      result: { ok: false, status: 'exhausted' },
    })).toEqual({ status: 'exhausted', lastProbeError: null });
  });

  it('settles a stale cancelled result even when it carries no recovery metadata', () => {
    expect(resolveInactiveUsageLimitRecoverySchedulerResult({
      result: { ok: false, status: 'cancelled', errorCode: 'usage_limit_recovery_attempt_superseded', sessionId: 'session-1' },
    })).toMatchObject({ status: 'superseded' });
  });

  it('keeps provider-ready startup reconstruction passive', () => {
    expect(resolveInactiveUsageLimitRecoverySchedulerResult({
      result: { ok: true, status: 'ready', metadata },
    })).toEqual({
      status: 'pause',
      selectedAuth: metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY].selectedAuth,
    });
  });

  it('settles a same-daemon resume as effectfully completed', () => {
    expect(resolveInactiveUsageLimitRecoverySchedulerResult({
      result: { ok: true, status: 'resumed', metadata },
    })).toEqual({
      status: 'resumed',
      selectedAuth: metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY].selectedAuth,
    });
  });
});
