import { describe, expect, it, vi } from 'vitest';
import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY } from '@happier-dev/protocol';

import {
  buildRuntimeAuthRecoveryScheduledResult,
  normalizeConnectedServiceRuntimeAuthRecoveryProjection,
} from './connectedServiceRuntimeAuthRecoveryProjection';
import {
  projectConnectedServiceRuntimeAuthRecoveryReport,
} from './connectedServiceRuntimeAuthRecoverySessionEvent';
import type { ConnectedServiceRuntimeFailureClassification } from '../types';

const classification = {
  kind: 'usage_limit',
  serviceId: 'openai-codex',
  profileId: 'primary',
  groupId: 'team-pool',
  resetsAtMs: null,
  planType: null,
  rateLimits: null,
  source: 'stable_provider_message',
} satisfies ConnectedServiceRuntimeFailureClassification;

describe('connected service runtime auth recovery projection', () => {
  it('builds a typed retry-scheduled transcript event with runtime-auth diagnostics', () => {
    const result = buildRuntimeAuthRecoveryScheduledResult({
      classification,
      recovery: {
        status: 'scheduled',
        retryable: true,
        attemptCount: 2,
        maxAttempts: 3,
        nextRetryAtMs: 1234,
      },
    });

    expect(result.uxDiagnostic.source).toBe('runtime_auth_recovery');
    expect(result.uxDiagnostic.failurePhase).toBe('runtime_auth_recovery');
    expect(result.transcriptEvent).toEqual(expect.objectContaining({
      type: 'connected-service-runtime-auth-recovery',
      status: 'retry_scheduled',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team-pool',
      attempt: 2,
      nextRetryAtMs: 1234,
      terminal: false,
      diagnostic: result.uxDiagnostic,
    }));
  });

  it('normalizes daemon reports without dropping uxDiagnostic or transcriptEvent', () => {
    const scheduled = buildRuntimeAuthRecoveryScheduledResult({
      classification,
      recovery: {
        status: 'scheduled',
        retryable: true,
        attemptCount: 1,
        maxAttempts: 3,
        nextRetryAtMs: 4567,
      },
    });

    const projection = normalizeConnectedServiceRuntimeAuthRecoveryProjection({
      report: {
        ok: true,
        result: scheduled,
      },
      statusNote: {
        code: 'recovery_retry_scheduled',
        message: 'retry scheduled',
      },
    });

    expect(projection.handled).toBe(true);
    expect(projection.statusCode).toBe('recovery_retry_scheduled');
    expect(projection.statusMessage).toBe('retry scheduled');
    expect(projection.uxDiagnostic).toEqual(scheduled.uxDiagnostic);
    expect(projection.transcriptEvent).toEqual(scheduled.transcriptEvent);
    expect(projection.nextRetryAtMs).toBe(4567);
    expect(projection.terminal).toBe(false);
  });

  it('rejects malformed typed runtime-auth transcript events before projecting them', () => {
    const projection = normalizeConnectedServiceRuntimeAuthRecoveryProjection({
      report: {
        ok: true,
        result: {
          status: 'recovery_retry_scheduled',
          transcriptEvent: {
            type: 'connected-service-runtime-auth-recovery',
            status: 'retry_scheduled',
            serviceId: 'openai-codex',
          },
        },
      },
      statusNote: null,
    });

    expect(projection.handled).toBe(false);
    expect(projection.transcriptEvent).toBeUndefined();
  });

  it('keeps daemon-handled typed transcript events out of provider-side projection commits', () => {
    const scheduled = buildRuntimeAuthRecoveryScheduledResult({
      classification,
      recovery: {
        status: 'scheduled',
        retryable: true,
        attemptCount: 1,
        maxAttempts: 3,
        nextRetryAtMs: 4567,
      },
    });
    const projection = normalizeConnectedServiceRuntimeAuthRecoveryProjection({
      report: { ok: true, result: scheduled },
      statusNote: {
        code: 'recovery_retry_scheduled',
        message: 'retry scheduled',
      },
    });
    const commitTypedProjection = vi.fn();
    const sendGenericStatusMessage = vi.fn();
    const addStatusMessage = vi.fn();

    const result = projectConnectedServiceRuntimeAuthRecoveryReport({
      report: {
        handled: true,
        report: { ok: true, result: scheduled },
        statusCode: 'recovery_retry_scheduled',
        statusMessage: 'retry scheduled',
        uxDiagnostic: scheduled.uxDiagnostic,
        projection,
      },
      addStatusMessage,
      sendGenericStatusMessage,
      commitTypedProjection,
    });

    expect(result.statusMessageAdded).toBe(true);
    expect(result.typedProjectionCommitted).toBe(false);
    expect(result.genericMessageEmitted).toBe(false);
    expect(addStatusMessage).toHaveBeenCalledWith('retry scheduled');
    expect(commitTypedProjection).not.toHaveBeenCalled();
    expect(sendGenericStatusMessage).not.toHaveBeenCalled();
  });

  it('commits provider-side ux diagnostics when the daemon report has no transcript event', () => {
    const scheduled = buildRuntimeAuthRecoveryScheduledResult({
      classification,
      recovery: {
        status: 'scheduled',
        retryable: true,
        attemptCount: 1,
        maxAttempts: 3,
        nextRetryAtMs: 4567,
      },
    });
    const resultWithoutTranscriptEvent = {
      status: scheduled.status,
      recovery: scheduled.recovery,
      uxDiagnostic: scheduled.uxDiagnostic,
    };
    const projection = normalizeConnectedServiceRuntimeAuthRecoveryProjection({
      report: { ok: true, result: resultWithoutTranscriptEvent },
      statusNote: {
        code: 'recovery_retry_scheduled',
        message: 'retry scheduled',
      },
    });
    const commitTypedProjection = vi.fn();
    const sendGenericStatusMessage = vi.fn();

    const result = projectConnectedServiceRuntimeAuthRecoveryReport({
      report: {
        handled: true,
        report: { ok: true, result: resultWithoutTranscriptEvent },
        statusCode: 'recovery_retry_scheduled',
        statusMessage: 'retry scheduled',
        uxDiagnostic: scheduled.uxDiagnostic,
        projection,
      },
      sendGenericStatusMessage,
      commitTypedProjection,
    });

    expect(result.typedProjectionCommitted).toBe(true);
    expect(result.genericMessageEmitted).toBe(false);
    expect(commitTypedProjection).toHaveBeenCalledWith(projection);
    expect(sendGenericStatusMessage).not.toHaveBeenCalled();
  });

  it('emits generic fallback when typed projection cannot commit a visible event', () => {
    const scheduled = buildRuntimeAuthRecoveryScheduledResult({
      classification,
      recovery: {
        status: 'scheduled',
        retryable: true,
        attemptCount: 1,
        maxAttempts: 3,
        nextRetryAtMs: 4567,
      },
    });
    const resultWithoutTranscriptEvent = {
      status: scheduled.status,
      recovery: scheduled.recovery,
      uxDiagnostic: scheduled.uxDiagnostic,
    };
    const projection = normalizeConnectedServiceRuntimeAuthRecoveryProjection({
      report: { ok: true, result: resultWithoutTranscriptEvent },
      statusNote: {
        code: 'recovery_retry_scheduled',
        message: 'retry scheduled',
      },
    });
    const commitTypedProjection = vi.fn(() => false);
    const sendGenericStatusMessage = vi.fn();

    const result = projectConnectedServiceRuntimeAuthRecoveryReport({
      report: {
        handled: true,
        report: { ok: true, result: resultWithoutTranscriptEvent },
        statusCode: 'recovery_retry_scheduled',
        statusMessage: 'retry scheduled',
        uxDiagnostic: scheduled.uxDiagnostic,
        projection,
      },
      sendGenericStatusMessage,
      commitTypedProjection,
    });

    expect(projection.uxDiagnostic).toBeDefined();
    expect(projection.transcriptEvent).toBeUndefined();
    expect(result.typedProjectionCommitted).toBe(false);
    expect(result.genericMessageEmitted).toBe(true);
    expect(commitTypedProjection).toHaveBeenCalledWith(projection);
    expect(sendGenericStatusMessage).toHaveBeenCalledWith('retry scheduled');
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
    } as const;

    const result = projectConnectedServiceRuntimeAuthRecoveryReport({
      report: report as never,
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

  it('does not let a provider become a second metadata writer after the daemon handled recovery', () => {
    const commitUsageLimitRecoveryMetadata = vi.fn();
    const report = {
      handled: true,
      report: {
        ok: true,
        result: {
          status: 'switch_attempted',
          result: { status: 'no_eligible_member' },
        },
      },
      statusCode: 'switch_attempted_no_eligible_member',
      statusMessage: 'waiting for group recovery',
      projection: {
        handled: true,
        statusCode: 'switch_attempted_no_eligible_member',
        statusMessage: 'waiting for group recovery',
        terminal: true,
        transcriptEvent: {},
      },
    } as const;

    const result = projectConnectedServiceRuntimeAuthRecoveryReport({
      report: report as never,
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
      commitUsageLimitRecoveryMetadata,
    } as never);

    expect(commitUsageLimitRecoveryMetadata).not.toHaveBeenCalled();
    expect(result.usageLimitMetadataCommitted).toBe(false);
  });
});
