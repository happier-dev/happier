import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { invokeHostAdmittedSignedReviewedChildV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { SESSION_AGENT_READINESS_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createExternalActionSourceMachineRpcExecution, readExternalActionSourceMachineRpcSigner } from './externalActionExecutionAuthorization';

const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(71));
const target = { kind: 'machine' as const, machineId: 'guest' };
const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'approved-spawn', binding: {
  serverIdentityId: 'srv_home', accountId: 'member', authentication: { kind: 'account', tokenEpoch: 2 },
  actionId: 'session.spawn_new', requestId: 'spawn-request', requestEnvelopeDigest: 'a'.repeat(43),
  machineId: 'guest', installationId: 'guest-installation', custodianAccountId: 'member', target,
  accountEncryptionMode: 'e2ee',
} });
const request = { homeId: 'srv_home', managedId: 'managed', sessionId: 'spawned-session', bindingKey: 'binding',
  expectedResourceRevision: 3, expectedSourceRevision: 'source-revision', expectedProviderTicket: 'opaque-ticket' };
const managedAdmission = { actionId: 'machines.managed.credentials.install' as const, input: request };
const child = { authorization: root, effectActionId: 'machines.managed.credentials.install', target,
  sourceMachineId: 'guest', sourceInstallationId: 'guest-installation',
  method: 'controller:machines.managed.credentials.install', requestId: 'install-request',
  params: 'invocation-ciphertext', managedAdmission, privateKey: keys.secretKey };

describe('spawn native credential child source signing', () => {
  it('retains exact handoff source custody while signing the destination resume and refuses other spawn effects', () => {
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ ...root, binding: { ...root.binding,
      handoffAdmission: { sessionId: 'session', sourceMachineId: 'source', sourceInstallationId: 'source-installation',
        targetMachineId: 'guest', targetInstallationId: 'guest-installation' },
      handoffContinuation: { rootRequestId: root.binding.requestId, rootRequestEnvelopeDigest: root.binding.requestEnvelopeDigest, handoffId: 'handoff' },
    } });
    expect(readExternalActionSourceMachineRpcSigner(authorization)).toEqual({ machineId: 'source', installationId: 'source-installation' });
    const request = { authorization, effectActionId: 'session.spawn_new', target,
      sourceMachineId: 'source', sourceInstallationId: 'source-installation',
      method: `guest:${RPC_METHODS.SPAWN_HAPPY_SESSION}`, requestId: 'resume', params: 'private-resume', privateKey: keys.secretKey };
    expect(createExternalActionSourceMachineRpcExecution(request)).toMatchObject({ installationId: 'guest-installation' });
    for (const changed of [
      { sourceMachineId: 'another-source' }, { sourceInstallationId: 'replaced-source' },
      { effectActionId: 'session.stop' }, { method: `guest:${RPC_METHODS.SESSION_SPAWN_NEW}` },
    ]) expect(createExternalActionSourceMachineRpcExecution({ ...request, ...changed })).toBeNull();
    expect(readExternalActionSourceMachineRpcSigner({ ...authorization, binding: { ...authorization.binding,
      installationId: 'replaced-destination' } })).toBeNull();
  });

  it('signs an admitted readiness child and refuses the same child without private review', async () => {
    const { action: actionId, role } = SESSION_AGENT_READINESS_CHILDREN_V1.acquire;
    const input = { machineId: 'guest', agentId: 'codex', intent: 'install' };
    const reviewedChild = { actionId, role, inputDigest: 'b'.repeat(43) };
    const request = { authorization: root, effectActionId: actionId, target, sourceMachineId: 'guest',
      sourceInstallationId: 'guest-installation', method: `guest:${RPC_METHODS.DAEMON_AGENTS_INSTALL_START}`,
      requestId: 'install', params: 'encrypted-body', privateKey: keys.secretKey };
    expect(createExternalActionSourceMachineRpcExecution(request)).toBeNull();
    await invokeHostAdmittedSignedReviewedChildV1({ context: { externalActionExecutionAuthorization: root,
      externalActionTarget: target }, child: { ...reviewedChild, input }, execute: async (_input, context) => {
      const execution = createExternalActionSourceMachineRpcExecution({ ...request, context });
      expect(execution).not.toBeNull();
      if (!execution) throw new Error('Missing readiness execution');
      expect(execution.reviewedChild).toEqual(reviewedChild);
      const signed = { authorizationToken: root.token, effectActionId: actionId, target,
        installationId: 'guest-installation', event: SOCKET_RPC_EVENTS.CALL, method: request.method,
        requestId: request.requestId, params: request.params, reviewedChild,
        signature: execution.machineSignature, publicKey: keys.publicKey };
      expect(verifyExternalActionMachineRpcRequestV1(signed)).toBe(true);
      expect(verifyExternalActionMachineRpcRequestV1({ ...signed, reviewedChild: { ...reviewedChild, role: 'forged' } })).toBe(false);
    } });
  });

  it('retains the spawn source identity and signs the exact managed admission for the controller child', () => {
    expect(readExternalActionSourceMachineRpcSigner(root)).toEqual({ machineId: 'guest', installationId: 'guest-installation' });
    const execution = createExternalActionSourceMachineRpcExecution(child);
    expect(execution).toMatchObject({ target, installationId: 'guest-installation', managedAdmission });
    if (!execution) throw new Error('Expected a signed native child');
    const signed = { authorizationToken: root.token, effectActionId: child.effectActionId, target,
      installationId: 'guest-installation', event: SOCKET_RPC_EVENTS.CALL, method: child.method,
      requestId: child.requestId, params: child.params, managedAdmission,
      signature: execution.machineSignature, publicKey: keys.publicKey };
    expect(verifyExternalActionMachineRpcRequestV1(signed)).toBe(true);
    expect(verifyExternalActionMachineRpcRequestV1({ ...signed, managedAdmission: {
      actionId: 'machines.managed.credentials.install', input: { ...request, bindingKey: 'other-binding' },
    } })).toBe(false);
    expect(JSON.stringify(execution)).not.toContain(Buffer.from(keys.secretKey).toString('base64'));
  });

  it('refuses another effect, missing admission, release, changed source, target or method', () => {
    for (const changed of [
      { effectActionId: 'machines.managed.rebuild' },
      { managedAdmission: undefined },
      { managedAdmission: { ...managedAdmission, input: { ...request, operation: 'release' as const } } },
      { sourceMachineId: 'other-guest' },
      { sourceInstallationId: 'replaced-installation' },
      { target: { kind: 'machine' as const, machineId: 'controller' } },
      { method: 'controller:machines.managed.rebuild' },
    ]) expect(createExternalActionSourceMachineRpcExecution({ ...child, ...changed })).toBeNull();
  });
});
