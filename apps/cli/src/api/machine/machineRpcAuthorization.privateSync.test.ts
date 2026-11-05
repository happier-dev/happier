import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createWorkspaceSyncHandoffAdapter, type WorkspaceSyncPrivateExecution } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import { WorkspaceSyncController } from '@/workspaces/sync/workspaceSyncController';
import { createWorkspaceSyncMutagenAdapter } from '@/workspaces/sync/workspaceSyncMutagenAdapter';
import { createWorkspaceRootOwnershipManager } from '@/workspaces/sync/workspaceSyncRootOwnership';
import { deriveWorkspaceSyncRelationshipId } from '@/workspaces/sync/workspaceSyncRelationshipIdentity';
import { authorizeMachineRpcRequest, type MachineRpcAdmissionBoundary } from './machineRpcAuthorization';
import { resolvePrivateWorkspaceSyncTargetExecution, registerMachineWorkspaceSyncRpcHandlers } from './rpcHandlers.workspaceSync';

const admission = { actorAccountId: 'requester', custodianAccountId: 'owner', machineId: 'target',
  installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const };
const method = RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT;
const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
const retainedInput = { operationId: 'open', accountServerId: 'home', sourceMachineId: 'source', targetMachineId: 'target',
  sourceWorkspaceRefId: 'source-ref', targetWorkspaceRefId: 'target-ref', sourceRootPath: '/source', targetRootPath: '/member/copy',
  action: { kind: 'copy_once' as const, contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) } } };
const routing = { v: 1 as const, phase: 'preflight' as const, operationId: 'open', accountServerId: 'home',
  targetMachineId: 'target', targetRootPath: '/member/copy', targetContext: { machineAdmission: admission,
    callerAuthority: 'present_user' as const, workspaceWrites: 'allow' as const } };
const request = { method: `target:${method}`, params: { v: 1, serverId: 'home', machineId: 'target', operationId: 'open',
  targetPath: '/member/copy' }, machineAdmission: admission, callerAuthority: 'present_user' as const,
  workspaceSyncTargetRouting: routing };

describe('private Project Sync ingress', () => {
  it('routes a current member phase through the real retained capture and keeps raw, foreign and retired requests closed', async () => {
    await withTempDir('private-sync-ingress-', async directory => {
      const unexpected = async (): Promise<never> => { throw new Error('Unexpected native effect'); };
      const sync = new WorkspaceSyncController({ localMachineId: 'target', localServerId: 'home',
        resolveWorkspaceRef: () => null,
        adapter: createWorkspaceSyncMutagenAdapter({ resolveWorkspaceRef: () => null,
          // Mutagen is an external process boundary, unused by capture lookup.
          send: unexpected }),
        lifecycle: { start: unexpected, stop: async () => undefined },
        rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(directory, 'locks') }) });
      const adapter = createWorkspaceSyncHandoffAdapter({ sync, bootstrap: unexpected });
      let effects = 0;
      let recoveries = 0;
      let hostEffects = 0;
      let hostRecoveries = 0;
      let boundTargetContext: RpcHandlerContext | undefined;
      const execution: WorkspaceSyncPrivateExecution = {
        credentials: { token: 'requester-token', encryption: null },
        accountRowsCustody: { serverId: 'home', accountId: 'requester', serverHttpBaseUrl: 'https://home.invalid',
          isCurrent: unexpected },
        executionIdentity: { kind: 'isolated', separationRequired: true,
          requester: { serverId: 'local-profile', accountId: 'requester', machineId: 'target', installationId: 'installation' } },
        // The same-binary member process is the native OS boundary. No
        // requester selection, Home read or Account permission check runs here.
        nativeSync: { preflightHandoffTargetReplacementHere: async () => { effects++; return { type: 'not_required' }; },
          prepareBootstrapHere: async request => { effects++; return { v: 1, bootstrapOperationId: request.bootstrapOperationId, targetWorkspaceRefId: 'target-ref',
            state: 'ready', created: true, rootFingerprint: '0'.repeat(64), policyDigest: retainedInput.action.contentPolicy.policyDigest }; },
          releaseBootstrapHere: async () => { effects++; return { ok: true, released: true }; }, acquireWorkspaceSyncMachineIngress: unexpected,
          prepareBootstrapAtTarget: unexpected, borrowSourceRootForCopy: unexpected, openLocalWorkspaceAgentIngress: unexpected,
          resolveLocalRoot: unexpected, acquireLocalRoot: unexpected,
          reconcileRetainedBootstraps: unexpected, releaseAllRetainedBootstraps: unexpected,
          recoverConflictResolutionHere: async () => { recoveries++; return { status: 'settled' }; },
          readFileHere: unexpected, observeEntryHere: unexpected, replaceSnapshot: unexpected,
          inspectCheckout: unexpected, dispose: async () => undefined },
        bindTargetPhaseContext: context => { boundTargetContext = context; },
        recoverConflictResolutionHere: (request, signal) => execution.nativeSync!.recoverConflictResolutionHere(request, signal),
        assertTransferCurrent: unexpected,
        release: async () => undefined,
      };
      adapter.retainPrivateExecution!({ input: retainedInput, execution });
      let home = 'home';
      let installation = 'installation';
      let current = true;
      const boundary: MachineRpcAdmissionBoundary = { machineId: 'target', resolveInstallationId: () => installation,
        resolveCustodianAccountId: async () => 'owner', resolveHomeServerIdentityId: async () => home,
        // Authenticated Home is the external admission boundary.
        verifyMachineAdmission: async () => current,
        resolvePrivateWorkspaceSyncTargetExecution: input => resolvePrivateWorkspaceSyncTargetExecution(adapter, input) };
      const rpc = new RpcHandlerManager({ scopePrefix: 'target', localMachineId: 'target', encryptionMode: 'plain', logger: () => {},
        authorizeRequest: incoming => authorizeMachineRpcRequest(incoming, boundary) });
      registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: rpc, service: {
        controller: sync, prepareBetween: unexpected,
        relationshipOwner: { setEnabled: unexpected, stop: unexpected, create: unexpected },
        readFileAtTarget: unexpected, observeEntryAtTarget: unexpected, inspectRetiredState: unexpected,
        preflightHandoffTargetReplacement: async () => { hostEffects++; return { type: 'not_required' }; },
        prepareBootstrapAtTarget: unexpected, releaseBootstrapAtTarget: unexpected,
        recoverConflictResolutionAtTarget: async () => { hostRecoveries++; return { status: 'settled' }; },
      } });
      await expect(rpc.handleRequest(request)).resolves.toEqual({ type: 'not_required' });
      expect(effects).toBe(1);
      const isolated = { errorCode: 'agent_isolation_unavailable' };
      await expect(rpc.handleRequest({ ...request, workspaceSyncTargetRouting: undefined })).resolves.toMatchObject(isolated);
      const foreignAdmission = { ...admission, actorAccountId: 'foreign' };
      await expect(rpc.handleRequest({ ...request, machineAdmission: foreignAdmission,
        workspaceSyncTargetRouting: { ...routing, targetContext: { ...routing.targetContext, machineAdmission: foreignAdmission } } }))
        .resolves.toMatchObject(isolated);
      await expect(rpc.handleRequest({ ...request, params: { ...request.params, targetPath: '/foreign' },
        workspaceSyncTargetRouting: { ...routing, targetRootPath: '/foreign' } })).resolves.toMatchObject(isolated);
      await expect(rpc.handleRequest({ ...request, params: { ...request.params, serverId: 'foreign-home' },
        workspaceSyncTargetRouting: { ...routing, accountServerId: 'foreign-home' } })).resolves.toMatchObject(isolated);
      installation = 'replacement';
      await expect(rpc.handleRequest(request)).resolves.toMatchObject(isolated);
      installation = 'installation'; current = false;
      await expect(rpc.handleRequest(request)).resolves.toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      current = true;
      const prepare = { ...request, method: `target:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE}`,
        workspaceSyncTargetRouting: { ...routing, phase: 'prepare' as const }, params: { v: 1, bootstrapOperationId: 'open',
          owner: { kind: 'copy_once', operation: { v: 1, operationId: 'open', controllerMachineId: 'source',
            alphaWorkspaceRefId: 'source-ref', betaWorkspaceRefId: 'target-ref', contentPolicy: retainedInput.action.contentPolicy } },
          targetWorkspaceRefId: 'target-ref', endpointRole: 'beta', policyDigest: retainedInput.action.contentPolicy.policyDigest,
          createIfMissing: true, targetBootstrap: 'materialize_from_source_workspace' } };
      await expect(rpc.handleRequest(prepare)).resolves.toMatchObject({ state: 'ready' });
      expect(boundTargetContext?.workspaceSyncTargetRouting).toEqual(prepare.workspaceSyncTargetRouting);
      await expect(rpc.handleRequest({ ...prepare, params: { ...prepare.params, owner: { ...prepare.params.owner,
        operation: { ...prepare.params.owner.operation, operationId: 'foreign-open' } } } })).resolves.toMatchObject(isolated);
      await expect(rpc.handleRequest({ ...prepare, params: { ...prepare.params, targetWorkspaceRefId: 'foreign-ref' } }))
        .resolves.toMatchObject(isolated);
      await expect(rpc.handleRequest({ ...request, method: `target:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE}`,
        workspaceSyncTargetRouting: { ...routing, phase: 'release' },
        params: { v: 1, bootstrapOperationId: 'open', targetWorkspaceRefId: 'target-ref', reason: 'copy_committed' } }))
        .resolves.toEqual({ ok: true, released: true });
      expect(effects).toBe(3);
      await adapter.releasePrivateExecution!('open');
      // A signed incumbent target without a private capture keeps its native owner.
      await expect(authorizeMachineRpcRequest(request, boundary)).resolves.toEqual({ ok: true });
      adapter.retainPrivateExecution!({ input: retainedInput, execution: { ...execution, nativeSync: undefined } });
      await expect(rpc.handleRequest(request)).resolves.toMatchObject(isolated);
      expect(hostEffects).toBe(0);
      await adapter.releasePrivateExecution!('open');
      const ownerAdmission = { ...admission, actorAccountId: 'owner', role: 'manage' as const };
      await expect(rpc.handleRequest({ ...request, workspaceSyncTargetRouting: undefined, machineAdmission: ownerAdmission }))
        .resolves.toEqual({ type: 'not_required' });
      expect(hostEffects).toBe(1);
      // Installed direct dispatch consumes the same admission result as socket ingress.
      adapter.retainPrivateExecution!({ input: retainedInput, execution });
      const admittedLocal = await authorizeMachineRpcRequest(request, boundary);
      if (!admittedLocal.ok) throw new Error('Expected admitted private target');
      await expect(rpc.invokeLocal(method, request.params, { admissionResult: admittedLocal }))
        .resolves.toEqual({ type: 'not_required' });
      await adapter.releasePrivateExecution!('open');
      expect(effects).toBe(4);
      const relationshipId = deriveWorkspaceSyncRelationshipId('open');
      const relationshipInput = { ...retainedInput, action: { kind: 'create_relationship' as const, mode: 'keep_synced' as const,
        contentPolicy: retainedInput.action.contentPolicy, flushBeforeCommit: true as const } };
      adapter.retainPrivateExecution!({ input: relationshipInput, execution });
      const relationship = { v: 1 as const, relationshipId, controllerMachineId: 'source', alphaWorkspaceRefId: 'source-ref',
        betaWorkspaceRefId: 'target-ref', mode: 'keep_synced' as const, contentPolicy: retainedInput.action.contentPolicy,
        enabled: true, createdAtMs: 1, updatedAtMs: 1 };
      const relationshipPrepare = { ...prepare, params: { ...prepare.params, bootstrapOperationId: relationshipId,
        owner: { kind: 'relationship', relationshipId }, transientRelationship: relationship } };
      const recover = { method: `target:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_RECOVER}`,
        params: { relationshipId, targetMachineId: 'target', targetWorkspaceRefId: 'target-ref' },
        machineAdmission: admission, callerAuthority: 'account_automation' as const };
      const managedRecover = { ...recover, machineAdmission: { ...admission, role: 'manage' as const } };
      // An unbound finite Open capture cannot authorize a relationship call.
      await expect(rpc.handleRequest(recover)).resolves.toMatchObject(isolated);
      await expect(rpc.handleRequest(managedRecover)).resolves.toMatchObject(isolated);
      await expect(rpc.handleRequest(relationshipPrepare)).resolves.toMatchObject({ state: 'ready', bootstrapOperationId: relationshipId });
      expect(adapter.resolvePrivateExecution!({ relationshipId })?.input.operationId).toBe('open');
      // Initial ensure is still in Open: canonical signed prepare bound this
      // relationship before it asks its remote member to settle recovery.
      await expect(rpc.handleRequest(recover)).resolves.toEqual({ status: 'settled' });
      await expect(rpc.handleRequest(managedRecover)).resolves.toEqual({ status: 'settled' });
      adapter.retainPrivateExecution!({ input: relationshipInput, execution, phase: 'relationship' });
      await expect(rpc.handleRequest(recover)).resolves.toEqual({ status: 'settled' });
      await expect(rpc.handleRequest({ ...recover, machineAdmission: foreignAdmission })).resolves.toMatchObject(isolated);
      await expect(rpc.handleRequest({ ...recover, params: { ...recover.params, targetWorkspaceRefId: 'foreign-ref' } }))
        .resolves.toMatchObject(isolated);
      await expect(rpc.handleRequest({ ...recover, params: { ...recover.params, relationshipId: 'foreign-relation' } }))
        .resolves.toMatchObject(isolated);
      await expect(rpc.handleRequest({ ...recover, params: { ...recover.params, rootPath: '/foreign' } }))
        .resolves.toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      home = 'foreign-home';
      await expect(rpc.handleRequest(recover)).resolves.toMatchObject(isolated);
      home = 'home';
      installation = 'replacement';
      await expect(rpc.handleRequest(recover)).resolves.toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      installation = 'installation';
      current = false;
      await expect(rpc.handleRequest(recover)).resolves.toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      current = true;
      expect(recoveries).toBe(3);
      await expect(rpc.handleRequest({ ...relationshipPrepare,
        params: { ...relationshipPrepare.params, bootstrapOperationId: 'open' } })).resolves.toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      await expect(rpc.handleRequest({ ...relationshipPrepare,
        params: { ...relationshipPrepare.params, transientRelationship: { ...relationship, alphaWorkspaceRefId: 'foreign-source' } } }))
        .resolves.toMatchObject(isolated);
      await expect(rpc.handleRequest({ ...relationshipPrepare,
        params: { ...relationshipPrepare.params, bootstrapOperationId: 'foreign-relationship' } }))
        .resolves.toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      // A raw operation id cannot recreate the admitted signed route.
      await expect(rpc.handleRequest({ ...relationshipPrepare, workspaceSyncTargetRouting: undefined })).resolves.toMatchObject(isolated);
      const { transientRelationship: _transient, targetBootstrap: _bootstrap, ...retainedParams } = relationshipPrepare.params;
      const reconnect = { ...relationshipPrepare, workspaceSyncTargetRouting: undefined,
        params: { ...retainedParams, createIfMissing: false } };
      await expect(rpc.handleRequest(reconnect)).resolves.toMatchObject(isolated);
      await adapter.releasePrivateExecution!('open');
      await expect(rpc.handleRequest(recover)).resolves.toMatchObject(isolated);
      expect(recoveries).toBe(3);
      const coldInput = { ...retainedInput, operationId: relationshipId,
        action: { kind: 'relationship' as const, relationshipId, flushBeforeCommit: false } };
      adapter.retainPrivateExecution!({ input: coldInput, execution });
      await adapter.bindPrivateExecutionRelationship!(relationshipId, relationshipId);
      await expect(rpc.handleRequest(recover)).resolves.toMatchObject(isolated);
      adapter.retainPrivateExecution!({ input: coldInput, execution, phase: 'relationship' });
      await expect(rpc.handleRequest(recover)).resolves.toEqual({ status: 'settled' });
      await adapter.releasePrivateExecution!(relationshipId);
      const foreignColdInput = { ...coldInput, action: { ...coldInput.action, relationshipId: 'foreign-relation' } };
      adapter.retainPrivateExecution!({ input: foreignColdInput, execution, phase: 'relationship' });
      await adapter.bindPrivateExecutionRelationship!(relationshipId, relationshipId);
      await expect(rpc.handleRequest(recover)).resolves.toMatchObject(isolated);
      await adapter.releasePrivateExecution!(relationshipId);
      adapter.retainPrivateExecution!({ input: relationshipInput,
        execution: { ...execution, recoverConflictResolutionHere: undefined }, phase: 'relationship' });
      await adapter.bindPrivateExecutionRelationship!('open', relationshipId);
      await expect(rpc.handleRequest(recover)).resolves.toMatchObject(isolated);
      await adapter.releasePrivateExecution!('open');
      adapter.retainPrivateExecution!({ input: relationshipInput,
        execution: { ...execution, nativeSync: undefined }, phase: 'relationship' });
      await adapter.bindPrivateExecutionRelationship!('open', relationshipId);
      await expect(rpc.handleRequest(recover)).resolves.toMatchObject(isolated);
      await adapter.releasePrivateExecution!('open');
      expect(recoveries).toBe(4);
      expect(hostRecoveries).toBe(0);
      await expect(rpc.handleRequest({ ...recover, machineAdmission: ownerAdmission })).resolves.toEqual({ status: 'settled' });
      expect(hostRecoveries).toBe(1);
      await expect(rpc.handleRequest(relationshipPrepare)).resolves.toMatchObject(isolated);
      await expect(rpc.handleRequest(reconnect)).resolves.toMatchObject(isolated);
      expect(effects).toBe(5);
      expect(hostEffects).toBe(1);
    });
  });
});
