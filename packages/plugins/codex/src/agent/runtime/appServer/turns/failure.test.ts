import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createJsonRpcApplicationError } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import { sanitizeSessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { SessionSpawnLaunchErrorV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnLaunchErrorV1';

import {
  createCodexAppServerTurnFailure,
  formatCodexAppServerErrorForUi,
  isCodexAppServerContextWindowExhaustedError,
  isCodexAppServerTemporaryRecoverableTurnFailureError,
  readCodexAppServerTurnFailureDiagnostic,
  readCodexAppServerFailureCause,
  readCodexAppServerRuntimeIssueSource,
} from './failure.js';

describe('createCodexAppServerTurnFailure', () => {
  it.each(['usageLimitExceeded', 'usageLimitReached', 'insufficient_quota'])(
    'retains structured %s exhaustion and explicit provider timing',
    (code) => {
      const failure = createCodexAppServerTurnFailure({
        value: { turn: { error: {
          code,
          message: 'Request failed',
          resetsAtMs: 1_799_999_999_000,
          retryAfterMs: 90_000,
        } } },
        authContext: { profileId: 'exhausted-member', groupId: 'pool' },
      });
      expect(readCodexAppServerTurnFailureDiagnostic(failure)).toMatchObject({
        failureReason: 'usage_limit',
      });
      expect(failure).toMatchObject({ runtimeAuthClassification: {
        kind: 'usage_limit', limitCategory: 'usage_limit',
        resetsAtMs: 1_799_999_999_000, retryAfterMs: 90_000,
      } });
    },
  );

  it.each([
    new Error('Required authoritative session snapshot refresh failed for session-fixture'),
    Object.assign(new Error('Agent isolation is unavailable.'), { code: 'agent_isolation_unavailable' }),
  ])('keeps the captured J6 startup failures outside quota recovery: %s', (error) => {
    const failure = createCodexAppServerTurnFailure({ value: error, phase: 'client_start' });
    expect(readCodexAppServerTurnFailureDiagnostic(failure).failureReason).toBe('unclassified_provider_error');
    expect(failure).toMatchObject({ runtimeAuthClassification: null });
  });

  it('keeps retryability and vendor request identity on a classified usage failure', () => {
    const failure = createCodexAppServerTurnFailure({ value: { turn: { error: {
      codexErrorInfo: 'UsageLimitExceeded', message: 'Usage limit reached', requestId: 'req-quota-fixture',
    } } } });
    expect(readCodexAppServerFailureCause(failure)).toMatchObject({
      failureReason: 'usage_limit', retryable: false, requestId: 'req-quota-fixture',
    });
  });

  it('retains the redacted native turn error when Codex supplies only Other', () => {
    const failure = createCodexAppServerTurnFailure({ providerConnectionId: 'pc_team_fixture', value: {
      turn: { error: { message: 'stream disconnected before completion: error sending request; Bearer private-turn-token', codexErrorInfo: 'other' } },
    } });
    const issue = sanitizeSessionRuntimeIssueV1({
      v: 1, scope: 'primary_session', status: 'failed', occurredAt: 1,
      code: 'codex_app_server_turn_failed', source: 'agent_session_error', agentId: 'codex',
      failureCause: readCodexAppServerFailureCause(failure),
    });
    expect(issue).toMatchObject({ failureCause: {
      providerErrorCode: 'Other',
      providerErrorMessage: 'stream disconnected before completion: error sending request; Bearer [REDACTED]',
    } });
    expect(readCodexAppServerTurnFailureDiagnostic(failure).failureReason).toBe('unclassified_provider_error');
    expect(JSON.stringify(issue)).not.toContain('private-turn-token');
  });

  it('retains a native HTTP refusal without a provider connection binding', () => {
    const failure = createCodexAppServerTurnFailure({ value: { turn: { error: {
      message: 'exceeded retry limit, last status: 429 Too Many Requests; Bearer private-turn-token',
      codexErrorInfo: { response_too_many_failed_attempts: { http_status_code: 429 } },
    } } } });
    expect(readCodexAppServerFailureCause(failure)).toMatchObject({
      httpStatus: 429,
      providerErrorMessage: 'exceeded retry limit, last status: 429 Too Many Requests; Bearer [REDACTED]',
    });
    expect(JSON.stringify(failure)).not.toContain('private-turn-token');
  });

  it('retains a redacted native process preview with a closed startup category', () => {
    const nativeError = Object.assign(new Error('PRIVATE_UNBOUNDED_MESSAGE'), {
      code: 'PLUGIN_EXEC_CLIENT_EXITED',
      stderrPreview: `CODEX_HOME does not exist; Bearer private-native-token; ${'x'.repeat(2_001)}`,
    });
    const failure = createCodexAppServerTurnFailure({ phase: 'client_start', value: nativeError });
    expect(failure).toMatchObject({ code: 'agent_startup_transport_failed', details: { failureCause: {
      phase: 'client_start', code: 'agent_startup_transport_failed',
      providerErrorMessage: 'CODEX_HOME does not exist; Bearer [REDACTED]; '.padEnd(2_000, 'x'),
    } } });
    expect(JSON.stringify(failure)).not.toMatch(/PRIVATE_UNBOUNDED_MESSAGE|private-native-token/);
    expect(readCodexAppServerFailureCause(new Error('PRIVATE_NATIVE_MESSAGE'))).not.toHaveProperty('providerErrorMessage');
  });

  it('bounds retained provider text to the existing sanitized preview budget after redaction', () => {
    const rejection = createJsonRpcApplicationError({
      method: 'thread/start',
      code: -32603,
      message: `Bearer private-provider-token; ${'x'.repeat(2_001)}`,
    });
    const failure = createCodexAppServerTurnFailure({
      phase: 'thread_open', value: rejection,
    });
    for (const value of [rejection, failure]) {
      expect(readCodexAppServerFailureCause(value).providerErrorMessage)
        .toBe('Bearer [REDACTED]; '.padEnd(2_000, 'x'));
    }
  });

  it('retains redacted correlated provider messages through public runtime and launch failures', () => {
    const rejection = createJsonRpcApplicationError({
      method: 'thread/start',
      code: -32603,
      message: 'Thread creation failed: Bearer private-provider-token; api_key=private-api-key',
      data: { message: 'PRIVATE_RESPONSE_DATA', path: '/PRIVATE_NATIVE_PATH' },
    });
    const failure = createCodexAppServerTurnFailure({
      phase: 'thread_open',
      providerStartRejected: 'thread/start',
      value: rejection,
    });
    const failureCause = readCodexAppServerFailureCause(failure);
    expect(failureCause).toMatchObject({
      phase: 'thread_open',
      providerErrorCode: -32603,
      providerErrorMessage: expect.stringContaining('Thread creation failed:'),
    });
    expect(failureCause).toHaveProperty('providerErrorMessage', expect.stringContaining('[REDACTED]'));
    expect(readCodexAppServerFailureCause(rejection)).toHaveProperty('providerErrorMessage', failureCause.providerErrorMessage);
    const issue = sanitizeSessionRuntimeIssueV1({
      v: 1, scope: 'primary_session', status: 'failed', occurredAt: 1,
      code: 'agent_startup_rpc_rejected', source: 'agent_session_error', agentId: 'codex', failureCause,
    });
    const launch = SessionSpawnLaunchErrorV1Schema.parse({
      kind: 'launch_error', code: 'agent_startup_rpc_rejected', message: 'Codex startup failed', failureCause,
    });
    expect(issue).toMatchObject({ failureCause });
    expect(launch).toMatchObject({ failureCause });
    const serialized = JSON.stringify({ failure, issue, launch });
    for (const privateValue of ['private-provider-token', 'private-api-key', 'PRIVATE_RESPONSE_DATA', 'PRIVATE_NATIVE_PATH']) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(readCodexAppServerFailureCause(new Error('PRIVATE_NATIVE_MESSAGE'))).not.toHaveProperty('providerErrorMessage');
  });

  it('retains Provider transport retryability at the turn-start boundary', () => {
    const failure = createCodexAppServerTurnFailure({
      phase: 'turn_start',
      inputNotDispatched: true,
      providerConnectionId: 'pc_work',
      value: { error: { message: 'PRIVATE_SOCKET_CLOSED',
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: null } } } },
    });
    expect(failure).toMatchObject({ code: 'provider_endpoint_unreachable', retryable: true,
      inputNotDispatched: true, providerError: { connectionId: 'pc_work', action: 'retry' } });
    expect(readCodexAppServerFailureCause(failure)).toMatchObject({ retryable: true });
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_');
  });

  it('retains closed native transport facts and redacted startup prose without arbitrary system fields', () => {
    const failure = createCodexAppServerTurnFailure({
      phase: 'client_start',
      value: Object.assign(new Error('Native connect failed: api_key=PRIVATE_NATIVE_OUTPUT'), {
        code: 'ENOENT',
        syscall: 'connect',
        path: '/PRIVATE_SOCKET',
      }),
    });
    expect(failure).toMatchObject({
      code: 'agent_startup_transport_failed',
      startupFailure: {
        phase: 'native_system_error',
        reason: 'system_error',
        errnoCode: 'ENOENT',
        syscall: 'connect',
      },
    });
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_');
    expect(readCodexAppServerFailureCause(failure).providerErrorMessage)
      .toContain('Native connect failed:');
    expect(readCodexAppServerFailureCause(failure).providerErrorMessage).toContain('[REDACTED]');
    expect(
      createCodexAppServerTurnFailure({
        phase: 'client_start',
        value: new Error('Native launch failed: api_key=PRIVATE_UNCLASSIFIED'),
      }),
    ).toMatchObject({
      code: 'agent_startup_transport_failed',
      failureReason: 'unclassified_provider_error',
      details: { failureCause: { providerErrorMessage: expect.stringContaining('Native launch failed:') } },
    });
  });

  it('retains the primary typed cause when native cleanup aggregates failures', () => {
    const failure = createCodexAppServerTurnFailure({
      phase: 'client_start',
      value: new AggregateError([
        Object.assign(new Error('PRIVATE_PROVIDER'), {
          code: 'provider_secret_unavailable',
        }),
        new Error('PRIVATE_CLEANUP'),
      ]),
    });
    expect(failure).toMatchObject({
      code: 'provider_secret_unavailable',
      details: {
        failureCause: { phase: 'client_start' },
      },
    });
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_');
  });

  it.each([null, { profileId: 'connected-profile', groupId: null }])(
    'classifies a structured 401 with auth context %j without exposing credentials',
    (authContext) => {
      const failure = createCodexAppServerTurnFailure({
        authContext,
        value: {
          turn: {
            error: {
              message:
                'Missing authentication in header. Bearer PRIVATE_BODY',
              codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
            },
          },
        },
      });
      expect(readCodexAppServerTurnFailureDiagnostic(failure)).toMatchObject({
        failureReason: authContext ? 'auth_expired' : 'authentication_required',
        httpStatus: 401,
      });
      if (authContext) {
        expect(failure).not.toHaveProperty('code');
        expect(failure).toMatchObject({
          runtimeAuthClassification: {
            kind: 'auth_expired',
            profileId: 'connected-profile',
            limitCategory: 'auth_invalid',
          },
        });
      } else {
        expect(failure).toMatchObject({
          code: 'provider_endpoint_auth_required',
        });
      }
      expect(JSON.stringify(failure)).not.toContain('PRIVATE_');
    },
  );
  const flattenedModelNotFound = (message: string) => ({
    turn: {
      error: {
        codexErrorInfo: 'other',
        message: `HTTP 400: ${JSON.stringify({
          error: {
            type: 'invalid_request_error',
            code: 'model_not_found',
            param: null,
            message,
          },
        })}`,
      },
    },
  });
  it('retains a native flattened model_not_found code without classifying unrecognized upstream prose', () => {
    const failure = createCodexAppServerTurnFailure({
      value: flattenedModelNotFound(
        'Bearer PRIVATE_UPSTREAM_DETAIL; usage limit reached',
      ),
    });
    expect(failure).toMatchObject({ code: 'provider_model_not_found' });
    expect(
      readCodexAppServerTurnFailureDiagnostic(failure).providerErrorCode,
    ).toBe('model_not_found');
    expect(failure).toMatchObject({ runtimeAuthClassification: null });
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_');
  });

  it('keeps a flattened model_not_found account refusal as model-scoped pool evidence for the failing member', () => {
    const failure = createCodexAppServerTurnFailure({
      value: flattenedModelNotFound(
        "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
      ),
      authContext: { profileId: 'chatgpt-member', groupId: 'happier' },
    });
    expect(failure).toMatchObject({
      code: 'provider_model_not_found',
      runtimeAuthClassification: {
        kind: 'plan',
        limitCategory: 'plan_invalid',
        quotaScope: 'model',
        providerLimitId: 'gpt-6.1-sol',
        profileId: 'chatgpt-member',
        groupId: 'happier',
      },
    });
    expect(
      readCodexAppServerTurnFailureDiagnostic(failure).providerErrorCode,
    ).toBe('model_not_found');
  });

  it.each([
    {
      message: 'refresh token has already been used',
      reason: 'refresh_failed',
    },
    {
      message: 'workspace routing discovery unauthorized (401)',
      reason: 'workspace_routing_unauthorized',
    },
  ])(
    'preserves specific native 401 evidence: $reason',
    ({ message, reason }) => {
      const failure = createCodexAppServerTurnFailure({
        value: {
          turn: {
            error: {
              message,
              codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
            },
          },
        },
      });
      expect(
        readCodexAppServerTurnFailureDiagnostic(failure).failureReason,
      ).toBe(reason);
      expect(failure).not.toHaveProperty('code');
    },
  );

  it.each([
    'The selected model is not supported.',
    'HTTP 400: {"error":{"code":"model_not_found"}',
    'HTTP 400: {"error":{"code":"invalid_request_error","message":"model_not_found"}}',
  ])(
    'does not infer a model refusal from prose or malformed envelopes: %s',
    (message) => {
      const failure = createCodexAppServerTurnFailure({
        value: { error: { message, codexErrorInfo: 'other' } },
      });
      expect(failure).not.toHaveProperty('code');
      expect(
        readCodexAppServerTurnFailureDiagnostic(failure).providerErrorCode,
      ).toBe('Other');
    },
  );

  it.each([
    { http_connection_failed: { http_status_code: 403 } },
    { httpConnectionFailed: { httpStatusCode: 403 } },
  ])(
    'retains structured HTTP failure status without credentials or additional details: %j',
    (codexErrorInfo) => {
      const failure = createCodexAppServerTurnFailure({
        value: {
          turn: {
            error: {
              message: 'Bearer PRIVATE_BODY_AND_CREDENTIAL',
              additionalDetails: 'PRIVATE_PROMPT',
              codexErrorInfo,
            },
          },
        },
      });
      expect(readCodexAppServerTurnFailureDiagnostic(failure)).toMatchObject({
        providerErrorCode: 'HttpConnectionFailed',
        httpStatus: 403,
      });
      expect(JSON.stringify(failure)).not.toContain('PRIVATE_');
    },
  );

  it.each([null, '403', 403.5, 99, 600])(
    'omits invalid structured HTTP status %j',
    (httpStatusCode) => {
      const failure = createCodexAppServerTurnFailure({
        value: {
          error: {
            codexErrorInfo: { httpConnectionFailed: { httpStatusCode } },
            message: 'Bearer PRIVATE_BODY',
          },
        },
      });
      expect(
        readCodexAppServerTurnFailureDiagnostic(failure),
      ).not.toHaveProperty('httpStatus');
      expect(JSON.stringify(failure)).not.toContain('PRIVATE_');
    },
  );

  it('retains only closed provider failure reasons for failure logging', () => {
    const failure = createCodexAppServerTurnFailure({
      value: {
        error: {
          message: 'secret credential and transcript',
          codexErrorInfo: 'ContextWindowExceeded',
        },
      },
    });
    expect(failure).toMatchObject({
      failureReason: 'context_window_exceeded',
      providerErrorCode: 'ContextWindowExceeded',
    });
    const unknown = createCodexAppServerTurnFailure({
      value: {
        error: {
          message: 'secret credential and transcript',
          codexErrorInfo: 'secret-credential',
        },
      },
    });
    expect(unknown).toMatchObject({
      failureReason: 'unclassified_provider_error',
    });
    expect(unknown).not.toHaveProperty('providerErrorCode');
    expect(JSON.stringify(unknown)).not.toContain('secret');
  });
  it('preserves bounded model entitlement evidence for host recovery', () => {
    const failure = createCodexAppServerTurnFailure({
      value: {
        error: {
          type: 'invalid_request_error',
          message:
            "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
        },
      },
      authContext: { profileId: 'free-account', groupId: 'happier' },
    });

    expect(
      (failure as Error & { runtimeAuthClassification?: unknown })
        .runtimeAuthClassification,
    ).toMatchObject({
      kind: 'plan',
      limitCategory: 'plan_invalid',
      quotaScope: 'model',
      providerLimitId: 'gpt-5.6-sol',
    });
  });

  it('carries structured runtime-auth classification for Codex usage-limit errors', () => {
    const failure = createCodexAppServerTurnFailure({
      value: {
        error: {
          message: 'Usage limit reached',
          codexErrorInfo: 'UsageLimitExceeded',
          resets_at: '2026-05-17T15:30:00.000Z',
          retry_after_ms: 90_000,
          plan_type: 'plus',
          rate_limits: { primary: { used_percent: 100 } },
        },
      },
      authContext: { profileId: 'leeroy', groupId: 'happier' },
      sourceAccountIdentity: {
        providerAccountId: 'acct_source',
        accountLabel: 'source@example.test',
        profileId: 'runtime-profile',
        groupId: 'runtime-group',
        generation: 42,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      },
    });

    expect(
      (failure as Error & { runtimeAuthClassification?: unknown })
        .runtimeAuthClassification,
    ).toMatchObject({
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'leeroy',
      groupId: 'happier',
      resetsAtMs: Date.parse('2026-05-17T15:30:00.000Z'),
      retryAfterMs: 90_000,
      planType: 'plus',
      source: 'structured_provider_error',
      sourceProviderAccountId: 'acct_source',
      sourceAccountLabel: 'source@example.test',
      groupGeneration: 42,
      expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
    });
    expect(
      (failure as Error & { runtimeAuthClassification?: unknown })
        .runtimeAuthClassification,
    ).not.toHaveProperty('rateLimits');
  });

  it('uses failure-time runtime identity when separate auth context is unavailable', () => {
    const failure = createCodexAppServerTurnFailure({
      value: {
        error: {
          message: 'Usage limit reached',
          codexErrorInfo: 'UsageLimitExceeded',
        },
      },
      sourceAccountIdentity: {
        providerAccountId: 'acct_source',
        accountLabel: 'source@example.test',
        profileId: 'runtime-profile',
        groupId: 'runtime-group',
        generation: 42,
      },
    });

    expect(
      (failure as Error & { runtimeAuthClassification?: unknown })
        .runtimeAuthClassification,
    ).toMatchObject({
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'runtime-profile',
      groupId: 'runtime-group',
      sourceProviderAccountId: 'acct_source',
      sourceAccountLabel: 'source@example.test',
      groupGeneration: 42,
    });
  });

  it('marks context-window failures only from structured Codex app-server payloads', () => {
    const failure = createCodexAppServerTurnFailure({
      value: {
        turn: {
          error: {
            message: 'Input rejected.',
            codex_error_info: 'context_window_exceeded',
          },
        },
      },
    });

    expect(isCodexAppServerContextWindowExhaustedError(failure)).toBe(true);
    const unclassifiedFailure = createCodexAppServerTurnFailure({
      value: {
        turn: {
          error: {
            message: 'Codex ran out of room in the context window.',
            codex_error_info: 'other',
          },
        },
      },
    });
    expect(
      isCodexAppServerContextWindowExhaustedError(unclassifiedFailure, {
        structuredOnly: true,
      }),
    ).toBe(false);
    expect(
      isCodexAppServerContextWindowExhaustedError(
        new Error('Codex ran out of room in the context window.'),
        { structuredOnly: true },
      ),
    ).toBe(false);
  });

  it('requires native structured context evidence when requested while preserving message compatibility', () => {
    const proseFailure = createCodexAppServerTurnFailure({
      value: {
        error: {
          message: 'Codex ran out of room in the context window.',
          codexErrorInfo: 'Other',
        },
      },
    });
    const structuredFailure = createCodexAppServerTurnFailure({
      value: {
        error: {
          message: 'Input rejected.',
          codexErrorInfo: 'ContextWindowExceeded',
        },
      },
    });

    expect(isCodexAppServerContextWindowExhaustedError(proseFailure)).toBe(
      true,
    );
    expect(
      isCodexAppServerContextWindowExhaustedError(proseFailure, {
        structuredOnly: true,
      }),
    ).toBe(false);
    expect(
      isCodexAppServerContextWindowExhaustedError(structuredFailure, {
        structuredOnly: true,
      }),
    ).toBe(true);
    expect(
      isCodexAppServerContextWindowExhaustedError(
        new Error('Codex ran out of room in the context window.'),
        { structuredOnly: true },
      ),
    ).toBe(false);
  });

  it('marks selected-model capacity failures as temporary recoverable failures', () => {
    const failure = createCodexAppServerTurnFailure({
      value: {
        turn: {
          error: {
            message:
              'Selected model is at capacity. Please try a different model.',
            codex_error_info: 'other',
          },
        },
      },
    });

    expect(isCodexAppServerTemporaryRecoverableTurnFailureError(failure)).toBe(
      true,
    );
    expect(
      (failure as Error & { runtimeAuthClassification?: unknown })
        .runtimeAuthClassification,
    ).toMatchObject({
      kind: 'capacity',
      limitCategory: 'capacity',
      quotaScope: 'provider',
      serviceId: 'openai-codex',
    });
  });

  it('marks provider high-demand failures as temporary recoverable failures', () => {
    const failure = createCodexAppServerTurnFailure({
      value: {
        turn: {
          error: {
            message:
              'The service is currently experiencing high demand. Please try again later.',
            codex_error_info: 'other',
          },
        },
      },
    });

    expect(isCodexAppServerTemporaryRecoverableTurnFailureError(failure)).toBe(
      true,
    );
    expect(
      (failure as Error & { runtimeAuthClassification?: unknown })
        .runtimeAuthClassification,
    ).toMatchObject({
      kind: 'capacity',
      limitCategory: 'capacity',
      quotaScope: 'provider',
      serviceId: 'openai-codex',
    });
  });

  it('formats non-empty messages for UI without double-prefixing error text', () => {
    expect(formatCodexAppServerErrorForUi(new Error('provider failed'))).toBe(
      'Error: provider failed',
    );
    expect(
      formatCodexAppServerErrorForUi(new Error('Error: provider failed')),
    ).toBe('Error: provider failed');
  });

  it('does not expose provider failure prose through the terminal Error or UI formatter', () => {
    const providerMessageSentinel = 'VOICE_PRIVATE_FAILURE_MESSAGE_SENTINEL';
    const providerDetailsSentinel = 'VOICE_PRIVATE_FAILURE_DETAILS_SENTINEL';
    const failure = createCodexAppServerTurnFailure({
      value: {
        error: {
          message: `provider rejected ${providerMessageSentinel}`,
          additional_details: providerDetailsSentinel,
        },
      },
    });

    expect(failure.message).toBe('Codex app-server turn failed.');
    expect(failure.stack ?? '').not.toContain(providerMessageSentinel);
    expect(failure.stack ?? '').not.toContain(providerDetailsSentinel);
    expect(formatCodexAppServerErrorForUi(failure)).toBe(
      'Error: Codex app-server turn failed.',
    );
  });
});

describe('Codex startup authentication projection', () => {
  it.each([
    ['workspace_incompatible', 'auth_error', 'workspace'],
    ['refresh_bridge_unavailable', 'dependency_failure', 'machine'],
    ['experimental_api_unavailable', 'dependency_failure', 'version'],
  ] as const)('produces public source and safe recovery facts for %s before host consumption', (reason, source, preview) => {
    const failure = createCodexAppServerTurnFailure({
      value: new PluginError({ code: 'codex_refresh_free_auth_unsupported',
        message: 'PRIVATE_NATIVE_AUTH_PAYLOAD', details: { reason } }),
      phase: 'client_start',
    });
    expect(readCodexAppServerRuntimeIssueSource(failure)).toBe(source);
    expect(failure.details).toMatchObject({ source,
      failureCause: { reason, providerErrorMessage: expect.stringContaining(preview) } });
    expect(JSON.stringify(failure.details)).not.toContain('PRIVATE_NATIVE_AUTH_PAYLOAD');
  });
});
