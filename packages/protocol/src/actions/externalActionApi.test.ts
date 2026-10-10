import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as externalActionApi from './externalActionApi.js';
import { ApiTokenGrantV1Schema } from '../auth/apiTokenGrant.js';
import { SessionActionRpcOriginV1Schema } from '../rpc/socket.js';

const invocationGrant = ApiTokenGrantV1Schema.parse({ v: 1, actions: { families: [], ids: ['session.title.set'] },
  targets: { sessions: [], machines: ['machine-1'] }, approve: false, origins: [], models: null, permissionModes: null, create: null });

it('carries finite controller custody beside the unchanged guest root and keeps the named currentness purpose closed', () => {
  expect(externalActionApi.ExternalActionExecutionAuthorizationVerifyRequestV1Schema.parse({ v: 1 })).toEqual({ v: 1 });
  const target = { homeId: 'srv_home', managedId: 'managed', enrolledMachineId: 'guest', expectedIntentRevision: 0,
    controller: { machineId: 'controller', installationId: 'controller-installation' },
    origin: { kind: 'finite-command', actionRequestId: 'original-request' }, reason: 'admitted-work' };
  const binding = { accountId: 'Bob', authentication: { kind: 'account', tokenEpoch: 7 }, serverIdentityId: target.homeId,
    machineId: target.enrolledMachineId, custodianAccountId: 'Alice', installationId: 'guest-installation',
    actionId: 'projects.script.run', requestId: target.origin.actionRequestId, requestEnvelopeDigest: 'a'.repeat(43),
    target: { kind: 'machine', machineId: target.enrolledMachineId } };
  const authorization = { v: 1, token: 'original-home-root', binding,
    requesterAccountContext: { kind: 'installation_sealed_v1', installationId: binding.installationId, ciphertext: 'guest-box' },
    managedFiniteWake: { target,
      installationPublicKey: Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex').toString('base64url'),
      requesterAccountContext: { kind: 'installation_sealed_v1', installationId: target.controller.installationId, ciphertext: 'controller-box' } } };
  expect(externalActionApi.ExternalActionExecutionAuthorizationV1Schema.parse(authorization)).toEqual(authorization);
  const parse = (managedFiniteWake: unknown) => externalActionApi.ExternalActionExecutionAuthorizationV1Schema.safeParse({
    ...authorization, managedFiniteWake,
  }).success;
  expect(parse({ ...authorization.managedFiniteWake, target: { ...target, enrolledMachineId: 'unrelated-guest' } })).toBe(false);
  expect(parse({ ...authorization.managedFiniteWake, target: { ...target,
    origin: { ...target.origin, actionRequestId: 'another-original-root' } } })).toBe(false);
  expect(parse({ ...authorization.managedFiniteWake, requesterAccountContext: authorization.requesterAccountContext })).toBe(false);
  expect(parse({ ...authorization.managedFiniteWake, token: 'second-principal' })).toBe(false);
  expect(externalActionApi.ExternalActionExecutionAuthorizationV1Schema.safeParse({ ...authorization,
    binding: { ...binding, actionId: 'session.handoff' } }).success).toBe(false);
  expect(externalActionApi.ExternalActionExecutionAuthorizationVerifyRequestV1Schema.parse({
    v: 1, managedFiniteWakeTarget: target,
  })).toEqual({ v: 1, managedFiniteWakeTarget: target });
  expect(externalActionApi.ExternalActionExecutionAuthorizationVerifyRequestV1Schema.safeParse({
    v: 1, managedFiniteWakeTarget: { ...target, accountId: 'second-principal' },
  }).success).toBe(false);
});

it('carries closed handoff admission through sealed root and exact Home-root continuation without admitting caller credentials', () => {
  const admission = { sessionId: 'same-session', sourceMachineId: 'source-machine', targetMachineId: 'target-machine' };
  const rootEnvelope = { v: 2, requestId: 'root-request', target: { kind: 'machine', machineId: 'source-machine' },
    payload: { t: 'encrypted', c: 'opaque-original-input' }, handoffAdmission: admission };
  expect(externalActionApi.ExternalActionRequestEnvelopeSchema.parse(rootEnvelope)).toEqual(rootEnvelope);
  expect(externalActionApi.ExternalActionRequestEnvelopeSchema.safeParse({ ...rootEnvelope,
    handoffAdmission: { ...admission, token: 'caller-credential' } }).success).toBe(false);
  const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
    caller: { kind: 'session', sessionId: admission.sessionId, starterDepth: 1, turnDepth: 2 },
    sourceTurnId: 'original-turn', callerPermissionMode: 'read-only', workspaceWrites: 'deny', requestId: 'root-request' });
  const rootAuthorization = { v: 1, token: 'home-issued-original-handoff', binding: {
    accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 7 }, serverIdentityId: 'srv_home',
    machineId: admission.sourceMachineId, custodianAccountId: 'source-custodian', installationId: 'source-installation',
    actionId: 'session.handoff', requestId: 'root-request', requestEnvelopeDigest: 'a'.repeat(43), target: rootEnvelope.target,
    sessionActionOrigin: origin, sessionActionSource: { machineId: admission.sourceMachineId, installationId: 'source-installation' },
    handoffAdmission: { ...admission, sourceInstallationId: 'source-installation', targetInstallationId: 'target-installation' },
  } };
  expect(externalActionApi.ExternalActionExecutionAuthorizationV1Schema.parse(rootAuthorization)).toEqual(rootAuthorization);
  const child = { v: 1, machineId: admission.targetMachineId,
    envelope: { v: 2, requestId: 'root-request', target: { kind: 'machine', machineId: admission.targetMachineId },
      payload: { t: 'encrypted', c: 'opaque-exact-target-prepare' }, handoffAdmission: admission },
    handoffContinuation: { authorization: rootAuthorization, handoffId: 'accepted-handoff' },
  };
  expect(externalActionApi.ExternalActionExecutionAuthorizationRequestV1Schema.parse(child)).toEqual(child);
  expect(externalActionApi.ExternalActionExecutionAuthorizationRequestV1Schema.safeParse({ ...child,
    sessionActionOrigin: origin, sessionActionSource: rootAuthorization.binding.sessionActionSource,
    installationProof: { version: 1, algorithm: 'ed25519', signature: 'a'.repeat(86) } }).success).toBe(false);
  expect(externalActionApi.ExternalActionExecutionAuthorizationRequestV1Schema.safeParse({ ...child,
    envelope: { ...child.envelope, handoffAdmission: { ...admission, sessionId: 'substituted-session' } } }).success).toBe(false);
  expect(externalActionApi.ExternalActionExecutionAuthorizationRequestV1Schema.safeParse({ ...child,
    handoffContinuation: { ...child.handoffContinuation, managedId: 'unrelated-controller' } }).success).toBe(false);
  expect(externalActionApi.ExternalActionExecutionAuthorizationRequestV1Schema.safeParse({ ...child,
    handoffContinuation: { ...child.handoffContinuation, authorization: {
      ...rootAuthorization, binding: { ...rootAuthorization.binding, handoffAdmission: admission },
    } } }).success).toBe(false);
});

it('retains authenticated Session origin as automation authority and requires its paired installation proof at initial mint', () => {
  const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
    caller: { kind: 'session', sessionId: 'source', starterDepth: 1, turnDepth: 2 }, sourceTurnId: 'turn',
    callerPermissionMode: 'safe-yolo', workspaceWrites: 'deny', requestId: 'original-request' });
  const authentication = { kind: 'account', tokenEpoch: 7 };
  const principal = { accountId: 'requester', authority: 'account_automation', authentication, sessionActionOrigin: origin };
  expect(externalActionApi.ExternalActionServerPrincipalV1Schema.parse(principal)).toEqual(principal);
  expect(externalActionApi.ExternalActionServerPrincipalV1Schema.safeParse({ ...principal, authority: 'present_user' }).success).toBe(false);
  const { sessionActionOrigin: _origin, ...missingOrigin } = principal;
  expect(externalActionApi.ExternalActionServerPrincipalV1Schema.safeParse(missingOrigin).success).toBe(false);
  expect(externalActionApi.ExternalActionServerPrincipalV1Schema.safeParse({ ...principal, grant: invocationGrant }).success).toBe(false);
  const binding = { accountId: 'requester', authentication, sessionActionOrigin: origin, serverIdentityId: 'srv_home',
    sessionActionSource: { machineId: 'source-machine', installationId: 'source-installation' },
    machineId: 'controller', custodianAccountId: 'requester', installationId: 'installation',
    actionId: 'machines.managed.acquire', requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43),
    target: { kind: 'machine', machineId: 'controller' } };
  expect(externalActionApi.ExternalActionExecutionAuthorizationBindingV1Schema.parse(binding)).toEqual(binding);
  expect(externalActionApi.ExternalActionExecutionAuthorizationBindingV1Schema.safeParse({ ...binding,
    requestId: 'different-origin-request' }).success).toBe(false);
  const request = { v: 1, machineId: 'controller', envelope: { v: 1, requestId: 'original-request', target: binding.target, input: {} },
    sessionActionOrigin: origin, sessionActionSource: binding.sessionActionSource,
    installationProof: { version: 1, algorithm: 'ed25519', signature: 'a'.repeat(86) } };
  expect(externalActionApi.ExternalActionExecutionAuthorizationRequestV1Schema.parse(request)).toEqual(request);
  const { installationProof: _proof, ...withoutProof } = request;
  const { sessionActionOrigin: _requestOrigin, ...withoutOrigin } = request;
  expect(externalActionApi.ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(withoutProof).success).toBe(false);
  expect(externalActionApi.ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(withoutOrigin).success).toBe(false);
  expect(externalActionApi.ExternalActionExecutionAuthorizationRequestV1Schema.safeParse({ ...request,
    envelope: { ...request.envelope, requestId: 'other-request' } }).success).toBe(false);
  expect(externalActionApi.ExternalActionExecutionAuthorizationRequestV1Schema.safeParse({ ...request,
    machineId: 'another-controller' }).success).toBe(false);
  expect(externalActionApi.ExternalActionRequestEnvelopeSchema.safeParse({ ...request.envelope, sessionActionOrigin: origin }).success).toBe(false);
});

it('keeps signed ordinary Account provenance distinct from PAT grants and public input', () => {
  const authentication = { kind: 'account', tokenEpoch: 7,
    evidence: [{ kind: 'home_method', methodId: 'public-key' }] };
  const principal = { accountId: 'requester', authority: 'present_user', authentication };
  const target = { kind: 'machine', machineId: 'controller' };
  const authorization = { v: 1, token: 'home-signed-account-invocation', binding: {
    accountId: 'requester', authentication, serverIdentityId: 'home',
    machineId: 'controller', custodianAccountId: 'custodian', installationId: 'installation',
    actionId: 'machines.managed.acquire', requestId: 'acquire', requestEnvelopeDigest: 'a'.repeat(43), target,
  } };
  expect(externalActionApi.ExternalActionDaemonDispatchRequestSchema.safeParse({
    actionId: 'machines.managed.acquire', envelope: { v: 1, requestId: 'acquire', target, input: {} },
    principal, placement: { machineId: 'controller', target }, executionAuthorization: authorization,
  }).success).toBe(true);
  expect(externalActionApi.ExternalActionExecutionAuthorizationV1Schema.parse(authorization)).toEqual(authorization);
  for (const forged of [
    { ...principal, grant: invocationGrant },
    { ...principal, credentialId: 'fake-pat' },
    { ...principal, authentication: { ...authentication, tokenEpoch: -1 } },
    { ...principal, authentication: { ...authentication, evidence: [...authentication.evidence, ...authentication.evidence] } },
  ]) expect(externalActionApi.ExternalActionServerPrincipalV1Schema.safeParse(forged).success).toBe(false);
  expect(externalActionApi.ExternalActionExecutionAuthorizationBindingV1Schema.safeParse({
    ...authorization.binding, principalId: 'requester', credentialId: 'fake-pat', grant: invocationGrant,
  }).success).toBe(false);
  expect(externalActionApi.ExternalActionRequestEnvelopeSchema.safeParse({
    v: 1, input: {}, principal,
  }).success).toBe(false);
});

it('binds pre-forward managed admission without admitting prompt custody or duplicate request identity', () => {
  const compute = { selection: { kind: 'one-off', homeId: 'home', controller: { machineId: 'controller', installationId: 'installation' },
    launch: { provider: { pluginId: 'machine.example', localId: 'vm' }, schemaVersion: 1, name: 'Work VM', choices: {} },
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
  const managedAdmission = { actionId: 'machines.managed.acquire', input: compute, continuationPresent: true };
  const envelope = { v: 2, requestId: 'request', target: { kind: 'machine', machineId: 'controller' },
    payload: { t: 'encrypted', c: 'sealed-private-agent-start' }, managedAdmission };
  expect(externalActionApi.ExternalActionRequestEnvelopeSchema.parse(envelope)).toEqual(envelope);
  expect(externalActionApi.ExternalActionRequestEnvelopeSchema.safeParse({ ...envelope,
    managedAdmission: { ...managedAdmission, requestId: 'second-identity' } }).success).toBe(false);
  expect(externalActionApi.ExternalActionRequestEnvelopeSchema.safeParse({ ...envelope,
    managedAdmission: { ...managedAdmission, input: { ...compute, agentStart: { initialInput: { text: 'private' } } } } }).success).toBe(false);
});

it('carries an offline admitted row receipt only on target unavailability, never as execution authority', () => {
  const receipt = { managedId: 'waiting-row' };
  expect(externalActionApi.projectExternalActionHttpError('target_unavailable', 'request', receipt)).toEqual({
    statusCode: 409, payload: { error: 'invalid_request', code: 'target_unavailable', requestId: 'request', managedAdmission: receipt },
  });
  for (const payload of [
    { error: 'invalid_request', code: 'invalid_encrypted_envelope', managedAdmission: receipt },
    { error: 'invalid_token', managedAdmission: receipt },
    { error: 'invalid_request', code: 'target_unavailable', managedAdmission: { managedId: '' } },
    { error: 'invalid_request', code: 'target_unavailable', managedAdmission: { ...receipt, operationId: 'fabricated' } },
  ]) expect(externalActionApi.ExternalActionHttpErrorSchema.safeParse(payload).success).toBe(false);
  expect(() => externalActionApi.projectExternalActionHttpError('invalid_envelope', 'request', receipt)).toThrow();
});

it('requires canonical spawn facts on sealed managed child requests while retaining explicit Plain framing', () => {
  const envelope = { v: 2, requestId: 'child', target: { kind: 'machine', machineId: 'guest' },
    payload: { t: 'encrypted', c: 'sealed-private-startup' }, sessionSpawnAdmission: {
      executionTarget: { serverId: 'home', machineId: 'guest' }, directory: { kind: 'managed' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'native.agent', localId: 'agent' } },
    } };
  const body = { v: 1, machineId: 'guest', envelope,
    managedContinuation: { managedId: 'managed', creationRequestId: 'acquire', expectedIntentRevision: 0 } };
  expect(externalActionApi.ExternalActionExecutionAuthorizationRequestV1Schema.parse(body)).toEqual(body);
  const { sessionSpawnAdmission: _facts, ...missingFacts } = envelope;
  expect(externalActionApi.ExternalActionExecutionAuthorizationRequestV1Schema.safeParse({ ...body,
    envelope: missingFacts }).success).toBe(false);
  // Persisted Account mode, not this framing parser, authorizes Plain ingress.
  expect(externalActionApi.ExternalActionExecutionAuthorizationRequestV1Schema.safeParse({ ...body,
    envelope: { v: 1, requestId: 'child', target: envelope.target, input: envelope.sessionSpawnAdmission } }).success).toBe(true);
  expect(externalActionApi.ExternalActionExecutionAuthorizationRequestV1Schema.safeParse({ ...body,
    envelope: { ...envelope, sessionSpawnAdmission: { ...envelope.sessionSpawnAdmission, initialInput: { text: 'private' } } } }).success).toBe(false);
});

it('keeps the signed managed continuation on the exact guest binding without expanding grants', () => {
  const managedContinuation = { managedId: 'managed', creationRequestId: 'acquire', expectedIntentRevision: 0,
    controller: { machineId: 'controller', installationId: 'controller-installation' }, acquireRequestEnvelopeDigest: 'a'.repeat(43) };
  const binding = { accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 7 },
    serverIdentityId: 'home', custodianAccountId: 'custodian', machineId: 'guest', installationId: 'guest-installation',
    actionId: 'session.spawn_new', requestId: 'child', requestEnvelopeDigest: 'b'.repeat(43),
    target: { kind: 'machine', machineId: 'guest' }, managedContinuation };
  expect(externalActionApi.ExternalActionExecutionAuthorizationBindingV1Schema.parse(binding)).toEqual(binding);
  expect(externalActionApi.ExternalActionExecutionAuthorizationBindingV1Schema.safeParse({ ...binding,
    managedContinuation: { ...managedContinuation, grant: invocationGrant } }).success).toBe(false);
});

it('uses captured Account mode rather than encryption-key presence for managed request privacy', () => {
  expect(externalActionApi.isExternalActionRequestVersionAllowedForAccountModeV1({ accountEncryptionMode: 'e2ee', envelopeVersion: 1 })).toBe(false);
  expect(externalActionApi.isExternalActionRequestVersionAllowedForAccountModeV1({ accountEncryptionMode: 'e2ee', envelopeVersion: 2 })).toBe(true);
  expect(externalActionApi.isExternalActionRequestVersionAllowedForAccountModeV1({ accountEncryptionMode: 'plain', envelopeVersion: 1 })).toBe(true);
  expect(externalActionApi.isExternalActionRequestVersionAllowedForAccountModeV1({ accountEncryptionMode: 'plain', envelopeVersion: 2 })).toBe(true);
});

it('carries Home-issued invocation authority only in the trusted daemon dispatch', () => {
  const target = { kind: 'machine', machineId: 'machine-1' };
  const envelope = { v: 1, requestId: 'request-1', target, input: {} };
  const principal = { accountId: 'account-1', principalId: 'account-1', credentialId: 'pat-1', authority: 'account_automation', grant: invocationGrant };
  const executionAuthorization = { v: 1, token: 'home-signed-invocation', binding: {
    serverIdentityId: 'home-1', accountId: 'account-1', principalId: 'account-1', credentialId: 'pat-1',
    custodianAccountId: 'custodian-1', installationId: 'installation-1',
    grant: invocationGrant,
    machineId: 'machine-1', actionId: 'session.title.set', requestId: 'request-1',
    requestEnvelopeDigest: 'a'.repeat(43), target,
  } };
  expect(externalActionApi.ExternalActionDaemonDispatchRequestSchema.safeParse({
    actionId: 'session.title.set', envelope, principal,
    placement: { machineId: 'machine-1', target }, executionAuthorization,
  }).success).toBe(true);
  expect(externalActionApi.ExternalActionRequestEnvelopeSchema.safeParse({ ...envelope, executionAuthorization }).success).toBe(false);
  expect(externalActionApi.ExternalActionExecutionAuthorizationBindingV1Schema.parse(executionAuthorization.binding))
    .toMatchObject({ accountId: 'account-1', custodianAccountId: 'custodian-1', installationId: 'installation-1' });
  const { custodianAccountId: _custodian, ...missingCustodian } = executionAuthorization.binding;
  expect(externalActionApi.ExternalActionExecutionAuthorizationBindingV1Schema.safeParse(missingCustodian).success).toBe(false);
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

  it('carries the shared persistent target resource mode and current recipient envelope independently from Account mode', () => {
    const row = { id: 'shared-machine', active: true, revokedAt: null, replacedByMachineId: null,
      kind: 'persistent' as const, installationId: 'installation-shared', dataEncryptionKey: 'current-recipient-envelope',
      access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use' as const,
        resourceMode: 'e2ee' as const, accessState: 'ready' as const } };
    expect(ExternalActionMachineBootstrapListV1Schema.parse([row])[0]).toMatchObject(row);
    expect(ExternalActionMachineBootstrapListV1Schema.safeParse([{ ...row,
      access: { ...row.access, actorAccountId: 'forged-authority' } }]).success).toBe(false);
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
        grant: invocationGrant,
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
