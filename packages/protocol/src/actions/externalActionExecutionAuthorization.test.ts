import { expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionMachineRequestV1, verifyExternalActionMachineRequestV1, signExternalActionApprovalInputV1, verifyExternalActionApprovalInputV1, signExternalActionMachineRpcRequestV1, verifyExternalActionMachineRpcRequestV1 } from './externalActionExecutionAuthorization.js';
import { computeExternalActionSocketRpcRequestDigestV1 } from './externalActionExecutionAuthorization.js';
import { WorkspaceSyncSourceContextV1Schema, WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncTargetRoutingV1Schema } from '../rpc/socket.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { sealExternalActionRequestV2 } from './externalActionEncryption.js';

it.each([1, 2] as const)('binds the installed TARGET decryption attestation to the original Project envelope v%s and logical SOURCE', version => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(27));
  const target = { kind: 'machine' as const, machineId: 'chosen-target' };
  const input = { serverId: `srv_${'a'.repeat(32)}`, machineId: target.machineId,
    source: { kind: 'workspace' as const, workspaceId: 'source-ref', checkout: { serverId: `srv_${'a'.repeat(32)}`,
      workspaceId: 'source-ref', machineId: 'source-child', rootPath: '/child/source' } },
    materialization: { kind: 'sync' as const, targetPath: '/child/target', workspaceAction: { kind: 'copy_once' as const } } };
  const originalActionEnvelope = version === 1 ? { v: 1 as const, requestId: 'original-open', target, input }
    : sealExternalActionRequestV2({ binding: { serverIdentityId: input.serverId, accountId: 'requester',
      credentialId: '11111111-1111-4111-8111-111111111111', actionId: 'projects.open', requestId: 'original-open', target },
      input, material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(24) }, randomBytes: tweetnacl.randomBytes });
  const workspaceSyncSourceRouting = { ...WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare',
    operationId: 'source-loan-not-root-request', accountServerId: input.serverId, sourceMachineId: 'source-child',
    sourceRootPath: '/child/source', sourceContext: { machineAdmission: { actorAccountId: 'requester',
      custodianAccountId: 'source-custodian', machineId: 'source-child', installationId: 'source-installation',
      role: 'use', encryptionMode: 'plain' }, callerAuthority: 'account_automation' } }), originalActionEnvelope };
  const request = { authorizationToken: 'unchanged-project-root', effectActionId: 'projects.open', target,
    installationId: 'chosen-target-installation', requestId: 'original-open', event: 'rpc-call' as const,
    method: `physical-writer:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`,
    params: 'sealed-original-open-body', workspaceSyncSourceRouting };
  const signature = signExternalActionMachineRpcRequestV1({ ...request, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, signature, publicKey: key.publicKey })).toBe(true);
  for (const routing of [
    { ...workspaceSyncSourceRouting, originalActionEnvelope: { ...originalActionEnvelope, requestId: 'another-root' } },
    { ...workspaceSyncSourceRouting, originalActionEnvelope: { ...originalActionEnvelope,
      target: { kind: 'machine' as const, machineId: 'physical-writer' } } },
    { ...workspaceSyncSourceRouting, sourceMachineId: 'another-source' },
    { ...workspaceSyncSourceRouting, sourceRootPath: '/child/another-source' },
    { ...workspaceSyncSourceRouting, operationId: 'another-loan' },
  ]) expect(verifyExternalActionMachineRpcRequestV1({ ...request, workspaceSyncSourceRouting: routing,
    signature, publicKey: key.publicKey })).toBe(false);
  const { workspaceSyncSourceRouting: _routing, ...withoutRouting } = request;
  expect(verifyExternalActionMachineRpcRequestV1({ ...withoutRouting, signature, publicKey: key.publicKey })).toBe(false);
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, signature,
    publicKey: tweetnacl.sign.keyPair().publicKey })).toBe(false);
});

it('binds the physical SOURCE writer TARGET purpose to the unchanged root and exact retained routing snapshot', () => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
  const sourceContext = WorkspaceSyncSourceContextV1Schema.parse({ machineAdmission: { actorAccountId: 'requester',
    custodianAccountId: 'source-custodian', machineId: 'source-child', installationId: 'child-installation', role: 'use', encryptionMode: 'plain' },
    callerAuthority: 'account_automation', callerInputConstraints: { models: null, permissionModes: ['default'] } });
  const source = { ...WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: 'retained-source-loan',
    accountServerId: `srv_${'a'.repeat(32)}`, sourceMachineId: 'source-child', sourceRootPath: '/child/source', sourceSessionId: 'moved-session' }), sourceContext };
  const { targetContext: _targetContext, ...target } = WorkspaceSyncTargetRoutingV1Schema.parse({ v: 1, phase: 'preflight',
    operationId: 'target-preflight', accountServerId: source.accountServerId, targetMachineId: 'chosen-target', targetRootPath: '/target',
    targetContext: { ...sourceContext, machineAdmission: { ...sourceContext.machineAdmission,
      machineId: 'chosen-target', installationId: 'target-installation', custodianAccountId: 'target-custodian' } } });
  const workspaceSyncSourceWriterTargetRouting = { v: 1 as const, source, target,
    sourceWriter: { machineId: 'physical-writer', installationId: 'physical-writer-installation' } };
  const request = { authorizationToken: 'original-child-root', effectActionId: 'session.handoff',
    target: { kind: 'machine' as const, machineId: 'source-child' }, installationId: 'physical-writer-installation',
    event: 'rpc-call' as const, method: `chosen-target:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`,
    requestId: 'original-request', params: 'opaque-target-preflight', workspaceSyncSourceWriterTargetRouting };
  const signature = signExternalActionMachineRpcRequestV1({ ...request, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, signature, publicKey: key.publicKey })).toBe(true);
  for (const changedRouting of [
    { ...workspaceSyncSourceWriterTargetRouting, source: { ...source, operationId: 'another-source-loan' } },
    { ...workspaceSyncSourceWriterTargetRouting, source: { ...source, sourceRootPath: '/child/other' } },
    { ...workspaceSyncSourceWriterTargetRouting, source: { ...source, sourceContext: { ...sourceContext,
      callerInputConstraints: { models: null, permissionModes: null } } } },
    { ...workspaceSyncSourceWriterTargetRouting, target: { ...target, targetRootPath: '/foreign-target' } },
    { ...workspaceSyncSourceWriterTargetRouting, target: { ...target, operationId: 'another-target-operation' } },
    { ...workspaceSyncSourceWriterTargetRouting, target: { ...target, phase: 'release' as const } },
    { ...workspaceSyncSourceWriterTargetRouting, sourceWriter: { machineId: 'foreign-writer', installationId: 'physical-writer-installation' } },
    { ...workspaceSyncSourceWriterTargetRouting, sourceWriter: { machineId: 'physical-writer', installationId: 'replaced-writer-installation' } },
  ]) {
    const tampered = { ...request, workspaceSyncSourceWriterTargetRouting: changedRouting, signature, publicKey: key.publicKey };
    expect(verifyExternalActionMachineRpcRequestV1(tampered)).toBe(false);
  }
  const withoutPurpose = { ...request, workspaceSyncSourceWriterTargetRouting: undefined, signature, publicKey: key.publicKey };
  expect(verifyExternalActionMachineRpcRequestV1(withoutPurpose)).toBe(false);
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, signature,
    publicKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(20)).publicKey })).toBe(false);
});

it('binds the installed physical TARGET seed request to both retained Project snapshots', () => {
  const key = tweetnacl.sign.keyPair();
  const sourceContext = WorkspaceSyncSourceContextV1Schema.parse({ machineAdmission: { actorAccountId: 'requester',
    custodianAccountId: 'source-custodian', machineId: 'source-child', installationId: 'source-installation', role: 'use', encryptionMode: 'plain' },
    callerAuthority: 'present_user' });
  const source = { ...WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: 'source-operation',
    accountServerId: 'home', sourceMachineId: 'source-child', sourceRootPath: '/child/source' }), sourceContext };
  const target = WorkspaceSyncTargetRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: 'target-operation',
    accountServerId: 'home', targetMachineId: 'chosen-target', targetRootPath: '/child/target',
    targetContext: { ...sourceContext, machineAdmission: { ...sourceContext.machineAdmission,
      machineId: 'chosen-target', installationId: 'target-installation', custodianAccountId: 'target-custodian' } } });
  const { targetContext: _context, ...targetPhase } = target;
  const workspaceSyncSeedRouting = { v: 1 as const, sourceWriterTarget: { v: 1 as const, source, target: targetPhase,
    sourceWriter: { machineId: 'physical-source', installationId: 'source-writer-installation' } }, target };
  const request = { authorizationToken: 'original-project-root', effectActionId: 'projects.open',
    target: { kind: 'machine' as const, machineId: 'chosen-target' }, installationId: 'physical-target-installation',
    method: `physical-source:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`, requestId: 'seed-request', params: 'sealed-seed-request', workspaceSyncSeedRouting };
  const signature = signExternalActionMachineRpcRequestV1({ ...request, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, signature, publicKey: key.publicKey })).toBe(true);
  for (const changed of [
    { ...workspaceSyncSeedRouting, target: { ...target, targetContext: { ...target.targetContext,
      machineAdmission: { ...target.targetContext.machineAdmission, installationId: 'replaced-target' } } } },
    { ...workspaceSyncSeedRouting, sourceWriterTarget: { ...workspaceSyncSeedRouting.sourceWriterTarget,
      sourceWriter: { machineId: 'foreign-source', installationId: 'source-writer-installation' } } },
  ]) {
    const tampered = { ...request, workspaceSyncSeedRouting: changed, signature, publicKey: key.publicKey };
    expect(verifyExternalActionMachineRpcRequestV1(tampered)).toBe(false);
  }
  const withoutSeedPurpose = { ...request, workspaceSyncSeedRouting: undefined, signature, publicKey: key.publicKey };
  expect(verifyExternalActionMachineRpcRequestV1(withoutSeedPurpose)).toBe(false);
  expect(() => signExternalActionMachineRpcRequestV1({ ...request,
    method: `physical-source:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE}`, privateKey: key.secretKey })).toThrow();
});

it('binds a Session input authorization to actual RPC bytes rather than an invented encryption envelope', () => {
  const digestRpc = computeExternalActionSocketRpcRequestDigestV1;
  const request = { method: 'session-a:session.userMessage.send', requestId: 'rpc-a', params: 'opaque-session-ciphertext', target: { kind: 'session' as const, sessionId: 'session-a' } };
  const digest = digestRpc(request);
  expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  for (const changed of [ { method: 'session-a:abort' }, { requestId: 'rpc-b' }, { params: 'other-ciphertext' },
    { target: { kind: 'session' as const, sessionId: 'session-b' } },
  ]) expect(digestRpc({ ...request, ...changed })).not.toBe(digest);
  expect(digestRpc({ ...request, params: { a: 1, b: 2 } })).toBe(digestRpc({ ...request, params: { b: 2, a: 1 } }));
  expect(digestRpc({ ...request, params: undefined })).not.toBe(digestRpc({ ...request, params: null }));
});

it('binds auxiliary RPC to its exact invocation, installation, correlation and opaque payload', () => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
  const request = { authorizationToken: 'parent', effectActionId: 'session.list', target: { kind: 'machine' as const, machineId: 'machine-1' }, installationId: 'installation-1', event: 'rpc-call' as const, method: 'machine-1:read', requestId: 'rpc-1', params: 'encrypted-payload' };
  const signature = signExternalActionMachineRpcRequestV1({ ...request, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, signature, publicKey: key.publicKey })).toBe(true);
  for (const changed of [{ authorizationToken: 'other' }, { installationId: 'other' }, { event: 'other-event' as const }, { method: 'machine-2:read' }, { requestId: 'rpc-2' }, { params: 'other-ciphertext' }, { target: { kind: 'session' as const, sessionId: 'other' } }]) {
    expect(verifyExternalActionMachineRpcRequestV1({ ...request, ...changed, signature, publicKey: key.publicKey })).toBe(false);
  }
  expect(verifyExternalActionMachineRequestV1({ ...request, method: 'POST', path: request.method, body: request.params, signature, publicKey: key.publicKey })).toBe(false);
});

it('binds protected machine input admission to its own event and complete unsigned payload', () => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
  const request = { authorizationToken: 'invocation', effectActionId: 'session.message.send',
    target: { kind: 'session' as const, sessionId: 'session-1' }, installationId: 'installation-1',
    event: 'session-pending-enqueue-by-machine-v1' as const, method: 'session-pending-enqueue-by-machine-v1',
    requestId: 'request-1', params: { v: 1, sessionId: 'session-1', targetMachineId: 'machine-1',
      localId: 'input-1', content: { t: 'encrypted', c: 'ciphertext' }, requestedAction: 'send_now' } };
  const signature = signExternalActionMachineRpcRequestV1({ ...request, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, signature, publicKey: key.publicKey })).toBe(true);
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, event: 'rpc-call', signature, publicKey: key.publicKey })).toBe(false);
  expect(verifyExternalActionMachineRpcRequestV1({ ...request,
    params: { ...request.params, localId: 'input-2' }, signature, publicKey: key.publicKey })).toBe(false);
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, event: 'other-event', signature, publicKey: key.publicKey })).toBe(false);
  expect(() => signExternalActionMachineRpcRequestV1({ ...request, event: 'other-event', privateKey: key.secretKey })).toThrow();
});

it('keeps approval input signatures separate from network request signatures', () => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
  const approval = { authorizationToken: 'invocation', actionId: 'teams.archive', target: { kind: 'machine' as const, machineId: 'machine-1' }, input: { teamId: 'team-1' } };
  const signature = signExternalActionApprovalInputV1({ ...approval, privateKey: key.secretKey });
  expect(verifyExternalActionApprovalInputV1({ ...approval, signature, publicKey: key.publicKey })).toBe(true);
  expect(verifyExternalActionApprovalInputV1({ ...approval, input: { teamId: 'team-2' }, signature, publicKey: key.publicKey })).toBe(false);
  expect(verifyExternalActionMachineRequestV1({ authorizationToken: 'invocation', effectActionId: 'teams.archive', target: approval.target, installationId: 'installation-1', requestId: 'request-1', method: 'POST', path: 'teams.archive', body: approval.input, signature, publicKey: key.publicKey })).toBe(false);
});

it('binds Machine possession to the invocation and exact downstream request', () => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
  const request = { authorizationToken: 'home-authorization', effectActionId: 'teams.rename', target: { kind: 'machine' as const, machineId: 'machine-1' }, installationId: 'installation-1', requestId: 'request-1', method: 'POST', path: '/v1/teams/t/rename', body: { name: 'Acme', revision: 2 } };
  const signature = signExternalActionMachineRequestV1({ ...request, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRequestV1({ ...request, signature, publicKey: key.publicKey })).toBe(true);
  expect(verifyExternalActionMachineRequestV1({ ...request, body: { revision: 2, name: 'Acme' }, signature, publicKey: key.publicKey })).toBe(true);
  for (const changed of [
    { authorizationToken: 'other-invocation' }, { effectActionId: 'teams.archive' }, { installationId: 'installation-2' }, { requestId: 'request-2' }, { method: 'DELETE' }, { path: '/v1/teams/other/rename' }, { body: { name: 'Other', revision: 2 } },
    { target: { kind: 'machine' as const, machineId: 'machine-2' } },
  ]) expect(verifyExternalActionMachineRequestV1({ ...request, ...changed, signature, publicKey: key.publicKey })).toBe(false);
  expect(verifyExternalActionMachineRequestV1({ ...request, signature, publicKey: tweetnacl.sign.keyPair().publicKey })).toBe(false);
  expect(verifyExternalActionMachineRequestV1({ ...request, signature: 'malformed', publicKey: key.publicKey })).toBe(false);
  const absentBody = { ...request, body: undefined };
  const absentBodySignature = signExternalActionMachineRequestV1({ ...absentBody, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRequestV1({ ...absentBody, body: null, signature: absentBodySignature, publicKey: key.publicKey })).toBe(false);
});

it('binds the exact project member of a Machine target in every signature', () => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(6));
  const target = { kind: 'machine' as const, machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo/a', workspaceRefId: 'workspace-1' } };
  const request = { authorizationToken: 'home-authorization', effectActionId: 'workflow.run.start', target, installationId: 'installation-1', requestId: 'request-1', method: 'POST', path: '/v1/workflows/runs', body: {} };
  const signature = signExternalActionMachineRequestV1({ ...request, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRequestV1({ ...request, signature, publicKey: key.publicKey })).toBe(true);
  expect(verifyExternalActionMachineRequestV1({ ...request, target: { ...target, project: { ...target.project, directory: '/repo/b' } }, signature, publicKey: key.publicKey })).toBe(false);

  const rpc = { ...request, event: 'rpc-call' as const, method: 'machine-1:workflow', params: {} };
  const rpcSignature = signExternalActionMachineRpcRequestV1({ ...rpc, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRpcRequestV1({ ...rpc, target: { ...target, project: { ...target.project, workspaceRefId: 'workspace-2' } }, signature: rpcSignature, publicKey: key.publicKey })).toBe(false);
});

it('digests the complete original V1 or opaque V2 envelope without input disclosure', () => {
  const envelope = { v: 2 as const, requestId: 'request-1', target: { kind: 'machine' as const, machineId: 'machine-1' }, payload: { t: 'encrypted' as const, c: 'opaque-ciphertext' } };
  const digest = computeExternalActionRequestEnvelopeDigestV1(envelope);
  expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(computeExternalActionRequestEnvelopeDigestV1({ ...envelope, payload: { t: 'encrypted', c: 'other' } })).not.toBe(digest);
  expect(computeExternalActionRequestEnvelopeDigestV1({ ...envelope, requestId: 'request-2' })).not.toBe(digest);
  expect(computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'request-1', target: envelope.target, input: { title: 'private' } })).not.toBe(digest);
  const projectEnvelope = { ...envelope, target: { ...envelope.target, project: { machineId: 'machine-1', directory: '/repo/a' } } };
  const projectDigest = computeExternalActionRequestEnvelopeDigestV1(projectEnvelope);
  expect(computeExternalActionRequestEnvelopeDigestV1({ ...projectEnvelope, target: { ...projectEnvelope.target, project: { ...projectEnvelope.target.project, directory: '/repo/b' } } })).not.toBe(projectDigest);
});
