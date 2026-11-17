import { describe, expect, it } from 'vitest';

import { buildOpenCodeProviderErrorIssue, projectOpenCodeTurnCancellationCause } from './openCodeRuntimeEvents.js';

describe('projectOpenCodeTurnCancellationCause', () => {
  it.each([true, false])('retains the native APIError retryability decision (%s)', (retryable) => {
    const issue = buildOpenCodeProviderErrorIssue({ code: 'opencode_provider_error', occurredAt: 1,
      error: { name: 'APIError', data: { statusCode: 503, isRetryable: retryable,
        responseBody: JSON.stringify({ error: { code: 'overloaded_error' } }),
      } },
    });
    expect(issue.failureCause).toMatchObject({ httpStatus: 503, providerErrorCode: 'overloaded_error', retryable });
  });

  it.each(['invalid_api_key', 'invalid_request_error'])('projects OpenAI code %s without HTTP status', (code) => {
    const issue = buildOpenCodeProviderErrorIssue({ code: 'opencode_provider_error', occurredAt: 1,
      error: { name: 'APIError', data: { responseBody: JSON.stringify({ error: {
        code, type: 'invalid_request_error', message: 'Request rejected',
      } }) } } });
    expect(issue).toMatchObject(code === 'invalid_api_key'
      ? { source: 'auth_error', failureCause: { failureReason: 'authentication_required', providerErrorCode: code } }
      : { source: 'agent_session_error', failureCause: { failureReason: 'unknown', providerErrorCode: code } });
    expect(issue.failureCause).not.toHaveProperty('retryable');
  });

  it('decodes the Google SDK nested HTTP 400 body through the shared owner', () => {
    const body = { error: { code: 400, status: 'Bad Request', message: JSON.stringify({ error: {
      code: 400, status: 'INVALID_ARGUMENT', message: '[REDACTED]', details: [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
      ],
    } }) } };
    expect(buildOpenCodeProviderErrorIssue({ code: 'opencode_provider_error', occurredAt: 1,
      error: { name: 'APIError', data: { statusCode: 400, responseBody: JSON.stringify(body) } },
    })).toMatchObject({ source: 'auth_error', failureCause: {
      phase: 'authentication', failureReason: 'authentication_required', providerErrorCode: 'API_KEY_INVALID', httpStatus: 400,
    } });
  });
  it.each([401, 403])('CC6 already projects a code-less HTTP %s through the shared owner', (status) => {
    expect(buildOpenCodeProviderErrorIssue({ code: 'opencode_provider_error', occurredAt: 1,
      error: { name: 'APIError', data: { statusCode: status } } })).toMatchObject({
      source: 'auth_error', failureCause: { failureReason: 'authentication_required', httpStatus: status },
    });
  });
  it.each([
    ['host_shutdown', 'hostShutdown'],
    ['session_dispose', 'sessionDispose'],
    ['runtime_recovery', 'runtimeRecovery'],
    ['user', 'user'],
    ['cancelled', 'providerCancelled'],
    [undefined, 'providerCancelled'],
  ] as const)('maps %s to the canonical Agent cancellation cause', (reason, expected) => {
    expect(projectOpenCodeTurnCancellationCause(reason)).toBe(expected);
  });
});
