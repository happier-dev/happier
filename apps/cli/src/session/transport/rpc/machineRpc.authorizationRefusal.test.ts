import { afterEach, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import tweetnacl from 'tweetnacl';
import axios from '@/api/client/credentialAxios';
import { normalizeCliActionThrownError, normalizeActionExecuteResult, projectCliActionFailure } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { projectDeploymentFailure } from '@/deployments/deploymentFailure';
import { projectActionFailureCauseV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { callExactMachineRpc } from './machineRpc';

afterEach(() => vi.restoreAllMocks());

function callMachine(signed: boolean) {
  const source = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(27));
  const target = { kind: 'machine' as const, machineId: 'machine-target' };
  const actionId = 'machines.provisioners.check';
  const origin = { v: 1 as const, requestId: 'managed-root', sourceTurnId: 'turn',
    caller: { kind: 'session' as const, sessionId: 'source-session', starterDepth: 1, turnDepth: 2 },
    callerPermissionMode: 'read-only' as const };
  const authorization = { v: 1 as const, token: 'never-record-proof', binding: {
    accountId: 'account', authentication: { kind: 'account' as const, tokenEpoch: 0 }, serverIdentityId: 'srv_home',
    machineId: target.machineId, custodianAccountId: 'account', installationId: 'target-installation',
    actionId, requestId: origin.requestId, requestEnvelopeDigest: 'a'.repeat(43), target,
    sessionActionOrigin: origin, sessionActionSource: { machineId: 'machine-source', installationId: 'source-installation' },
  } };
  return callExactMachineRpc({ serverUrl: 'https://home.test',
    credentials: { token: 'never-record-bearer', encryption: null }, machineId: target.machineId,
    method: actionId, request: { kind: 'targeted_action_rpc', v: 1, target,
      input: { homeId: 'srv_home', controller: { machineId: target.machineId, installationId: 'target-installation' },
        contribution: { pluginId: 'acme.compute', localId: 'vm' } } }, requestId: origin.requestId,
    ...(signed ? { externalAction: { context: { surface: 'agent' as const, defaultSessionMachineId: 'machine-source',
      externalActionExecutionAuthorization: authorization, externalActionTarget: target }, effectActionId: actionId,
      installationId: 'source-installation', privateKey: source.secretKey } } : {}),
  });
}

function httpRefusal(status: number, phase: string, owner?: Pick<ActionExecuteFailure, 'details' | 'failureCause'>) {
  const config = { headers: new AxiosHeaders({ Authorization: 'never-record-bearer' }) };
  return new AxiosError('Private transport context never-record', 'ERR_BAD_REQUEST', config, undefined,
    { status, statusText: 'Unauthorized', headers: {}, config,
      data: { error: 'invalid_token', authorizationRefusal: phase, ...owner } });
}

// Home boundary payload from deploymentAdmission's placement projection; no admission is mocked.
const placement = {
  details: { reason: 'controller_placement_mismatch', requiredFact: 'controllerMachineId=recorded-controller',
    remedy: 'Run this action on Machine recorded-controller, or make that controller reachable, then retry' },
  failureCause: projectActionFailureCauseV1(Object.assign(new Error('credential_scope_denied'),
    { code: 'credential_scope_denied' }), 'deployment.controller.placement'),
};

it.each(['verification_purpose', 'deployment_child_http'] as const)(
  'preserves signed Machine lookup refusal %s through Action and deployment output', async phase => {
    const transportRefusal = httpRefusal(401, phase, phase === 'deployment_child_http' ? placement : undefined);
    vi.spyOn(axios, 'get').mockRejectedValue(transportRefusal);
    let refusal: unknown;
    try { await callMachine(true); } catch (error) { refusal = error; }
    const expected = { code: 'action_forbidden', ...(phase === 'deployment_child_http' ? placement : {
      details: { requiredFact: phase, remedy: expect.any(String) },
      failureCause: { phase: `home.authorization.${phase}`, httpStatus: 401 },
    }) };
    const action = projectCliActionFailure(normalizeCliActionThrownError(refusal).failure);
    expect(action).toMatchObject(expected);
    const deployment = normalizeActionExecuteResult(projectDeploymentFailure('action_forbidden', refusal));
    if (deployment.ok) throw new Error('A refused Machine lookup cannot become success');
    const output = projectCliActionFailure(deployment);
    expect(output).toMatchObject(expected);
    expect(JSON.stringify({ action, output })).not.toMatch(/never-record|Private transport context/u);
  });

it.each([[false, 401], [true, 500]] as const)(
  'preserves ordinary transport errors (signed: %s, status: %s)', async (signed, status) => {
    const refusal = httpRefusal(status, 'verification_purpose');
    vi.spyOn(axios, 'get').mockRejectedValue(refusal);
    await expect(callMachine(signed)).rejects.toBe(refusal);
  });
