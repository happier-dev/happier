import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as externalActionApi from './externalActionApi.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';

it('carries Home-issued invocation authority only in the trusted daemon dispatch', () => {
  const target = { kind: 'machine', machineId: 'machine-1' };
  const envelope = { v: 1, requestId: 'request-1', target, input: {} };
  const principal = { accountId: 'account-1', principalId: 'account-1', credentialId: 'pat-1', authority: 'account_automation', grant: API_TOKEN_FULL_GRANT_V1 };
  const executionAuthorization = { v: 1, token: 'home-signed-invocation', binding: {
    serverIdentityId: 'home-1', accountId: 'account-1', principalId: 'account-1', credentialId: 'pat-1',
    machineId: 'machine-1', actionId: 'session.title.set', requestId: 'request-1',
    requestEnvelopeDigest: 'a'.repeat(43), target, grant: API_TOKEN_FULL_GRANT_V1,
  } };
  expect(externalActionApi.ExternalActionDaemonDispatchRequestSchema.safeParse({
    actionId: 'session.title.set', envelope, principal,
    placement: { machineId: 'machine-1', target }, executionAuthorization,
  }).success).toBe(true);
  expect(externalActionApi.ExternalActionRequestEnvelopeSchema.safeParse({ ...envelope, executionAuthorization }).success).toBe(false);
  expect(externalActionApi.ExternalActionDaemonDispatchRequestSchema.safeParse({
    actionId: 'session.title.set', envelope, principal: { ...principal, grant: undefined },
    placement: { machineId: 'machine-1', target }, executionAuthorization,
  }).success).toBe(false);
  expect(externalActionApi.ExternalActionDaemonDispatchRequestSchema.safeParse({
    actionId: 'session.title.set', envelope, principal,
    placement: { machineId: 'machine-1', target },
    executionAuthorization: { ...executionAuthorization, binding: { ...executionAuthorization.binding, grant: undefined } },
  }).success).toBe(false);
});

import {
  EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
  EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES_V2,
  EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES,
  EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2,
  ExternalActionDaemonDispatchResultV1Schema,
  ExternalActionDaemonDispatchRequestV1Schema,
  ExternalActionHttpErrorV1Schema,
  ExternalActionHttpErrorSchema,
  ExternalActionMachineBootstrapListV1Schema,
  ExternalActionResultTooLargeExecutionV1Schema,
  ExternalActionRequestEnvelopeV1Schema,
  ExternalActionRequestIdV1Schema,
  ExternalActionResponseEnvelopeV1Schema,
  ExternalActionTargetV1Schema,
  isExternalActionResolvedTargetAllowedV1,
  createExternalActionDaemonDispatchResponseV1,
  createExternalActionResultTooLargeExecutionV1,
  enforceExternalActionResponseEnvelopeLimitV1,
  measureExternalActionResponseEnvelopeUtf8BytesV1,
  parseExternalActionResponseEnvelopeV1,
  prepareExternalActionResponseEnvelopeV1,
  parseExternalActionDaemonDispatchResultV1,
  projectExternalActionResponseEnvelopeV1,
  projectExternalActionExecutionResultV1,
  projectExternalActionHttpErrorV1,
  projectExternalActionHttpError,
  serializeExternalActionResponseEnvelopeV1,
} from './externalActionApi.js';

function createDeepExternalActionResult(depth = 12_000): unknown {
  let result: unknown = 'leaf';
  for (let index = 0; index < depth; index += 1) {
    result = { value: result };
  }
  return result;
}

it('admits opaque V2 framing and the complete protected pre-open RPC vocabulary without widening V1', () => {
  const envelope = { v: 2, requestId: 'request-1', target: { kind: 'machine', machineId: 'machine-1' },
    payload: { t: 'encrypted', c: 'opaque' } };
  expect(externalActionApi.ExternalActionRequestEnvelopeSchema?.safeParse(envelope).success).toBe(true);
  expect(ExternalActionRequestEnvelopeV1Schema.safeParse(envelope).success).toBe(false);
  expect(externalActionApi.ExternalActionRequestEnvelopeSchema?.safeParse({ ...envelope, input: 'leak' }).success).toBe(false);
  for (const errorCode of [
    'invalid_action',
    'invalid_envelope',
    'request_too_large',
    'internal_error',
    'invalid_encrypted_envelope',
    'encrypted_action_unsupported',
    'target_required',
    'target_not_local',
    'target_unavailable',
    'session_input_target_update_required',
  ] as const) {
    const failure = { kind: 'invalid_request' as const, errorCode, requestId: 'request-1' };
    expect(ExternalActionDaemonDispatchResultV1Schema.safeParse(failure).success).toBe(false);
    expect(externalActionApi.parseExternalActionDaemonDispatchResult(failure)).toEqual(failure);
  }
});

describe('External Action API envelope v1', () => {
  it('owns the opaque request-id grammar used by every external Action client', () => {
    expect(ExternalActionRequestIdV1Schema.safeParse('corrélation-☃').success).toBe(true);
    expect(ExternalActionRequestIdV1Schema.safeParse('x'.repeat(129)).success).toBe(false);
    expect(ExternalActionRequestIdV1Schema.safeParse(' outer-space').success).toBe(false);
  });

  it('keeps the machine-selection bootstrap projection closed and minimal', () => {
    const row = {
      id: 'machine-1',
      active: true,
      revokedAt: null,
      replacedByMachineId: null,
    };

    expect(ExternalActionMachineBootstrapListV1Schema.parse([row])).toMatchObject([row]);
    expect(ExternalActionMachineBootstrapListV1Schema.safeParse([{
      ...row,
      metadata: '{"host":"must-not-cross-this-boundary"}',
    }]).success).toBe(false);
  });

  it('carries the Runner content-key facts a protected SDK request must seal against', () => {
    const runnerRow = {
      id: 'machine-runner-1',
      active: true,
      revokedAt: null,
      replacedByMachineId: null,
      kind: 'ephemeral_session_runner' as const,
      installationId: 'installation-1',
      dataEncryptionKey: 'c2VhbGVkLWVudmVsb3Bl',
      runnerContentKeyBinding: {
        v: 1 as const,
        purpose: 'happier.ephemeral-runner.machine-content-key' as const,
        homeServerIdentityId: 'home-1',
        activationId: '00000000-0000-4000-8000-000000000001',
        creatorAccountId: 'account-1',
        machineId: 'machine-runner-1',
        installationId: 'installation-1',
        machineContentKeyFingerprint: `runner-machine-content-key-sha256:${'a'.repeat(64)}`,
        accountSignatureBase64Url: 'A'.repeat(86),
      },
    };

    // A Runner row the Home publishes without its activation claim stays
    // parseable; the claim then simply cannot select it for a Session target.
    expect(ExternalActionMachineBootstrapListV1Schema.parse([runnerRow])).toEqual([{ ...runnerRow, runnerClaim: null }]);
    // A persistent Machine keeps the released minimal row; kind is projected.
    expect(ExternalActionMachineBootstrapListV1Schema.parse([{
      id: 'machine-1',
      active: true,
      revokedAt: null,
      replacedByMachineId: null,
    }])[0]).toMatchObject({
      id: 'machine-1',
      kind: 'persistent',
      dataEncryptionKey: null,
      installationId: null,
      runnerContentKeyBinding: null,
      runnerClaim: null,
    });
  });

  it('accepts only the public target and input envelope fields', () => {
    expect(ExternalActionRequestEnvelopeV1Schema.parse({
      v: 1,
      requestId: 'request-1',
      target: { kind: 'machine', machineId: 'machine-1' },
      input: { sessionId: 'session-1', nested: ['preserved'] },
    })).toEqual({
      v: 1,
      requestId: 'request-1',
      target: { kind: 'machine', machineId: 'machine-1' },
      input: { sessionId: 'session-1', nested: ['preserved'] },
    });
  });

  it.each([
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['undefined', undefined],
    ['bigint', 1n],
  ])('rejects non-JSON Action input at the external envelope owner: %s', (_label, input) => {
    expect(ExternalActionRequestEnvelopeV1Schema.safeParse({
      v: 1,
      input,
    }).success).toBe(false);
  });

  it('admits only an exact machine or Session transport target', () => {
    expect(ExternalActionTargetV1Schema.safeParse({ kind: 'machine', machineId: 'machine-1' }).success).toBe(true);
    expect(ExternalActionTargetV1Schema.parse({
      kind: 'machine', machineId: 'machine-1',
      project: { machineId: 'machine-1', directory: '~/projects/app', workspaceRefId: 'workspace-1' },
    })).toMatchObject({ project: { directory: '~/projects/app' } });
    expect(ExternalActionTargetV1Schema.safeParse({
      kind: 'machine', machineId: 'machine-1',
      project: { machineId: 'machine-2', directory: '/repo' },
    }).success).toBe(false);
    expect(ExternalActionTargetV1Schema.safeParse({ kind: 'session', sessionId: 'session-1' }).success).toBe(true);
    expect(ExternalActionTargetV1Schema.safeParse({ kind: 'account' }).success).toBe(false);
  });

  it('allows only the selected relay Machine to resolve its exact invocation target', () => {
    const relayTarget = { kind: 'machine' as const, machineId: 'machine-1' };
    expect(isExternalActionResolvedTargetAllowedV1({
      authorizedTarget: relayTarget,
      resolvedTarget: { kind: 'session', sessionId: 'session-1' },
      selectedMachineId: 'machine-1',
    })).toBe(true);
    expect(isExternalActionResolvedTargetAllowedV1({
      authorizedTarget: relayTarget,
      resolvedTarget: { kind: 'machine', machineId: 'machine-2' },
      selectedMachineId: 'machine-1',
    })).toBe(false);
    expect(isExternalActionResolvedTargetAllowedV1({
      authorizedTarget: { kind: 'session', sessionId: 'session-1' },
      resolvedTarget: { kind: 'session', sessionId: 'session-2' },
      selectedMachineId: 'machine-1',
    })).toBe(false);
  });

  it.each([
    { v: 1, input: {}, authority: 'present_user' },
    { v: 1, input: {}, actionCaller: { kind: 'host' } },
    { v: 1, input: {}, bypassApprovals: true },
    { v: 1, input: {}, expectedContributorOccurrenceId: 'forged' },
    { v: 1, input: {}, target: { kind: 'machine', machineId: 'machine-1', accountId: 'forged' } },
  ])('rejects caller-controlled execution context %#', (value) => {
    expect(ExternalActionRequestEnvelopeV1Schema.safeParse(value).success).toBe(false);
  });

  it('keeps the closed server relay frame while preserving an opaque action id for daemon admission', () => {
    const request = {
      actionId: 'not-a-public-action',
      envelope: {
        v: 1,
        target: { kind: 'machine', machineId: 'machine-1' },
        input: {},
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
        grant: API_TOKEN_FULL_GRANT_V1,
      },
      placement: {
        machineId: 'machine-1',
        target: { kind: 'machine', machineId: 'machine-1' },
      },
    };

    expect(ExternalActionDaemonDispatchRequestV1Schema.parse(request)).toEqual(request);
    expect(ExternalActionDaemonDispatchRequestV1Schema.safeParse({
      ...request,
      callerSuppliedAuthority: 'present_user',
    }).success).toBe(false);
  });

  it('keeps externally relayed Action ids opaque but finite', () => {
    const opaqueActionId = 'daemon.newly-introduced-action';
    const response = {
      v: 1,
      actionId: opaqueActionId,
      execution: { ok: true, result: { accepted: true } },
    };
    const relayRequest = {
      actionId: opaqueActionId,
      envelope: { v: 1, input: {} },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
        grant: API_TOKEN_FULL_GRANT_V1,
      },
      placement: {
        machineId: 'machine-1',
        target: { kind: 'machine', machineId: 'machine-1' },
      },
    };

    expect(ExternalActionResponseEnvelopeV1Schema.safeParse(response).success).toBe(true);
    expect(projectExternalActionResponseEnvelopeV1(response)).toEqual(response);
    expect(ExternalActionDaemonDispatchRequestV1Schema.safeParse({
      ...relayRequest,
      actionId: 'a'.repeat(257),
    }).success).toBe(false);
    expect(ExternalActionDaemonDispatchRequestV1Schema.safeParse({
      ...relayRequest,
      actionId: '',
    }).success).toBe(false);
  });

  it('keeps reserved relay admission failures distinct from admitted Action results', () => {
    const response = {
      v: 1,
      actionId: 'daemon.newly-introduced-action',
      execution: {
        ok: false as const,
        errorCode: 'invalid_action',
        error: 'The admitted Action rejected this input',
      },
    };
    const prepared = prepareExternalActionResponseEnvelopeV1(response);
    const admitted = createExternalActionDaemonDispatchResponseV1(prepared);

    expect(ExternalActionDaemonDispatchResultV1Schema.parse({
      kind: 'invalid_request',
      errorCode: 'invalid_action',
    })).toEqual({
      kind: 'invalid_request',
      errorCode: 'invalid_action',
    });
    expect(ExternalActionDaemonDispatchResultV1Schema.parse(admitted)).toEqual(admitted);
    expect(parseExternalActionDaemonDispatchResultV1(admitted)).toEqual({
      kind: 'response',
      prepared,
    });
    expect(parseExternalActionDaemonDispatchResultV1({
      kind: 'response',
      body: new TextEncoder().encode(JSON.stringify({
        ...response,
        execution: {
          ...response.execution,
          actionHandlerInvocation: 'notStarted',
        },
      })),
    })).toBeNull();
    expect(ExternalActionDaemonDispatchResultV1Schema.safeParse({
      kind: 'invalid_request',
      errorCode: 'request_too_large',
    }).success).toBe(false);
    expect(ExternalActionDaemonDispatchResultV1Schema.safeParse({
      ...admitted,
      transportDiagnostic: 'must-not-cross-the-reserved-relay',
    }).success).toBe(false);
  });

  it('projects stable typed transport errors', () => {
    const projected = projectExternalActionHttpErrorV1('request_too_large');

    expect(projected.statusCode).toBe(413);
    expect(ExternalActionHttpErrorV1Schema.parse(projected.payload)).toEqual({
      error: 'invalid_request',
      code: 'request_too_large',
    });
  });

  it('projects one strict redacted pre-open error vocabulary with safe correlation', () => {
    const placement = projectExternalActionHttpError('target_required', 'request-placement');
    expect(placement).toEqual({
      statusCode: 400,
      payload: {
        error: 'invalid_request',
        code: 'target_required',
        requestId: 'request-placement',
      },
    });
    expect(ExternalActionHttpErrorSchema.parse(placement.payload)).toEqual(placement.payload);
    expect(ExternalActionHttpErrorV1Schema.safeParse(placement.payload).success).toBe(false);

    const authentication = projectExternalActionHttpError('invalid_token');
    expect(authentication).toEqual({ statusCode: 401, payload: { error: 'invalid_token' } });
    expect(ExternalActionHttpErrorSchema.parse(authentication.payload)).toEqual(authentication.payload);
    const scope = projectExternalActionHttpError('credential_scope_denied', 'request-not-disclosed');
    expect(scope).toEqual({ statusCode: 403, payload: { error: 'credential_scope_denied' } });
    expect(ExternalActionHttpErrorSchema.parse(scope.payload)).toEqual(scope.payload);
    expect(ExternalActionHttpErrorSchema.safeParse({
      ...placement.payload,
      details: { target: 'must-not-cross' },
    }).success).toBe(false);
  });

  it('owns separate request and response relay carrier byte ceilings', () => {
    expect(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES).toBe(33_554_432);
    expect(EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES).toBe(34_603_008);
    expect(
      EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES
      - EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
    ).toBe(1_048_576);

    expect(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES).toBe(24_000_000);
    expect(EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES).toBe(25_000_000);
    expect(EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES)
      .toBeGreaterThan(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
  });

  it('derives protected transport ceilings without materializing the decoded request ceiling', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./externalActionApi.ts', import.meta.url)),
      'utf8',
    );

    expect(source).not.toMatch(/\.repeat\(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES\)/u);
    expect(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES_V2)
      .toBeLessThan(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES * 2);
    expect(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2)
      .toBeLessThan(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES * 3);
  });

  it('defines a strict result_too_large execution result that records completed execution', () => {
    const execution = createExternalActionResultTooLargeExecutionV1();

    expect(ExternalActionResultTooLargeExecutionV1Schema.parse(execution)).toEqual({
      ok: false,
      errorCode: 'result_too_large',
      error: 'Action execution completed, but its response exceeded the external Action response limit and could not be represented.',
      details: {
        executionCompleted: true,
        maxSerializedBytes: 24_000_000,
      },
    });
    expect(ExternalActionResultTooLargeExecutionV1Schema.safeParse({
      ...execution,
      retryable: true,
    }).success).toBe(false);
  });

  it('measures the complete strict response envelope as serialized UTF-8', () => {
    const response = {
      v: 1,
      actionId: 'session.spawn_new',
      execution: { ok: true, result: 'é' },
    } as const;

    expect(measureExternalActionResponseEnvelopeUtf8BytesV1(response)).toBe(
      new TextEncoder().encode(JSON.stringify(response)).byteLength,
    );
  });

  it('returns one consumable strict response projection with its exact serialized bytes', () => {
    const response = {
      v: 1,
      actionId: 'session.spawn_new',
      requestId: 'request-prepared',
      execution: { ok: true, result: { sessionId: 'session-1' } },
    } as const;

    const prepared = prepareExternalActionResponseEnvelopeV1(response);
    expect(prepared.response).toEqual(response);
    expect(prepared.body).toBe(JSON.stringify(response));
    expect(prepared.byteLength).toBe(new TextEncoder().encode(prepared.body).byteLength);
  });

  it('carries one already-prepared response as binary bytes through the reserved daemon relay', () => {
    const prepared = prepareExternalActionResponseEnvelopeV1({
      v: 1,
      actionId: 'session.spawn_new',
      requestId: 'request-relay-prepared',
      execution: { ok: true, result: { sessionId: 'session-1' } },
    });
    const relay = {
      kind: 'response' as const,
      body: new TextEncoder().encode(prepared.body),
    };

    expect(ExternalActionDaemonDispatchResultV1Schema.parse(relay)).toEqual(relay);
    expect(parseExternalActionDaemonDispatchResultV1(relay)).toEqual({
      kind: 'response',
      prepared,
    });
  });

  it('projects a strict under-limit response that native JSON cannot represent to invalid_action_output', () => {
    const response = {
      v: 1,
      actionId: 'session.spawn_new',
      execution: {
        ok: true,
        result: createDeepExternalActionResult(),
      },
    };

    expect(measureExternalActionResponseEnvelopeUtf8BytesV1(response))
      .toBeLessThan(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    expect(enforceExternalActionResponseEnvelopeLimitV1(response).execution).toEqual({
      ok: false,
      errorCode: 'invalid_action_output',
      error: 'invalid_action_output',
    });
    const serialized = serializeExternalActionResponseEnvelopeV1(response);
    expect(JSON.parse(serialized.body).execution).toEqual({
      ok: false,
      errorCode: 'invalid_action_output',
      error: 'invalid_action_output',
    });
    expect(serialized.byteLength).toBe(new TextEncoder().encode(serialized.body).byteLength);
  });

  it('keeps the external Action response envelope closed while preserving an admitted domain failure', () => {
    const response = {
      v: 1,
      actionId: 'session.spawn_new',
      requestId: 'request-1',
      execution: {
        ok: false,
        errorCode: 'invalid_action',
        error: 'The admitted Action rejected this input',
      },
    };

    expect(ExternalActionResponseEnvelopeV1Schema.parse(response)).toEqual(response);
    expect(parseExternalActionResponseEnvelopeV1(response)).toEqual(response);
    expect(ExternalActionResponseEnvelopeV1Schema.safeParse({
      ...response,
      daemonOnlyDiagnostic: 'must not cross the public boundary',
    }).success).toBe(false);
    expect(ExternalActionResponseEnvelopeV1Schema.safeParse({
      ...response,
      execution: {
        ...response.execution,
        actionHandlerInvocation: 'notStarted',
      },
    }).success).toBe(false);
    expect(parseExternalActionResponseEnvelopeV1({
      ...response,
      execution: {
        ...response.execution,
        actionHandlerInvocation: 'notStarted',
      },
    })).toBeNull();
  });

  it('projects daemon-private execution metadata before a response reaches the strict public envelope', () => {
    const rawResponse = {
      v: 1,
      actionId: 'action.invoke',
      execution: {
        ok: false,
        errorCode: 'target_declined',
        error: 'Target rejected this request',
        details: { reason: 'policy' },
        actionHandlerInvocation: 'notStarted',
      },
    };

    expect(projectExternalActionResponseEnvelopeV1(rawResponse)).toEqual({
      v: 1,
      actionId: 'action.invoke',
      execution: {
        ok: false,
        errorCode: 'target_declined',
        error: 'Target rejected this request',
        details: { reason: 'policy' },
      },
    });
    expect(projectExternalActionResponseEnvelopeV1({
      ...rawResponse,
      daemonOnlyDiagnostic: 'must not cross the relay envelope',
    })).toBeNull();
  });

  it('projects internal execution metadata off both external Action result arms', () => {
    expect(projectExternalActionExecutionResultV1({
      ok: true,
      result: { saved: true },
      data: { internalTargetState: 'completed' },
      actionHandlerInvocation: 'started',
    })).toEqual({
      ok: true,
      result: { saved: true },
    });

    expect(projectExternalActionExecutionResultV1({
      ok: false,
      errorCode: 'target_declined',
      error: 'Target rejected this request',
      details: { reason: 'policy' },
      retryable: true,
      data: { internalTargetState: 'declined' },
      actionHandlerInvocation: 'notStarted',
    })).toEqual({
      ok: false,
      errorCode: 'target_declined',
      error: 'Target rejected this request',
      details: { reason: 'policy' },
    });
  });
});
