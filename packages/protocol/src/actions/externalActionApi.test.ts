import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
  EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES,
  EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  ExternalActionDaemonDispatchResultV1Schema,
  ExternalActionDaemonDispatchRequestV1Schema,
  ExternalActionHttpErrorV1Schema,
  ExternalActionMachineBootstrapListV1Schema,
  ExternalActionResultTooLargeExecutionV1Schema,
  ExternalActionRequestEnvelopeV1Schema,
  ExternalActionRequestIdV1Schema,
  ExternalActionResponseEnvelopeV1Schema,
  ExternalActionTargetV1Schema,
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
  serializeExternalActionResponseEnvelopeV1,
} from './externalActionApi.js';

function createDeepExternalActionResult(depth = 12_000): unknown {
  let result: unknown = 'leaf';
  for (let index = 0; index < depth; index += 1) {
    result = { value: result };
  }
  return result;
}

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

    expect(ExternalActionMachineBootstrapListV1Schema.parse([row])).toEqual([row]);
    expect(ExternalActionMachineBootstrapListV1Schema.safeParse([{
      ...row,
      metadata: '{"host":"must-not-cross-this-boundary"}',
    }]).success).toBe(false);
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

  it('admits only an exact machine or Session transport target', () => {
    expect(ExternalActionTargetV1Schema.safeParse({ kind: 'machine', machineId: 'machine-1' }).success).toBe(true);
    expect(ExternalActionTargetV1Schema.safeParse({ kind: 'session', sessionId: 'session-1' }).success).toBe(true);
    expect(ExternalActionTargetV1Schema.safeParse({ kind: 'account' }).success).toBe(false);
  });

  it.each([
    { v: 1, input: {}, authority: 'present_user' },
    { v: 1, input: {}, actionCaller: { kind: 'host' } },
    { v: 1, input: {}, bypassApprovals: true },
    { v: 1, input: {}, expectedContributorImmutableGenerationId: 'forged' },
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
