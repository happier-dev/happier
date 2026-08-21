import { describe, expect, it } from 'vitest';

import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY } from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import type { ConnectedServiceRuntimeFailureClassification } from '../types';
import type { ConnectedServiceRuntimeAuthFailureDaemonReport } from '../reportConnectedServiceRuntimeAuthFailureToDaemon';
import { buildRuntimeAuthUsageLimitRecoveryMetadataUpdater } from './connectedServiceRuntimeAuthRecoveryUsageLimitMetadata';

// Boundary fixture: models raw server-side session metadata (including
// pre-resumePromptMode legacy durable records) exactly as the updater
// receives it before any Zod parsing.
function asMetadata(value: Record<string, unknown>): Metadata {
  return value as unknown as Metadata;
}

const classification = {
  kind: 'usage_limit',
  serviceId: 'openai-codex',
  profileId: 'primary',
  groupId: 'codex-main',
  resetsAtMs: 1_700_000_060_000,
  retryAfterMs: null,
  planType: null,
  rateLimits: null,
  source: 'structured_provider_error',
} as ConnectedServiceRuntimeFailureClassification;

const waitingReport = {
  handled: true,
  report: {
    ok: true,
    result: {
      status: 'recovery_retry_scheduled',
    },
  },
  statusCode: 'recovery_retry_scheduled',
  statusMessage: 'Usage limit hit; recovery retry scheduled.',
  projection: {
    handled: true,
    statusCode: 'recovery_retry_scheduled',
    statusMessage: 'Usage limit hit; recovery retry scheduled.',
    terminal: false,
  },
} as ConnectedServiceRuntimeAuthFailureDaemonReport;

function readWrittenResumePromptMode(metadata: Record<string, unknown>): unknown {
  const intent = metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY] as Record<string, unknown>;
  return intent.resumePromptMode;
}

describe('buildRuntimeAuthUsageLimitRecoveryMetadataUpdater resume-prompt precedence (automatic path)', () => {
  it('projects the immutable runtime-auth attempt id into usage-limit metadata', () => {
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: {
        ...waitingReport,
        report: {
          ok: true,
          result: {
            status: 'recovery_retry_scheduled',
            recovery: { attemptId: 'runtime-auth-attempt:exact-1' },
          },
        },
      } as ConnectedServiceRuntimeAuthFailureDaemonReport,
      classification,
    });
    expect(updater?.(asMetadata({}))).toMatchObject({
      sessionUsageLimitRecoveryV1: {
        runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
      },
    });
  });

  it('uses safe standard for a legacy automatic report without a durable mode', () => {
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: waitingReport,
      classification,
    });
    expect(updater).not.toBeNull();

    const next = updater!(asMetadata({}));
    expect(readWrittenResumePromptMode(next as Record<string, unknown>)).toBe('standard');
  });

  it('uses explicit daemon report resumePromptMode over account settings for action-triggered recovery', () => {
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: {
        ...waitingReport,
        resumePromptMode: 'custom',
      },
      classification,
    });
    expect(updater).not.toBeNull();

    const next = updater!(asMetadata({}));
    expect(readWrittenResumePromptMode(next as Record<string, unknown>)).toBe('custom');
  });

  it('fails malformed durable resumePromptMode closed to standard', () => {
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: {
        ...waitingReport,
        resumePromptMode: 'later',
      } as unknown as ConnectedServiceRuntimeAuthFailureDaemonReport,
      classification,
    });
    expect(updater).not.toBeNull();

    const next = updater!(asMetadata({}));
    expect(readWrittenResumePromptMode(next as Record<string, unknown>)).toBe('standard');
  });

  it('treats a legacy stored intent without resumePromptMode as safe standard', () => {
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: waitingReport,
      classification,
    });

    const next = updater!(asMetadata({
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'usage-limit:openai-codex:group:codex-main:1700000060000:runtime-auth',
        armedAtMs: 1_700_000_000_000,
        resetAtMs: 1_700_000_060_000,
        nextCheckAtMs: 1_700_000_060_000,
        attemptCount: 1,
        maxAttempts: 3,
        lastProbeError: null,
        // no resumePromptMode field: pre-precedence durable record
        selectedAuth: {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'codex-main',
          profileId: 'primary',
        },
      },
    }));
    expect(readWrittenResumePromptMode(next as Record<string, unknown>)).toBe('standard');
  });

  it('does not reuse an older stored intent mode when the durable report is legacy', () => {
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: waitingReport,
      classification,
    });

    const next = updater!(asMetadata({
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'usage-limit:openai-codex:group:codex-main:1700000060000:runtime-auth',
        armedAtMs: 1_700_000_000_000,
        resetAtMs: 1_700_000_060_000,
        nextCheckAtMs: 1_700_000_060_000,
        attemptCount: 1,
        maxAttempts: 3,
        lastProbeError: null,
        resumePromptMode: 'off',
        selectedAuth: {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'codex-main',
          profileId: 'primary',
        },
      },
    }));
    expect(readWrittenResumePromptMode(next as Record<string, unknown>)).toBe('standard');
  });

  it('falls back to the provider default when every tier is silent', () => {
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: waitingReport,
      classification,
    });

    const next = updater!(asMetadata({}));
    expect(readWrittenResumePromptMode(next as Record<string, unknown>)).toBe('standard');
  });
});

describe('buildRuntimeAuthUsageLimitRecoveryMetadataUpdater non-group action-required projection (FIX-4)', () => {
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
            profileId: 'leeroy_batiplus',
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
        transition: 'working',
        eventLocalId: 'runtime-auth-recovery:action-required-1',
      },
      projection: {
        handled: true,
        statusCode: 'recovery_action_required',
        statusMessage: null,
        terminal: true,
      },
    } as ConnectedServiceRuntimeAuthFailureDaemonReport;
  }

  it('projects WAITING (not exhausted) for a non-group waitable limit with a known reset, mirroring the daemon durable wait', () => {
    // Incident Jun-11 F-NEW-1: the daemon arms a durable wait until the reset for
    // profile-pinned/native limit failures; the session metadata must not contradict it
    // by rendering "exhausted / action required".
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: buildActionRequiredReport({ actionKind: 'connected_service_required', reason: 'usage_limit' }),
      classification: { ...classification, groupId: null },
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
      report: buildActionRequiredReport({ actionKind: 'reconnect_profile', reason: 'auth_expired' }),
      classification: { ...classification, groupId: null },
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
      report: buildActionRequiredReport({ actionKind: 'connected_service_required', reason: 'usage_limit' }),
      classification: { ...classification, groupId: null, resetsAtMs: null },
    });
    expect(updater).not.toBeNull();

    const next = updater!(asMetadata({})) as Record<string, unknown>;
    expect(next[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]).toMatchObject({
      status: 'exhausted',
      lastProbeError: 'connected_service_required',
    });
  });
});

describe('buildRuntimeAuthUsageLimitRecoveryMetadataUpdater policy-result projection', () => {
  function buildSwitchReport(result: Record<string, unknown>): ConnectedServiceRuntimeAuthFailureDaemonReport {
    return {
      ...waitingReport,
      report: {
        ok: true,
        result: {
          status: 'switch_attempted',
          result,
        },
      },
    } as ConnectedServiceRuntimeAuthFailureDaemonReport;
  }

  it('projects a disabled-switch policy result as terminal instead of leaving a null waiting intent', () => {
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: buildSwitchReport({ status: 'auto_switch_disabled', generation: 4 }),
      classification,
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
      classification: { ...classification, resetsAtMs: null },
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

  it('keeps a classified non-group usage limit waiting until its known reset', () => {
    const updater = buildRuntimeAuthUsageLimitRecoveryMetadataUpdater({
      report: buildSwitchReport({ status: 'not_group_selection' }),
      classification: { ...classification, groupId: null },
      nowMs: () => 1_700_000_000_000,
    });

    expect(updater?.(asMetadata({}))).toMatchObject({
      sessionUsageLimitRecoveryV1: {
        status: 'waiting',
        nextCheckAtMs: 1_700_000_060_000,
        lastProbeError: 'awaiting_limit_reset',
      },
    });
  });
});
