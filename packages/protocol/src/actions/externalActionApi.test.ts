import { describe, expect, it } from 'vitest';

import {
  ExternalActionDaemonDispatchRequestV1Schema,
  ExternalActionHttpErrorV1Schema,
  ExternalActionRequestEnvelopeV1Schema,
  ExternalActionTargetV1Schema,
  projectExternalActionHttpErrorV1,
} from './externalActionApi.js';

describe('External Action API envelope v1', () => {
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

  it('projects stable typed transport errors', () => {
    const projected = projectExternalActionHttpErrorV1('request_too_large');

    expect(projected.statusCode).toBe(413);
    expect(ExternalActionHttpErrorV1Schema.parse(projected.payload)).toEqual({
      error: 'invalid_request',
      code: 'request_too_large',
    });
  });
});
