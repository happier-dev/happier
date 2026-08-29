import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';

const baseDiagnostic = {
  code: 'recovery_retry_scheduled',
  failurePhase: 'runtime_auth_recovery',
  source: 'usage_limit_recovery',
  serviceId: 'openai-codex',
  profileId: 'backup',
  groupId: 'codex-main',
  retryable: true,
  suggestedActions: ['retry'],
  diagnostics: {
    attempt: 2,
    nextRetryAtMs: 1_900_000_000_000,
  },
} as const;

const normalizedDiagnostic = {
  ...baseDiagnostic,
  // The canonical owner upgrades legacy bare service ids to the qualified
  // Connected Account service key of the owning Agent.
  serviceId: 'happier.agent.codex/openai-codex',
} as const;

function normalize(value: unknown, options?: { sessionId?: string | null }) {
  const normalizer = (protocol as Record<string, unknown>).normalizeSessionUsageLimitRecoveryOperationResultV1;
  expect(typeof normalizer).toBe('function');
  return (normalizer as (input: unknown, options?: { sessionId?: string | null }) => unknown)(value, options);
}

describe('SessionUsageLimitRecoveryOperationResultV1', () => {
  it('exports a strict schema and normalizer from the public protocol barrel', () => {
    expect(typeof (protocol as Record<string, unknown>).SessionUsageLimitRecoveryOperationResultV1Schema).toBe('object');
    expect(typeof (protocol as Record<string, unknown>).normalizeSessionUsageLimitRecoveryOperationResultV1).toBe('function');
    expect(typeof (protocol as Record<string, unknown>).isSessionUsageLimitRecoveryOperationResultV1).toBe('function');
  });

  it('accepts canonical ready results with issue, retry, and diagnostic context', () => {
    const schema = (protocol as Record<string, { parse?: (value: unknown) => unknown }>).SessionUsageLimitRecoveryOperationResultV1Schema;
    expect(typeof schema?.parse).toBe('function');

    expect(schema.parse?.({
      ok: true,
      status: 'ready',
      sessionId: 'sess_123',
      issueFingerprint: 'usage-limit:sess_123:codex',
      retryAfterMs: 500.8,
      uxDiagnostic: baseDiagnostic,
      diagnostics: {
        source: 'unit',
        attempt: 1,
        retryable: true,
        empty: null,
      },
    })).toEqual({
      ok: true,
      status: 'ready',
      sessionId: 'sess_123',
      issueFingerprint: 'usage-limit:sess_123:codex',
      retryAfterMs: 500,
      uxDiagnostic: normalizedDiagnostic,
      diagnostics: {
        source: 'unit',
        attempt: 1,
        retryable: true,
        empty: null,
      },
    });
  });

  it('normalizes scheduled, not-ready, stale-machine, rate-limited, and auth-action errors', () => {
    expect(normalize({
      ok: true,
      status: 'recovery_retry_scheduled',
      retryAfterMs: 1_000.9,
    }, { sessionId: 'sess_123' })).toEqual({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_123',
      retryAfterMs: 1_000,
    });

    expect(normalize({
      ok: true,
      status: 'not_classified',
    }, { sessionId: 'sess_123' })).toEqual({
      ok: false,
      status: 'inactive',
      sessionId: 'sess_123',
      errorCode: 'session_usage_limit_recovery_inactive',
    });

    expect(normalize({
      ok: false,
      errorCode: 'session_usage_limit_recovery_control_stale_machine',
    }, { sessionId: 'sess_123' })).toEqual({
      ok: false,
      status: 'session_unreachable',
      sessionId: 'sess_123',
      errorCode: 'session_usage_limit_recovery_control_stale_machine',
    });

    expect(normalize({
      ok: false,
      error: 'probe_rate_limited',
      errorCode: 'probe_rate_limited',
      retryAfterMs: 300.2,
      uxDiagnostic: baseDiagnostic,
    }, { sessionId: 'sess_123' })).toEqual({
      ok: false,
      status: 'rate_limited',
      sessionId: 'sess_123',
      errorCode: 'probe_rate_limited',
      retryAfterMs: 300,
      uxDiagnostic: normalizedDiagnostic,
    });

    expect(normalize({
      ok: false,
      errorCode: 'not_authenticated',
    }, { sessionId: 'sess_123' })).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_123',
      errorCode: 'not_authenticated',
    });

    expect(normalize({
      ok: false,
      errorCode: 'execution_run_action_not_supported',
    }, { sessionId: 'sess_123' })).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_123',
      errorCode: 'execution_run_action_not_supported',
    });

    expect(normalize({
      ok: false,
      errorCode: 'invalid_parameters',
    }, { sessionId: 'sess_123' })).toEqual({
      ok: false,
      status: 'malformed_response',
      sessionId: 'sess_123',
      errorCode: 'invalid_parameters',
    });

    expect(normalize({
      ok: false,
      errorCode: 'RPC_METHOD_NOT_FOUND',
    }, { sessionId: 'sess_123' })).toEqual({
      ok: false,
      status: 'session_unreachable',
      sessionId: 'sess_123',
      errorCode: 'RPC_METHOD_NOT_FOUND',
    });
  });

  it('normalizes nested switch results without conflating observed and applied switches', () => {
    expect(normalize({
      ok: true,
      result: { status: 'switch_attempted', result: { status: 'switched' } },
    }, { sessionId: 'sess_123' })).toMatchObject({
      ok: true,
      status: 'switch_applied',
      sessionId: 'sess_123',
    });

    expect(normalize({
      ok: true,
      result: { status: 'switch_attempted', result: { status: 'observed_generation' } },
    }, { sessionId: 'sess_123' })).toMatchObject({
      ok: true,
      status: 'switch_observed',
      sessionId: 'sess_123',
    });
  });

  it('echoes the resume prompt mode on ok and error results', () => {
    expect(normalize({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_123',
      retryAfterMs: 123.9,
      issueFingerprint: 'usage-limit:sess_123:codex',
      resumePromptMode: 'off',
      uxDiagnostic: baseDiagnostic,
    })).toEqual({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_123',
      retryAfterMs: 123,
      issueFingerprint: 'usage-limit:sess_123:codex',
      resumePromptMode: 'off',
      uxDiagnostic: normalizedDiagnostic,
    });

    expect(normalize({
      status: 'recovery_retry_scheduled',
      sessionId: 'sess_123',
      resumePromptMode: 'standard',
    })).toEqual({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_123',
      resumePromptMode: 'standard',
    });

    expect(normalize({
      status: 'recovery_retry_scheduled',
      sessionId: 'sess_123',
      resumePromptMode: 'custom',
    })).toEqual({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_123',
      resumePromptMode: 'custom',
    });

    expect(normalize({
      ok: false,
      errorCode: 'session_usage_limit_recovery_rate_limited',
      resumePromptMode: 'off',
      retryAfterMs: 250,
    }, { sessionId: 'sess_123' })).toEqual({
      ok: false,
      status: 'rate_limited',
      sessionId: 'sess_123',
      errorCode: 'session_usage_limit_recovery_rate_limited',
      retryAfterMs: 250,
      resumePromptMode: 'off',
    });
  });

  it('fails closed when an ok result carries a malformed resume prompt mode', () => {
    expect(normalize({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_123',
      resumePromptMode: 'sometimes',
    })).toEqual({
      ok: false,
      status: 'malformed_response',
      sessionId: 'sess_123',
      errorCode: 'malformed_session_usage_limit_recovery_resume_prompt_mode',
    });
  });

  it('fails closed for malformed input, unknown statuses, and invalid diagnostics', () => {
    expect(normalize(null)).toEqual({
      ok: false,
      status: 'malformed_response',
      errorCode: 'malformed_session_usage_limit_recovery_operation_result',
    });

    expect(normalize({
      ok: true,
      status: 'new-daemon-token',
    }, { sessionId: 'sess_123' })).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_123',
      errorCode: 'unsupported_session_usage_limit_recovery_operation_result_status',
      diagnostics: { status: 'new-daemon-token' },
    });

    const schema = (protocol as Record<string, { safeParse?: (value: unknown) => { success: boolean } }>)
      .SessionUsageLimitRecoveryOperationResultV1Schema;
    expect(schema.safeParse?.({
      ok: false,
      status: 'unsupported',
      errorCode: 'unsupported',
      diagnostics: {
        nested: { unsafe: true },
      },
    }).success).toBe(false);
  });
});
