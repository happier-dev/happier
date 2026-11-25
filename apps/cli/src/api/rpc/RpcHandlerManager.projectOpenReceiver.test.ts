import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { authorizeMachineRpcRequest, type MachineRpcAdmissionBoundary } from '@/api/machine/machineRpcAuthorization';
import { deriveWorkspaceSyncRelationshipId } from '@/workspaces/sync/workspaceSyncRelationshipIdentity';
import { RpcHandlerManager } from './RpcHandlerManager';

describe('Project Open writer-target ingress', () => {
  // Security review B18 N1: 93c's Open definition comparison ran only where the receiver is the
  // Open's own Machine (D). A SOURCE writer must not land a two-way prepare under D's signed one-way
  // Open at any other installed receiver either, even when Home admits the call.
  it.each([['the Open\'s own Machine', 'target'], ['another installed receiver', 'controller']] as const)(
    'refuses a forged two-way prepare under a signed one-way Open at %s', async (_name, receiver) => {
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const contentPolicy = { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) };
    // OpenProjectInputV1Schema refuses a managed destination whose controller is not the Open's own
    // Machine, so D (`target`) is also the managed target's physical controller. The other receiver is
    // any installed Machine a writer could address instead.
    const targetManaged = { managedId: 'guest', controller: { machineId: 'target', installationId: 'target-installation' } };
    // Canonical parses, as the wire carries them: the root digest binds the parsed envelope.
    const input = OpenProjectInputV1Schema.parse({ serverId: 'home', machineId: 'target',
      source: { kind: 'workspace', workspaceId: 'original', checkout: {
        serverId: 'home', workspaceId: 'original', machineId: 'source', rootPath: '/original' } },
      materialization: { kind: 'sync', targetPath: '/guest/project', targetManaged,
        workspaceAction: { kind: 'copy_once', contentPolicy } } });
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'open',
      target: { kind: 'machine', machineId: 'target' }, input });
    const sourceAdmission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'source',
      installationId: 'source-installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    // Named as the request binding at RPC admission derives it from the routed operation.
    const relationshipId = deriveWorkspaceSyncRelationshipId('materialize');
    const callerInputConstraints = { models: API_TOKEN_FULL_GRANT_V1.models, permissionModes: API_TOKEN_FULL_GRANT_V1.permissionModes };
    // The API-token root shape the B17 ingress RED used (workspaceSyncTargetAuthority.test.ts).
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-project-root', binding: {
      serverIdentityId: 'home', accountId: 'owner', principalId: 'owner', credentialId: 'project-pat', grant: API_TOKEN_FULL_GRANT_V1,
      custodianAccountId: 'owner', machineId: 'target', installationId: 'target-installation', actionId: 'projects.open', requestId: 'open',
      target: envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId('open'), sourceWorkspaceRefId: 'original', source: sourceAdmission } } });
    const source = { v: 1 as const, phase: 'prepare' as const, operationId: 'materialize', accountServerId: 'home',
      sourceMachineId: 'source', sourceRootPath: '/original', originalActionEnvelope: envelope,
      sourceContext: { machineAdmission: sourceAdmission, callerAuthority: 'account_automation' as const, callerInputConstraints } };
    // D's signed SOURCE packet, exactly as the honest writer carries it to the TARGET.
    const key = tweetnacl.sign.keyPair();
    const packetMethod = `source:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`;
    const execution = { method: packetMethod, requestId: 'transport', params: input, externalActionExecution: { v: 1 as const,
      authorization, effectActionId: 'projects.open', target: authorization.binding.target, installationId: 'target-installation',
      machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token, effectActionId: 'projects.open',
        target: authorization.binding.target, installationId: 'target-installation', method: packetMethod, requestId: 'transport',
        params: input, workspaceSyncSourceRouting: source, privateKey: key.secretKey }) } };
    const writerTarget = { v: 1 as const, source, sourceWriter: { machineId: 'source', installationId: 'source-installation' },
      target: { v: 1 as const, phase: 'prepare' as const, operationId: 'materialize', accountServerId: 'home',
        targetMachineId: 'target', targetRootPath: '/guest/project', targetManaged } };
    // Home's verification is the network boundary; here it admits every call, the worst case for this ingress.
    const boundary: MachineRpcAdmissionBoundary = { machineId: receiver, resolveInstallationId: () => `${receiver}-installation`,
      resolveCustodianAccountId: async () => 'owner', resolveHomeServerIdentityId: async () => 'home',
      verifyMachineAdmission: async () => true };
    const rpc = new RpcHandlerManager({ scopePrefix: receiver, localMachineId: receiver, encryptionMode: 'plain', logger: () => {},
      authorizeRequest: request => authorizeMachineRpcRequest(request, boundary) });
    let effects = 0;
    rpc.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE, () => { effects++; return { ok: true }; });
    const forged = await rpc.handleRequest({ method: `${receiver}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE}`,
      params: { v: 1, bootstrapOperationId: relationshipId, owner: { kind: 'relationship', relationshipId },
        transientRelationship: { v: 1, relationshipId, controllerMachineId: 'source', alphaWorkspaceRefId: 'original',
          betaWorkspaceRefId: 'target-ref', mode: 'keep_both_in_sync', contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1 },
        targetWorkspaceRefId: 'target-ref', endpointRole: 'beta', policyDigest: contentPolicy.policyDigest,
        createIfMissing: true, targetBootstrap: 'materialize_from_source_workspace' },
      machineAdmission: { ...sourceAdmission, machineId: 'target', installationId: 'target-installation' },
      callerAuthority: 'account_automation' as const, callerInputConstraints, callerInputAuthorization: authorization,
      workspaceSyncSourceExecution: execution, workspaceSyncSourceWriterTargetRouting: writerTarget });
    // Only D holds the key that opens its Open, so only D can bind a definition to it; another
    // receiver refuses at the same ingress comparison instead of skipping it.
    expect(forged, JSON.stringify(forged)).toMatchObject({ errorCode: 'RPC_FORBIDDEN',
      failureCause: { phase: 'rpc.admission.project_input_binding' } });
    expect(effects).toBe(0);
  });

  // Security review B19 A1: a Project Open into a devcontainer child Machine D takes a second hop to
  // D's physical parent P2, which Home admits under the joint target routing. P2 binds the Open to the
  // admitted child D and runs the same comparison; only D can open an encrypted Open.
  it.each([
    ['admits an honest plain Open', 'honest', 1, { ok: true }],
    ['refuses a forged two-way prepare under a plain one-way Open', 'forged', 1, { errorCode: 'RPC_FORBIDDEN',
      failureCause: { phase: 'rpc.admission.project_input_binding' } }],
    ['refuses an encrypted Open it could otherwise open', 'honest', 2, { errorCode: 'RPC_FORBIDDEN',
      failureCause: { phase: 'rpc.admission.project_input_binding' } }],
  ] as const)('at the Home-admitted physical parent of the Open\'s child Machine, %s', async (_name, prepare, version, expected) => {
    // The encrypted binding needs Home's canonical identity and a credential UUID.
    const home = 'srv_home';
    const credentialId = '22222222-2222-4222-8222-222222222222';
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const contentPolicy = { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) };
    const input = OpenProjectInputV1Schema.parse({ serverId: home, machineId: 'child',
      source: { kind: 'workspace', workspaceId: 'original', checkout: {
        serverId: home, workspaceId: 'original', machineId: 'source', rootPath: '/original' } },
      materialization: { kind: 'sync', targetPath: '/workspaces/project', workspaceAction: { kind: 'copy_once', contentPolicy } } });
    const target = { kind: 'machine' as const, machineId: 'child' };
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(19) };
    const encryptionBinding = { serverIdentityId: home, accountId: 'owner', actionId: 'projects.open', requestId: 'open',
      target, credentialId };
    const envelope = version === 1 ? ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'open', target, input })
      : sealExternalActionRequestV2({ binding: encryptionBinding, projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
        material, input, randomBytes: tweetnacl.randomBytes });
    const sourceAdmission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'source',
      installationId: 'source-installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    const childAdmission = { ...sourceAdmission, machineId: 'child', installationId: 'child-installation' };
    const relationshipId = deriveWorkspaceSyncRelationshipId('materialize');
    const callerInputConstraints = { models: API_TOKEN_FULL_GRANT_V1.models, permissionModes: API_TOKEN_FULL_GRANT_V1.permissionModes };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-project-root', binding: {
      serverIdentityId: home, accountId: 'owner', principalId: 'owner', credentialId, grant: API_TOKEN_FULL_GRANT_V1,
      custodianAccountId: 'owner', machineId: 'child', installationId: 'child-installation', actionId: 'projects.open', requestId: 'open',
      target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId('open'), sourceWorkspaceRefId: 'original', source: sourceAdmission } } });
    const sourceContext = { machineAdmission: sourceAdmission, callerAuthority: 'account_automation' as const, callerInputConstraints };
    const source = { v: 1 as const, phase: 'prepare' as const, operationId: 'materialize', accountServerId: home,
      sourceMachineId: 'source', sourceRootPath: '/original', originalActionEnvelope: envelope, sourceContext };
    const key = tweetnacl.sign.keyPair();
    const packetMethod = `source:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`;
    const execution = { method: packetMethod, requestId: 'transport', params: input, externalActionExecution: { v: 1 as const,
      authorization, effectActionId: 'projects.open', target, installationId: 'child-installation',
      machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token, effectActionId: 'projects.open',
        target, installationId: 'child-installation', method: packetMethod, requestId: 'transport',
        params: input, workspaceSyncSourceRouting: source, privateKey: key.secretKey }) } };
    const targetPhase = { v: 1 as const, phase: 'prepare' as const, operationId: 'materialize', accountServerId: home,
      targetMachineId: 'child', targetRootPath: '/workspaces/project' };
    const writerTarget = { v: 1 as const, source, sourceWriter: { machineId: 'source', installationId: 'source-installation' },
      target: targetPhase };
    // D's second hop: the joint routing carries D's own admission as the target context.
    const jointTarget = { ...targetPhase, targetContext: { ...sourceContext, machineAdmission: childAdmission } };
    // Home's verification is the network boundary; here it admits P2 as D's physical parent.
    const boundary: MachineRpcAdmissionBoundary = { machineId: 'parent', resolveInstallationId: () => 'parent-installation',
      resolveCustodianAccountId: async () => 'owner', resolveHomeServerIdentityId: async () => home,
      verifyMachineAdmission: async () => true };
    // The worst case for the encrypted Open: P2 holds material that could open it.
    const rpc = new RpcHandlerManager({ scopePrefix: 'parent', localMachineId: 'parent', encryptionMode: 'plain', logger: () => {},
      resolveExternalActionEncryption: async () => ({ serverIdentityId: home, material }),
      authorizeRequest: request => authorizeMachineRpcRequest(request, boundary) });
    let effects = 0;
    rpc.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE, () => { effects++; return { ok: true }; });
    const result = await rpc.handleRequest({ method: `parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE}`,
      params: { v: 1, ...(prepare === 'forged' ? { bootstrapOperationId: relationshipId,
        owner: { kind: 'relationship', relationshipId },
        transientRelationship: { v: 1, relationshipId, controllerMachineId: 'source', alphaWorkspaceRefId: 'original',
          betaWorkspaceRefId: 'target-ref', mode: 'keep_both_in_sync', contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1 },
      } : { bootstrapOperationId: 'materialize', owner: { kind: 'copy_once', operation: { v: 1, operationId: 'materialize', controllerMachineId: 'source',
        alphaWorkspaceRefId: 'original', betaWorkspaceRefId: 'target-ref', contentPolicy } } }),
        targetWorkspaceRefId: 'target-ref', endpointRole: 'beta', policyDigest: contentPolicy.policyDigest,
        createIfMissing: true, targetBootstrap: 'materialize_from_source_workspace' },
      machineAdmission: childAdmission, callerAuthority: 'account_automation' as const, callerInputConstraints,
      callerInputAuthorization: authorization, workspaceSyncSourceExecution: execution,
      workspaceSyncSourceWriterTargetRouting: writerTarget, workspaceSyncTargetRouting: jointTarget });
    expect(result, JSON.stringify(result)).toMatchObject(expected);
    expect(effects).toBe('ok' in expected ? 1 : 0);
  });
});
