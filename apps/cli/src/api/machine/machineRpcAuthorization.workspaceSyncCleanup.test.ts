import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { WorkspaceSyncSourceWriterTargetRoutingV1Schema } from '@happier-dev/protocol/socketRpc';
import { deriveWorkspaceSyncRelationshipId, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';

import { authorizeMachineRpcRequest, type MachineRpcAdmissionBoundary } from './machineRpcAuthorization';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

describe('retained Workspace Sync SOURCE writer cleanup admission', () => {
  it('retains finite admission through callbacks, stops on disconnect, and admits the next peer request anew', async () => {
    let homeReads = 0;
    const admission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'target',
      installationId: 'target-installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    const boundary: MachineRpcAdmissionBoundary = { machineId: admission.machineId,
      resolveInstallationId: () => admission.installationId, resolveCustodianAccountId: async () => admission.custodianAccountId,
      resolveHomeServerIdentityId: async () => 'home', verifyMachineAdmission: async () => { homeReads++; return true; } };
    const manager = new RpcHandlerManager({ scopePrefix: admission.machineId, localMachineId: admission.machineId,
      scopeKind: 'machine', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, boundary, source) });
    let ready!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    let resume!: () => void;
    const continuation = new Promise<void>(resolve => { resume = resolve; });
    const observed: boolean[] = [];
    manager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE, async (_request, context) => {
      if (!context?.verifyMachineAdmissionCurrent) throw new Error('Missing admitted lifecycle');
      observed.push(await context.verifyMachineAdmissionCurrent(), await context.verifyMachineAdmissionCurrent());
      ready();
      await continuation;
      observed.push(await context.verifyMachineAdmissionCurrent());
      return { ok: true };
    });
    const request = { method: `${admission.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE}`,
      params: { v: 1, bootstrapOperationId: 'operation', targetWorkspaceRefId: 'accepted-target', reason: 'relationship_committed' },
      machineAdmission: admission, callerAuthority: 'account_automation' as const };
    const running = manager.handleRequest(request);
    try {
      await Promise.race([entered, running.then(result => { throw new Error(`Cleanup handler was not admitted: ${JSON.stringify(result)}`); })]);
      expect(homeReads).toBe(1);
      manager.onSocketDisconnect();
    } finally { resume(); }
    await running;
    expect(observed).toEqual([true, true, false]);
    expect(homeReads).toBe(1);
    manager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE, async () => ({ ok: true }));
    await manager.handleRequest(request);
    expect(homeReads).toBe(2);
  });

  it('admits only exact release after Home admission and retains fresh peer verification', async () => {
    const admission = { actorAccountId: 'source-owner', custodianAccountId: 'source-owner',
      machineId: 'source-writer', installationId: 'source-installation', role: 'manage' as const,
      encryptionMode: 'plain' as const };
    const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1,
      sourceWriter: { machineId: admission.machineId, installationId: admission.installationId },
      source: { v: 1, phase: 'prepare', operationId: 'approved-action', accountServerId: 'home',
        sourceMachineId: admission.machineId, sourceRootPath: '/source', sourceContext: {
          machineAdmission: { ...admission, actorAccountId: 'borrower' }, callerAuthority: 'account_automation', workspaceWrites: 'allow' } },
      target: { v: 1, phase: 'release', operationId: 'approved-action', accountServerId: 'home',
        targetMachineId: 'target-writer', targetRootPath: '/target' } });
    const request = { method: `target-writer:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE}`,
      params: { v: 1, bootstrapOperationId: deriveWorkspaceSyncRelationshipId('approved-action'), targetWorkspaceRefId: 'accepted-target', reason: 'relationship_committed' },
      machineAdmission: admission, callerAuthority: 'account_automation' as const, workspaceSyncSourceWriterTargetRouting: routing };
    let current = true;
    let homeReads = 0;
    const boundary: MachineRpcAdmissionBoundary = { machineId: 'target-writer', resolveInstallationId: () => 'target-installation',
      resolveCustodianAccountId: async () => 'target-owner', resolveHomeServerIdentityId: async () => 'home',
      verifyMachineAdmission: async () => { homeReads++; return current; } };
    expect(await authorizeMachineRpcRequest(request, boundary, 'authenticated_home_socket')).toEqual({ ok: true });
    expect(homeReads).toBe(0);
    expect(await authorizeMachineRpcRequest(request, boundary)).toEqual({ ok: true });
    expect(homeReads).toBe(1);
    current = false;
    expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, admissionPredicate: 'machine_currentness' });
    expect(homeReads).toBe(2);
    for (const machineAdmission of [
      { ...admission, machineId: 'forged-source' },
      { ...admission, installationId: 'forged-installation' },
      { ...admission, actorAccountId: 'borrower' },
    ]) expect(await authorizeMachineRpcRequest({ ...request, machineAdmission }, boundary, 'authenticated_home_socket')).toMatchObject({ ok: false });
    expect(await authorizeMachineRpcRequest({ ...request,
      method: `target-writer:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE}`,
    }, boundary, 'authenticated_home_socket')).toMatchObject({ ok: false });
  });

  it('keeps native isolation for a non-release phase on the same signed transport', async () => {
    const target = { actorAccountId: 'borrower', custodianAccountId: 'target-owner', machineId: 'target-writer',
      installationId: 'target-installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'handoff-root', binding: {
      accountId: 'borrower', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      custodianAccountId: 'source-owner', serverIdentityId: 'home', machineId: 'source-writer', installationId: 'source-installation',
      actionId: 'session.handoff', requestId: 'approved-action', requestEnvelopeDigest: 'A'.repeat(43),
      target: { kind: 'machine', machineId: 'source-writer' }, handoffAdmission: { sessionId: 'source-session',
        sourceMachineId: 'source-writer', sourceInstallationId: 'source-installation',
        targetMachineId: target.machineId, targetInstallationId: target.installationId } } });
    const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1,
      sourceWriter: { machineId: 'source-writer', installationId: 'source-installation' },
      source: { v: 1, phase: 'prepare', operationId: root.binding.requestId, accountServerId: 'home',
        sourceMachineId: 'source-writer', sourceRootPath: '/source', sourceSessionId: 'source-session', sourceContext: {
          machineAdmission: { ...target, custodianAccountId: 'source-owner', machineId: 'source-writer', installationId: 'source-installation' },
          callerAuthority: 'account_automation', workspaceWrites: 'allow' } },
      target: { v: 1, phase: 'prepare', operationId: root.binding.requestId, accountServerId: 'home',
        targetMachineId: target.machineId, targetRootPath: '/target' } });
    const selection = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const contentPolicy = { ...selection, policyDigest: computeWorkspaceSyncPolicyDigest(selection) };
    const relationshipId = deriveWorkspaceSyncRelationshipId(root.binding.requestId);
    const params = { v: 1, bootstrapOperationId: relationshipId, owner: { kind: 'relationship', relationshipId },
      transientRelationship: { v: 1, relationshipId, controllerMachineId: 'source-writer', alphaWorkspaceRefId: 'source-ref',
        betaWorkspaceRefId: 'target-ref', mode: 'keep_both_in_sync', contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1 },
      targetWorkspaceRefId: 'target-ref', endpointRole: 'beta', policyDigest: contentPolicy.policyDigest,
      createIfMissing: true, targetBootstrap: 'materialize_from_source_workspace' };
    const boundary: MachineRpcAdmissionBoundary = { machineId: target.machineId, resolveInstallationId: () => target.installationId,
      resolveCustodianAccountId: async () => target.custodianAccountId, resolveHomeServerIdentityId: async () => 'home',
      verifyMachineAdmission: async () => true };
    expect(await authorizeMachineRpcRequest({ method: `${target.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE}`,
      params, machineAdmission: target, callerAuthority: 'account_automation', callerInputAuthorization: root,
      workspaceSyncSourceWriterTargetRouting: routing }, boundary, 'authenticated_home_socket'))
      .toMatchObject({ ok: false, errorCode: 'agent_isolation_unavailable' });
  });
});
