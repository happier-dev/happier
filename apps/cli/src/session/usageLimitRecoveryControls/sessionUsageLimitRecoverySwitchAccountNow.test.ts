import { describe, expect, it, vi } from 'vitest';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

import { routeSessionUsageLimitRecoverySwitchAccountNow } from './sessionUsageLimitRecoverySwitchAccountNow';

function createUsageLimitIssue(
  patch: Partial<SessionRuntimeIssueV1> = {},
): SessionRuntimeIssueV1 {
  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'usage_limit',
    source: 'usage_limit',
    occurredAt: 1_000,
    agentId: 'codex',
    usageLimit: {
      v: 1,
      resetAtMs: 10_000,
      retryAfterMs: null,
      quotaScope: 'account',
      recoverability: 'switch_account',
      connectedService: {
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'happier',
      },
    },
    ...patch,
  };
}

function createRawSession(issue: SessionRuntimeIssueV1 | null): RawSessionRecord {
  return {
    id: 'session-1',
    lastRuntimeIssue: issue,
  } as unknown as RawSessionRecord;
}

describe('routeSessionUsageLimitRecoverySwitchAccountNow', () => {
  it('replays the latest switchable usage-limit issue through runtime auth recovery', async () => {
    const notifyRuntimeAuthFailure = vi.fn(async () => ({
      handled: true,
      report: {
        ok: true,
        result: {
          status: 'switch_attempted',
          result: { status: 'switched' },
        },
      },
      statusCode: 'switch_attempted_switched',
      statusMessage: 'Connected-service account switched; restarting session.',
      uxDiagnostic: {
        code: 'recovery_retry_scheduled',
        failurePhase: 'runtime_auth_recovery',
        source: 'runtime_auth_recovery',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'happier',
        retryable: true,
      },
    }));

    const result = await routeSessionUsageLimitRecoverySwitchAccountNow({
      sessionId: 'session-1',
      rawSession: createRawSession(createUsageLimitIssue()),
      request: { sessionId: 'session-1', provider: 'codex', resumePromptMode: 'custom' },
      notifyRuntimeAuthFailure,
    });

    expect(result).toEqual({
      ok: true,
      status: 'switch_applied',
      sessionId: 'session-1',
      uxDiagnostic: expect.objectContaining({
        source: 'runtime_auth_recovery',
        serviceId: 'openai-codex',
      }),
    });
    expect(notifyRuntimeAuthFailure).toHaveBeenCalledWith({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: expect.objectContaining({
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'happier',
        resetsAtMs: 10_000,
      }),
      resumePromptMode: 'custom',
    });
  });

  it('maps no eligible group member to exhausted', async () => {
    const notifyRuntimeAuthFailure = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: { status: 'no_eligible_member' },
      },
    }));

    const result = await routeSessionUsageLimitRecoverySwitchAccountNow({
      sessionId: 'session-1',
      rawSession: createRawSession(createUsageLimitIssue()),
      notifyRuntimeAuthFailure,
    });

    expect(result).toEqual({
      ok: false,
      status: 'exhausted',
      sessionId: 'session-1',
      errorCode: 'session_usage_limit_recovery_control_no_eligible_member',
    });
  });

  it('preserves diagnostics from failed runtime auth recovery envelopes', async () => {
    const uxDiagnostic = {
      code: 'provider_session_state_unavailable_for_resume',
      failurePhase: 'continuity',
      source: 'usage_limit_recovery',
      serviceId: 'openai-codex',
      retryable: false,
      suggestedActions: ['resume_current_account'],
    };
    const notifyRuntimeAuthFailure = vi.fn(async () => ({
      handled: true,
      report: {
        ok: false,
        errorCode: 'provider_session_state_unavailable_for_resume',
        uxDiagnostic,
      },
      statusCode: 'provider_session_state_unavailable_for_resume',
      statusMessage: 'Provider session state is unavailable.',
      uxDiagnostic,
    }));

    const result = await routeSessionUsageLimitRecoverySwitchAccountNow({
      sessionId: 'session-1',
      rawSession: createRawSession(createUsageLimitIssue()),
      notifyRuntimeAuthFailure,
    });

    expect(result).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'session-1',
      errorCode: 'provider_session_state_unavailable_for_resume',
      uxDiagnostic,
    });
  });

  it('preserves diagnostics when runtime auth recovery requires a user action', async () => {
    const uxDiagnostic = {
      code: 'provider_session_state_unavailable_for_resume',
      failurePhase: 'continuity',
      source: 'usage_limit_recovery',
      serviceId: 'openai-codex',
      retryable: false,
      suggestedActions: ['start_fresh_under_selected_account', 'resume_current_account'],
    };
    const notifyRuntimeAuthFailure = vi.fn(async () => ({
      handled: true,
      report: {
        ok: true,
        result: {
          status: 'recovery_action_required',
          uxDiagnostic,
        },
      },
      statusCode: 'recovery_action_required',
      statusMessage: 'Recovery requires a user action.',
      uxDiagnostic,
    }));

    const result = await routeSessionUsageLimitRecoverySwitchAccountNow({
      sessionId: 'session-1',
      rawSession: createRawSession(createUsageLimitIssue()),
      notifyRuntimeAuthFailure,
    });

    expect(result).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'session-1',
      errorCode: 'session_usage_limit_recovery_control_switch_unavailable',
      uxDiagnostic,
    });
  });

  it('fails closed when runtime auth recovery returns a malformed success envelope', async () => {
    const notifyRuntimeAuthFailure = vi.fn(async () => ({
      handled: true,
      report: {
        ok: true,
        result: null,
      },
      statusCode: 'malformed',
      statusMessage: 'Malformed recovery result.',
    }));

    const result = await routeSessionUsageLimitRecoverySwitchAccountNow({
      sessionId: 'session-1',
      rawSession: createRawSession(createUsageLimitIssue()),
      notifyRuntimeAuthFailure,
    });

    expect(result).toEqual({
      ok: false,
      status: 'malformed_response',
      sessionId: 'session-1',
      errorCode: 'session_usage_limit_recovery_control_switch_failed',
    });
  });

  it('maps nested switch-attempt apply failures to failed while preserving diagnostics', async () => {
    const uxDiagnostic = {
      code: 'post_switch_verification_failed',
      failurePhase: 'post_switch_verification',
      source: 'usage_limit_recovery',
      serviceId: 'openai-codex',
      retryable: true,
      suggestedActions: ['retry'],
    };
    const notifyRuntimeAuthFailure = vi.fn(async () => ({
      handled: true,
      report: {
        ok: true,
        result: {
          status: 'switch_attempted',
          result: {
            status: 'generation_apply_failed',
            uxDiagnostic,
          },
        },
      },
      statusCode: 'switch_attempted_generation_apply_failed',
      statusMessage: 'Generation apply failed.',
      uxDiagnostic,
    }));

    const result = await routeSessionUsageLimitRecoverySwitchAccountNow({
      sessionId: 'session-1',
      rawSession: createRawSession(createUsageLimitIssue()),
      notifyRuntimeAuthFailure,
    });

    expect(result).toEqual({
      ok: false,
      status: 'generation_apply_failed',
      sessionId: 'session-1',
      errorCode: 'session_usage_limit_recovery_control_switch_failed',
      uxDiagnostic,
    });
  });

  it('rejects provider mismatches before notifying runtime auth recovery', async () => {
    const notifyRuntimeAuthFailure = vi.fn(async () => ({
      ok: true,
      result: { status: 'switch_attempted', result: { status: 'switched' } },
    }));

    const result = await routeSessionUsageLimitRecoverySwitchAccountNow({
      sessionId: 'session-1',
      rawSession: createRawSession(createUsageLimitIssue()),
      request: { sessionId: 'session-1', provider: 'claude' },
      notifyRuntimeAuthFailure,
    });

    expect(result).toEqual({
      ok: false,
      status: 'group_conflict',
      sessionId: 'session-1',
      errorCode: 'session_usage_limit_recovery_control_issue_mismatch',
    });
    expect(notifyRuntimeAuthFailure).not.toHaveBeenCalled();
  });

  it('rejects usage-limit issues without connected-service group switch context', async () => {
    const notifyRuntimeAuthFailure = vi.fn(async () => ({
      ok: true,
      result: { status: 'switch_attempted', result: { status: 'switched' } },
    }));

    const result = await routeSessionUsageLimitRecoverySwitchAccountNow({
      sessionId: 'session-1',
      rawSession: createRawSession(createUsageLimitIssue({
        usageLimit: {
          v: 1,
          resetAtMs: 10_000,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      })),
      notifyRuntimeAuthFailure,
    });

    expect(result).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'session-1',
      errorCode: 'session_usage_limit_recovery_control_switch_unavailable',
    });
    expect(notifyRuntimeAuthFailure).not.toHaveBeenCalled();
  });
});
