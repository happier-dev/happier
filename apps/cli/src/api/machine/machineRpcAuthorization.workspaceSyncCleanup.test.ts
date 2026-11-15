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
      encryptionMode: 'plain', logger: () => {},
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

  it.each(['release', 'inspect'] as const)('admits only exact %s after Home admission and retains fresh peer verification', async phase => {
    const admission = { actorAccountId: 'source-owner', custodianAccountId: 'source-owner',
      machineId: 'source-writer', installationId: 'source-installation', role: 'manage' as const,
      encryptionMode: 'plain' as const };
    const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1,
      sourceWriter: { machineId: admission.machineId, installationId: admission.installationId },
      source: { v: 1, phase: 'prepare', operationId: 'approved-action', accountServerId: 'home',
        sourceMachineId: admission.machineId, sourceRootPath: '/source', sourceContext: {
          machineAdmission: { ...admission, actorAccountId: 'borrower' }, callerAuthority: 'account_automation', workspaceWrites: 'allow' } },
      target: { v: 1, phase, operationId: 'approved-action', accountServerId: 'home',
        targetMachineId: 'target-writer', targetRootPath: '/target' } });
    const selection = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const preview = { kind: 'preview', workspace: { serverId: 'home', refId: 'source-ref' }, machineId: admission.machineId,
      targetMachineId: 'target-writer', targetWorkspaceRefId: 'accepted-target', expectedRelationship: {
        v: 1, relationshipId: deriveWorkspaceSyncRelationshipId('approved-action'), controllerMachineId: admission.machineId,
        alphaWorkspaceRefId: 'source-ref', betaWorkspaceRefId: 'accepted-target', mode: 'keep_synced', enabled: false,
        createdAtMs: 1, updatedAtMs: 2, contentPolicy: { ...selection, policyDigest: computeWorkspaceSyncPolicyDigest(selection) },
      } };
    const request = { method: `target-writer:${phase === 'inspect' ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT : RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE}`,
      params: phase === 'inspect' ? preview : { v: 1, bootstrapOperationId: deriveWorkspaceSyncRelationshipId('approved-action'), targetWorkspaceRefId: 'accepted-target', reason: 'relationship_committed' },
      machineAdmission: admission, callerAuthority: 'account_automation' as const, workspaceSyncSourceWriterTargetRouting: routing };
    let current = true;
    let homeReads = 0;
    const boundary: MachineRpcAdmissionBoundary = { machineId: 'target-writer', resolveInstallationId: () => 'target-installation',
      resolveCustodianAccountId: async () => 'target-owner', resolveHomeServerIdentityId: async () => 'home',
      verifyMachineAdmission: async () => { homeReads++; return current; } };
    expect(await authorizeMachineRpcRequest(request, boundary, 'authenticated_home_socket')).toEqual({ ok: true });
    expect(homeReads).toBe(0);
    const manager = new RpcHandlerManager({ scopePrefix: boundary.machineId, localMachineId: boundary.machineId,
      encryptionMode: 'plain', logger: () => {},
      authorizeRequest: (incoming, source) => authorizeMachineRpcRequest(incoming, boundary, source) });
    manager.registerHandler(phase === 'inspect' ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT
      : RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE, async () => ({ admitted: true }));
    expect(await manager.handleRequest(request, undefined, 'authenticated_home_socket')).toEqual({ admitted: true });
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
    if (phase === 'inspect') {
      for (const params of [
        { ...preview, expectedRelationship: { ...preview.expectedRelationship, relationshipId: 'foreign-relationship' } },
        { ...preview, expectedRelationship: { ...preview.expectedRelationship, controllerMachineId: 'foreign-controller' } },
        { ...preview, targetMachineId: 'foreign-target' },
        { ...preview, targetWorkspaceRefId: 'foreign-ref' },
        { ...preview, workspace: { ...preview.workspace, serverId: 'foreign-home' } },
        { ...preview, workspace: { ...preview.workspace, refId: 'foreign-source' } },
        { ...preview, rootPath: '/caller-selected-root' },
        { actionReceiptId: 'receipt', actionInput: {} },
      ]) expect(await authorizeMachineRpcRequest({ ...request, params }, boundary, 'authenticated_home_socket')).toMatchObject({ ok: false });
      expect(await authorizeMachineRpcRequest({ ...request, params: {
        ...preview, expectedRelationship: { ...preview.expectedRelationship, relationshipId: 'approved-action' },
      } }, boundary, 'authenticated_home_socket')).toEqual({ ok: true });
      expect(await authorizeMachineRpcRequest({ ...request,
        method: `target-writer:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_REMOVE}`,
      }, boundary, 'authenticated_home_socket')).toMatchObject({ ok: false });
      expect(await authorizeMachineRpcRequest({ ...request, workspaceSyncSourceWriterTargetRouting: undefined,
        machineAdmission: { ...admission, actorAccountId: 'borrower' },
      }, boundary, 'authenticated_home_socket')).toMatchObject({ ok: false });
      const targetAdmission = { ...admission, machineId: boundary.machineId,
        installationId: 'target-installation', actorAccountId: 'target-owner', custodianAccountId: 'target-owner' };
      const workspaceSyncTargetRouting = { ...routing.target, targetContext: {
        ...routing.source.sourceContext, machineAdmission: targetAdmission,
      } };
      expect(await authorizeMachineRpcRequest({ ...request, workspaceSyncTargetRouting }, boundary,
        'authenticated_home_socket')).toMatchObject({ ok: false });
      expect(await authorizeMachineRpcRequest({ ...request, workspaceSyncSourceWriterTargetRouting: undefined,
        workspaceSyncTargetRouting, machineAdmission: targetAdmission,
      }, boundary, 'authenticated_home_socket')).toMatchObject({ ok: false });
    }
  });

  // Owner ruling 2026-11-15: without the requester's own member capture, a Can use
  // writer-target phase is refused with the typed Manage cause before any effect.
  it('refuses a Can use non-release phase without a member capture on the same signed transport', async () => {
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
      .toMatchObject({ ok: false, errorCode: 'machine_manage_required' });
  });
});
