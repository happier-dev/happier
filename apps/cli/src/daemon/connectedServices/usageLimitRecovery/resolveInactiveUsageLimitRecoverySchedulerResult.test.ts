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
      serviceId: 'openai-codex' as const,
      profileId: 'work',
    },
  },
};

describe('resolveInactiveUsageLimitRecoverySchedulerResult', () => {
  it('keeps recovery waiting when only the transport operation was cancelled', () => {
    expect(resolveInactiveUsageLimitRecoverySchedulerResult({
      result: { ok: false, status: 'cancelled', errorCode: 'rpc_cancelled' },
      nowMs: 5_000,
      fallbackRetryDelayMs: 60_000,
    })).toMatchObject({ status: 'wait', nextCheckAtMs: 65_000 });
  });

  it('settles a successful cancel acknowledgement without recovery metadata', () => {
    expect(resolveInactiveUsageLimitRecoverySchedulerResult({
      result: { ok: true, status: 'cancelled' },
      nowMs: 5_000,
      fallbackRetryDelayMs: 60_000,
    })).toMatchObject({ status: 'superseded' });
  });

  it('settles a canonical cancelled recovery even when the transport operation failed', () => {
    expect(resolveInactiveUsageLimitRecoverySchedulerResult({
      result: { ok: false, status: 'cancelled', errorCode: 'rpc_cancelled', metadata: {
        ...metadata,
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
          ...metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY], status: 'cancelled',
        },
      } },
      nowMs: 5_000,
      fallbackRetryDelayMs: 60_000,
    })).toMatchObject({ status: 'superseded' });
  });

  it('settles a stale cancelled result even when it carries no recovery metadata', () => {
    expect(resolveInactiveUsageLimitRecoverySchedulerResult({
      result: { ok: false, status: 'cancelled', errorCode: 'usage_limit_recovery_attempt_superseded', sessionId: 'session-1' },
      nowMs: 5_000,
      fallbackRetryDelayMs: 60_000,
    })).toMatchObject({ status: 'superseded' });
  });

  it('keeps provider-ready startup reconstruction passive', () => {
    expect(resolveInactiveUsageLimitRecoverySchedulerResult({
      result: { ok: true, status: 'ready', metadata },
      nowMs: 5_000,
      fallbackRetryDelayMs: 60_000,
    })).toEqual({
      status: 'pause',
      selectedAuth: metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY].selectedAuth,
    });
  });

  it('settles a same-daemon resume as effectfully completed', () => {
    expect(resolveInactiveUsageLimitRecoverySchedulerResult({
      result: { ok: true, status: 'resumed', metadata },
      nowMs: 5_000,
      fallbackRetryDelayMs: 60_000,
    })).toEqual({
      status: 'resumed',
      selectedAuth: metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY].selectedAuth,
    });
  });
});
