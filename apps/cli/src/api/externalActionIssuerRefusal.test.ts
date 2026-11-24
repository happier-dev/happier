import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectExternalActionHttpError } from '@happier-dev/protocol/actions/externalActionHttpError';
import axios from '@/api/client/credentialAxios';

import { mintExternalActionExecutionAuthorization } from './externalActionAuthorizationHttp';
import { projectSessionActionIssuerRefusal } from './externalActionIssuerRefusal';

describe('Session Action mint HTTP refusal', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const authoredCause = {
    phase: 'machine.admission', errorClass: 'Error', errorCode: 'machine_manage_required', httpStatus: null,
  } satisfies ActionFailureCauseV1;

  it('keeps the phase, public code and status of a code-only Machine refusal on a Session output read', async () => {
    const requestId = 'sample-output-read';
    const { statusCode, payload } = projectExternalActionHttpError('target_unavailable', requestId);
    vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: statusCode, data: payload });

    const result = await mintExternalActionExecutionAuthorization({
      actionId: 'projects.execution.output.read', machineId: 'shared-machine',
      serverHttpBaseUrl: 'https://home.invalid', pat: 'test-credential',
      envelope: { v: 1, requestId, target: { kind: 'machine', machineId: 'shared-machine' }, input: {} },
      sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId: 'sample-session', starterDepth: 0, turnDepth: 1 },
        sourceTurnId: 'sample-turn', requestId, callerPermissionMode: null },
    });

    if (result.ok) throw new Error('Expected Home to refuse the mint');
    expect(projectSessionActionIssuerRefusal({ ...result, phase: 'mint', requiredFact: 'home_minted_authorization' }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', requestId, failureCause: {
        phase: 'session.authorization.mint', errorClass: 'HttpStatusError', errorCode: 'target_unavailable', httpStatus: statusCode,
      } });
  });

  it.each([
    { given: 'a code-only denial', supplied: undefined, expected: {
      phase: 'session.authorization.mint', errorClass: 'HttpStatusError', errorCode: 'credential_scope_denied', httpStatus: 403,
    } },
    { given: 'an authored cause', supplied: authoredCause, expected: authoredCause },
  ])('retains the Home refusal for $given', async ({ supplied, expected }) => {
    const requestId = 'sample-mint-refusal';
    vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 403,
      data: { error: 'credential_scope_denied', requestId, ...(supplied === undefined ? {} : { failureCause: supplied }) },
    });

    const result = await mintExternalActionExecutionAuthorization({
      actionId: 'computer.target.get', machineId: 'sample-machine',
      serverHttpBaseUrl: 'https://home.invalid', pat: 'test-credential',
      envelope: { v: 1, requestId, target: { kind: 'machine', machineId: 'sample-machine' }, input: {} },
      sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId: 'sample-session', starterDepth: 0, turnDepth: 1 },
        sourceTurnId: 'sample-turn', requestId, callerPermissionMode: null },
    });

    expect(result).toMatchObject({ ok: false, code: 'credential_scope_denied', requestId, failureCause: expected });
    if (result.ok) throw new Error('Expected Home to refuse the mint');
    expect(projectSessionActionIssuerRefusal({ ...result, phase: 'mint', requiredFact: 'home_minted_authorization' }))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied', requestId, failureCause: expected });
  });
});

describe('Session Action issuer refusal projection', () => {
  it('preserves the Machine owner target failure without inventing an authorization failure', () => {
    const result = projectSessionActionIssuerRefusal({
      ok: false, phase: 'mint', requiredFact: 'home_minted_authorization', code: 'target_unavailable',
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
      failureCause: { phase: 'session.authorization.mint', errorClass: 'Error', errorCode: 'target_unavailable', httpStatus: null } });
    expect(result.details).toBeUndefined();
  });

  it('retains the Machine owner diagnostic for an unavailable target', () => {
    const details = { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' };
    const result = projectSessionActionIssuerRefusal({
      ok: false, phase: 'mint', requiredFact: 'home_minted_authorization', code: 'target_unavailable', details,
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable', details });
  });

  it('keeps an absent issuer decision classified as forbidden', () => {
    expect(projectSessionActionIssuerRefusal({
      ok: false, phase: 'mint', requiredFact: 'home_minted_authorization',
    })).toMatchObject({ ok: false, errorCode: 'action_forbidden',
      details: { reason: 'external_authorization_refused', requiredFact: 'home_minted_authorization' } });
  });
});


it('retains HTTP refusal cause and correlation through the Session issuer projection', () => {
  const failureCause = { phase: 'execution_authorization', errorClass: 'Error', errorCode: 'RPC_FORBIDDEN', httpStatus: 403 } as const;
  for (const code of ['target_not_local', 'credential_scope_denied', 'invalid_token']) {
    expect(projectSessionActionIssuerRefusal({ ok: false, phase: 'mint', requiredFact: 'home_minted_authorization',
      code, requestId: 'mint-request', failureCause, ...(code === 'target_not_local' ? { details: { phase: 'target_installation' } } : {}) }))
      .toMatchObject({ ok: false, errorCode: code, requestId: 'mint-request', failureCause,
        ...(code === 'target_not_local' ? { details: { phase: 'target_installation' } } : {}) });
  }
});

it('names Manage on the Machine, not a reconnect, when Home refused the Machine admission for it', () => {
  // Home's Machine admission owner refused a Use grantee an Action that needs Manage.
  const failureCause = { phase: 'execution_authorization', errorClass: 'Error', errorCode: 'machine_manage_required', httpStatus: null } as const;
  const result = projectSessionActionIssuerRefusal({ ok: false, phase: 'mint', requiredFact: 'home_minted_authorization',
    code: 'credential_scope_denied', requestId: 'mint-request', failureCause });

  expect(result).toMatchObject({ ok: false, errorCode: 'credential_scope_denied', requestId: 'mint-request', failureCause,
    details: { reason: 'machine_manage_required', requiredFact: 'machine_manage_role', remedy: 'request_machine_manage_access' } });
});
