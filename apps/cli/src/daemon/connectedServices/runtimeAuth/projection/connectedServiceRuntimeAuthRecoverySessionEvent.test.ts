import { describe, expect, it, vi } from 'vitest';
import type { ConnectedServiceUxDiagnosticV1 } from '@happier-dev/protocol';

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
      genericMessageEmitted: false,
      requiresFallback: false,
      emitted: false,
    });
  });
});
