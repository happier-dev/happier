import { describe, expect, it } from 'vitest';

import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY } from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import type { ConnectedServiceRuntimeFailureClassification } from '../types';
import type { ConnectedServiceRuntimeAuthFailureDaemonReport } from '../reportConnectedServiceRuntimeAuthFailureToDaemon';
import { buildRuntimeAuthUsageLimitRecoveryMetadataUpdater } from './connectedServiceRuntimeAuthRecoveryUsageLimitMetadata';

// Boundary fixture: models raw server-side session metadata exactly as the
// updater receives it before any Zod parsing.
function asMetadata(value: Record<string, unknown>): Metadata {
  return value as unknown as Metadata;
}

const classification = {
  kind: 'usage_limit',
  serviceId: 'claude-subscription',
  profileId: 'pinned-profile',
  groupId: null,
  resetsAtMs: 1_700_000_060_000,
  retryAfterMs: null,
  planType: null,
  rateLimits: null,
  source: 'structured_provider_error',
} as ConnectedServiceRuntimeFailureClassification;

function buildActionRequiredReport(input: Readonly<{
  actionKind: string;
  reason: string;
}>): ConnectedServiceRuntimeAuthFailureDaemonReport {
  return {
    handled: true,
    report: {
      ok: true,
      result: {
        status: 'recovery_action_required',
        action: {
          kind: input.actionKind,
          serviceId: 'claude-subscription',
          profileId: 'pinned-profile',
          groupId: null,
          reason: input.reason,
        },
      },
    },
    statusCode: 'recovery_action_required',
    statusMessage: null,
    recoveryReceipt: {
      reportId: 'runtime-auth-report:action-required-1',
      attemptId: 'runtime-auth-attempt:action-required-1',
    },
  } as ConnectedServiceRuntimeAuthFailureDaemonReport;
}

function buildWaitingReport(
  resumePromptMode: unknown,
): ConnectedServiceRuntimeAuthFailureDaemonReport {
  return {
    handled: true,
    resumePromptMode,
    report: {
      ok: true,
      result: {
        status: 'recovery_retry_scheduled',
        recovery: {
          status: 'scheduled',
          attemptId: 'runtime-auth-attempt:exact-1',
          retryable: true,
          attemptCount: 1,
          maxAttempts: 3,
          nextRetryAtMs: 1_700_000_030_000,
        },
      },
    },
    statusCode: 'recovery_retry_scheduled',
    statusMessage: null,
  } as ConnectedServiceRuntimeAuthFailureDaemonReport;
}

function readWrittenResumePromptMode(metadata: Metadata): unknown {
  return (metadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]
    && ((metadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY] as Record<string, unknown>)
      .resumePromptMode;
}

describe('buildRuntimeAuthUsageLimitRecoveryMetadataUpdater non-group action-required projection (incident Jun-11 F-NEW-1)', () => {
  it('projects WAITING (not exhausted) for a non-group waitable limit with a known reset, mirroring the daemon durable wait', () => {
    // The daemon arms a durable wait until the reset for profile-pinned/native
    // limit failures; the session metadata must not contradict it by rendering
    // "exhausted / action required".
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: buildActionRequiredReport({ actionKind: 'profile_action_required', reason: 'usage_limit' }),
      classification,
      nowMs: () => 1_700_000_000_000,
    });
    expect(updater).not.toBeNull();

    const next = updater!(asMetadata({})) as Record<string, unknown>;
    expect(next[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]).toMatchObject({
      status: 'waiting',
      nextCheckAtMs: 1_700_000_060_000,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:action-required-1',
    });
  });

  it('keeps a non-waitable action kind (reconnect_profile) exhausted even with a known reset', () => {
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: buildActionRequiredReport({ actionKind: 'reconnect_profile', reason: 'usage_limit' }),
      classification,
    });
    expect(updater).not.toBeNull();

    const next = updater!(asMetadata({})) as Record<string, unknown>;
    expect(next[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]).toMatchObject({
      status: 'exhausted',
      lastProbeError: 'reconnect_profile',
    });
  });

  it('keeps non-group action-required exhausted when no reset is known', () => {
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: buildActionRequiredReport({ actionKind: 'profile_action_required', reason: 'usage_limit' }),
      classification: { ...classification, resetsAtMs: null },
    });
    expect(updater).not.toBeNull();

    const next = updater!(asMetadata({})) as Record<string, unknown>;
    expect(next[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]).toMatchObject({
      status: 'exhausted',
      lastProbeError: 'profile_action_required',
    });
  });
});

describe('buildRuntimeAuthUsageLimitRecoveryMetadataUpdater resume prompt mode projection', () => {
  it('projects the stable runtime-auth attempt identity used by exact cancellation', () => {
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: buildWaitingReport('standard'),
      classification,
    });

    const next = updater!(asMetadata({})) as Record<string, unknown>;
    expect(next[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]).toMatchObject({
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    });
  });

  it('uses the durable daemon report resume prompt mode', () => {
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: buildWaitingReport('custom'),
      classification,
    });
    expect(updater).not.toBeNull();

    const next = updater!(asMetadata({}));

    expect(readWrittenResumePromptMode(next)).toBe('custom');
  });

  it('fails malformed durable resume prompt mode closed to standard without consulting mutable settings', () => {
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: buildWaitingReport('later'),
      classification,
    });
    expect(updater).not.toBeNull();

    const next = updater!(asMetadata({}));

    expect(readWrittenResumePromptMode(next)).toBe('standard');
  });

  it('keeps the persisted report mode when account settings change before projection', () => {
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: buildWaitingReport('off'),
      classification,
    });

    const next = updater!(asMetadata({}));

    expect(readWrittenResumePromptMode(next)).toBe('off');
  });
});

describe('buildRuntimeAuthUsageLimitRecoveryMetadataUpdater policy-result projection', () => {
  function buildSwitchReport(result: Record<string, unknown>): ConnectedServiceRuntimeAuthFailureDaemonReport {
    return {
      handled: true,
      report: {
        ok: true,
        result: {
          status: 'switch_attempted',
          result,
        },
      },
      statusCode: 'switch_attempted',
      statusMessage: null,
    } as ConnectedServiceRuntimeAuthFailureDaemonReport;
  }

  const groupClassification = {
    ...classification,
    serviceId: 'openai-codex',
    profileId: 'primary',
    groupId: 'codex-main',
  } as ConnectedServiceRuntimeFailureClassification;

  it('projects a disabled-switch policy result as terminal instead of leaving a null waiting intent', () => {
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: buildSwitchReport({ status: 'auto_switch_disabled', generation: 4 }),
      classification: groupClassification,
      nowMs: () => 1_700_000_000_000,
    });

    expect(updater?.(asMetadata({}))).toMatchObject({
      sessionUsageLimitRecoveryV1: {
        status: 'exhausted',
        nextCheckAtMs: null,
        lastProbeError: 'auto_switch_disabled',
      },
    });
  });

  it('keeps timing-less group exhaustion waiting at the shared anti-storm floor', () => {
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: buildSwitchReport({
        status: 'no_eligible_member',
        generation: 4,
        groupExhausted: true,
        retryAtMs: null,
        excluded: [],
      }),
      classification: { ...groupClassification, resetsAtMs: null },
      nowMs: () => 1_700_000_000_000,
    });

    expect(updater?.(asMetadata({}))).toMatchObject({
      sessionUsageLimitRecoveryV1: {
        status: 'waiting',
        nextCheckAtMs: 1_700_000_030_000,
        lastProbeError: 'no_eligible_member',
      },
    });
  });
});
