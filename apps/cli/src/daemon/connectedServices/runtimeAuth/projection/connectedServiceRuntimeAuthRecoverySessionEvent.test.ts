import { describe, expect, it, vi } from 'vitest';
import type { ConnectedServiceUxDiagnosticV1 } from '@happier-dev/protocol';
import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY } from '@happier-dev/protocol';

import type { ConnectedServiceRuntimeAuthFailureDaemonReport } from '../reportConnectedServiceRuntimeAuthFailureToDaemon';
import {
  connectedServiceRuntimeAuthRecoveryWillContinue,
  projectConnectedServiceRuntimeAuthRecoveryReport,
} from './connectedServiceRuntimeAuthRecoverySessionEvent';

const uxDiagnostic = {
  code: 'recovery_retry_scheduled',
  failurePhase: 'runtime_auth_recovery',
  source: 'runtime_auth_recovery',
  serviceId: 'openai-codex',
  profileId: 'primary',
  groupId: 'team-pool',
  retryable: true,
  suggestedActions: ['retry'],
  diagnostics: { runtimeFailureKind: 'usage_limit' },
} satisfies ConnectedServiceUxDiagnosticV1;

describe('projectConnectedServiceRuntimeAuthRecoveryReport', () => {
  it('identifies nonterminal retryable recovery that will continue after the turn failure settles', () => {
    const report = {
      handled: true,
      report: { ok: true },
      statusCode: 'recovery_retry_scheduled',
      statusMessage: 'Connected-service recovery hit a temporary provider failure; retry scheduled.',
      uxDiagnostic,
      projection: {
        handled: true,
        statusCode: 'recovery_retry_scheduled',
        statusMessage: 'Connected-service recovery hit a temporary provider failure; retry scheduled.',
        uxDiagnostic,
        terminal: false,
      },
    } satisfies ConnectedServiceRuntimeAuthFailureDaemonReport;

    expect(connectedServiceRuntimeAuthRecoveryWillContinue(report)).toBe(true);
  });

  it('does not identify terminal recovery as continuing', () => {
    const report = {
      handled: true,
      report: {
        ok: true,
        result: {
          status: 'recovery_action_required',
          action: {
            kind: 'reconnect_profile',
            profileId: 'primary',
          },
        },
      },
      statusCode: 'recovery_action_reconnect_profile',
      statusMessage: 'Connected-service profile needs reconnect before this session can continue.',
      projection: {
        handled: true,
        statusCode: 'recovery_action_reconnect_profile',
        statusMessage: 'Connected-service profile needs reconnect before this session can continue.',
        terminal: true,
      },
    } satisfies ConnectedServiceRuntimeAuthFailureDaemonReport;

    expect(connectedServiceRuntimeAuthRecoveryWillContinue(report)).toBe(false);
  });

  it('emits the generic fallback when typed projection commit does not surface a uxDiagnostic-only report', () => {
    const sendGenericStatusMessage = vi.fn();
    const commitTypedProjection = vi.fn(() => false);
    const report = {
      handled: true,
      report: { ok: true },
      statusCode: 'recovery_retry_scheduled',
      statusMessage: 'Connected-service recovery hit a temporary provider failure; retry scheduled.',
      uxDiagnostic,
      projection: {
        handled: true,
        statusCode: 'recovery_retry_scheduled',
        statusMessage: 'Connected-service recovery hit a temporary provider failure; retry scheduled.',
        uxDiagnostic,
        terminal: false,
      },
    } satisfies ConnectedServiceRuntimeAuthFailureDaemonReport;

    const result = projectConnectedServiceRuntimeAuthRecoveryReport({
      report,
      sendGenericStatusMessage,
      commitTypedProjection,
    });

    expect(commitTypedProjection).toHaveBeenCalledWith(report.projection);
    expect(sendGenericStatusMessage).toHaveBeenCalledWith(report.statusMessage);
    expect(result).toMatchObject({
      typedProjectionCommitted: false,
      genericMessageEmitted: true,
      requiresFallback: true,
      emitted: true,
    });
  });

  it('does not re-emit a daemon-handled typed transcript event from provider projection', () => {
    const sendGenericStatusMessage = vi.fn();
    const addStatusMessage = vi.fn(() => true);
    const commitTypedProjection = vi.fn(() => true);
    const transcriptEvent = {
      type: 'connected-service-runtime-auth-recovery',
      status: 'retry_scheduled',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team-pool',
      nextRetryAtMs: 1_700_000_100_000,
      terminal: false,
      diagnostic: uxDiagnostic,
    } as const;
    const report = {
      handled: true,
      report: { ok: true },
      statusCode: 'recovery_retry_scheduled',
      statusMessage: 'Connected-service recovery hit a temporary provider failure; retry scheduled.',
      projection: {
        handled: true,
        statusCode: 'recovery_retry_scheduled',
        statusMessage: 'Connected-service recovery hit a temporary provider failure; retry scheduled.',
        uxDiagnostic,
        transcriptEvent,
        terminal: false,
      },
    } satisfies ConnectedServiceRuntimeAuthFailureDaemonReport;

    const result = projectConnectedServiceRuntimeAuthRecoveryReport({
      report,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'team-pool',
        resetsAtMs: null,
        retryAfterMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
      addStatusMessage,
      sendGenericStatusMessage,
      commitTypedProjection,
    });

    expect(addStatusMessage).not.toHaveBeenCalled();
    expect(commitTypedProjection).not.toHaveBeenCalled();
    expect(sendGenericStatusMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      statusMessageAdded: false,
      typedProjectionCommitted: false,
      usageLimitMetadataCommitted: false,
      genericMessageEmitted: false,
      requiresFallback: false,
      emitted: false,
    });
  });

  it('commits exhausted usage-limit recovery metadata when a group fallback reports no eligible member', () => {
    let nextMetadata: Record<string, unknown> | null = null;
    const report = {
      handled: true,
      report: {
        ok: true,
        result: {
          status: 'switch_attempted',
          result: {
            status: 'no_eligible_member',
          },
        },
      },
      statusCode: 'switch_attempted_no_eligible_member',
      statusMessage: 'Connected-service account group has no eligible fallback account; waiting for group recovery.',
      projection: {
        handled: true,
        statusCode: 'switch_attempted_no_eligible_member',
        statusMessage: 'Connected-service account group has no eligible fallback account; waiting for group recovery.',
        terminal: true,
      },
    } satisfies ConnectedServiceRuntimeAuthFailureDaemonReport;

    const result = projectConnectedServiceRuntimeAuthRecoveryReport({
      report,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-main',
        resetsAtMs: 1_700_000_060_000,
        retryAfterMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
      commitUsageLimitRecoveryMetadata: ((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
        nextMetadata = updater({});
        return true;
      }) as never,
    } as never);

    expect(nextMetadata).toMatchObject({
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
        status: 'exhausted',
        resetAtMs: 1_700_000_060_000,
        lastProbeError: 'no_eligible_member',
        selectedAuth: {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'codex-main',
          profileId: 'primary',
        },
      },
    });
    expect(result).toMatchObject({
      usageLimitMetadataCommitted: true,
      emitted: true,
    });
  });

  it('commits waiting usage-limit recovery metadata for group-exhausted no eligible member with reset timing', () => {
    let nextMetadata: Record<string, unknown> | null = null;
    const report = {
      handled: true,
      report: {
        ok: true,
        result: {
          status: 'switch_attempted',
          result: {
            status: 'no_eligible_member',
            groupExhausted: true,
            retryAtMs: 1_700_000_060_000,
          },
        },
      },
      statusCode: 'switch_attempted_no_eligible_member',
      statusMessage: 'Connected-service account group has no eligible fallback account; waiting for group recovery.',
      projection: {
        handled: true,
        statusCode: 'switch_attempted_no_eligible_member',
        statusMessage: 'Connected-service account group has no eligible fallback account; waiting for group recovery.',
        terminal: false,
      },
    } satisfies ConnectedServiceRuntimeAuthFailureDaemonReport;

    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      projectConnectedServiceRuntimeAuthRecoveryReport({
        report,
        classification: {
          kind: 'usage_limit',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'codex-main',
          resetsAtMs: 1_700_000_060_000,
          retryAfterMs: null,
          planType: null,
          rateLimits: null,
          source: 'structured_provider_error',
        },
        commitUsageLimitRecoveryMetadata: ((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
          nextMetadata = updater({});
          return true;
        }) as never,
      } as never);
    } finally {
      dateNow.mockRestore();
    }

    expect(nextMetadata).toMatchObject({
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
        status: 'waiting',
        resetAtMs: 1_700_000_060_000,
        nextCheckAtMs: 1_700_000_060_000,
        lastProbeError: 'no_eligible_member',
      },
    });
  });

  it('commits usage-limit recovery metadata when the session metadata starts empty', () => {
    let nextMetadata: Record<string, unknown> | null = null;
    const report = {
      handled: true,
      report: {
        ok: true,
        result: {
          status: 'switch_attempted',
          result: {
            status: 'no_eligible_member',
          },
        },
      },
      statusCode: 'switch_attempted_no_eligible_member',
      statusMessage: 'Connected-service account group has no eligible fallback account; waiting for group recovery.',
      projection: {
        handled: true,
        statusCode: 'switch_attempted_no_eligible_member',
        statusMessage: 'Connected-service account group has no eligible fallback account; waiting for group recovery.',
        terminal: true,
      },
    } satisfies ConnectedServiceRuntimeAuthFailureDaemonReport;

    projectConnectedServiceRuntimeAuthRecoveryReport({
      report,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-main',
        resetsAtMs: 1_700_000_060_000,
        retryAfterMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
      commitUsageLimitRecoveryMetadata: ((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
        nextMetadata = updater(null as never);
        return true;
      }) as never,
    } as never);

    expect(nextMetadata).toMatchObject({
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
        status: 'exhausted',
        lastProbeError: 'no_eligible_member',
      },
    });
  });

  it('does not let a provider become a second metadata writer after the daemon handled recovery', () => {
    const commitUsageLimitRecoveryMetadata = vi.fn();
    const report = {
      handled: true,
      report: { ok: true, result: { status: 'switch_attempted', result: { status: 'no_eligible_member' } } },
      statusCode: 'switch_attempted_no_eligible_member',
      statusMessage: 'Waiting for recovery.',
      projection: {
        handled: true,
        statusCode: 'switch_attempted_no_eligible_member',
        statusMessage: 'Waiting for recovery.',
        terminal: false,
        transcriptEvent: {} as never,
      },
    } as unknown as ConnectedServiceRuntimeAuthFailureDaemonReport;

    const result = projectConnectedServiceRuntimeAuthRecoveryReport({
      report,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-main',
        resetsAtMs: null,
        retryAfterMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
      commitUsageLimitRecoveryMetadata,
    });

    expect(commitUsageLimitRecoveryMetadata).not.toHaveBeenCalled();
    expect(result.usageLimitMetadataCommitted).toBe(false);
  });
});
