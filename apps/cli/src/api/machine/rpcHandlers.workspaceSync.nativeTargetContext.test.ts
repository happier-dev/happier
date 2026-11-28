import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import {
  WorkspaceSyncSourceExecutionV1Schema,
  WorkspaceSyncSourceRoutingV1Schema,
  WorkspaceSyncSourceWriterTargetRoutingV1Schema,
  WorkspaceSyncTargetRoutingV1Schema,
} from '@happier-dev/protocol/socketRpc';
import { createExternalActionMachineRpcExecution } from '@/api/externalActionExecutionAuthorization';
import { deriveWorkspaceSyncRelationshipId } from '@/workspaces/sync/workspaceSyncRelationshipIdentity';
import type { PrivateProjectNativeSync } from '@/workspaces/activation/privateProjectSyncEffect';
import type { RpcHandler, RpcHandlerContext, RpcHandlerRegistrar } from '../rpc/types';

import {
  registerMachineWorkspaceSyncRpcHandlers,
  type MachineWorkspaceSyncRpcService,
} from './rpcHandlers.workspaceSync';

function createRegistrar() {
  const handlers = new Map<string, (raw: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
  const rpcHandlerManager = {
    registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
      handlers.set(method, async (raw: unknown, context?: RpcHandlerContext) => await handler(raw as TRequest, context));
    },
  } satisfies RpcHandlerRegistrar;
  return { handlers, rpcHandlerManager };
}

function createUnusedService(): MachineWorkspaceSyncRpcService {
  return {
    controller: {
      get: vi.fn(),
      list: vi.fn(),
      watchStatuses: vi.fn(),
      flush: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      terminate: vi.fn(),
      listConflicts: vi.fn(),
      listRelationships: vi.fn(),
      inspectConflict: vi.fn(),
      resolveConflict: vi.fn(),
      readFile: vi.fn(),
    },
    relationshipOwner: { setEnabled: vi.fn(), stop: vi.fn(), create: vi.fn() },
    prepareBetween: vi.fn(),
    readFileAtTarget: vi.fn(),
    observeEntryAtTarget: vi.fn(),
    preflightHandoffTargetReplacement: vi.fn(),
    prepareBootstrapAtTarget: vi.fn(),
    releaseBootstrapAtTarget: vi.fn(),
    inspectRetiredState: vi.fn(),
  };
}

describe('workspace sync native target context projection', () => {
  it('forwards workspaceSyncSourceExecution into native target preflight, prepare, and release without leaking host-only context', async () => {
    const { handlers, rpcHandlerManager } = createRegistrar();
    const service = createUnusedService();
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager, service });

    const serverId = 'server-1';
    const operationId = 'open-project-op-1';
    const relationshipId = deriveWorkspaceSyncRelationshipId(operationId);
    const sourceRoot = '/source/workspace';
    const targetRoot = '/member/workspace/target';
    const policy = {
      v: 1 as const,
      selection: 'all_files' as const,
      extraIgnorePatterns: [],
      extraIncludePatterns: [],
    };
    const contentPolicy = {
      ...policy,
      policyDigest: computeWorkspaceSyncPolicyDigest(policy),
    };
    const machineAdmission = (machineId: string) => ({
      machineId,
      installationId: `installation-${machineId}`,
      actorAccountId: 'requester-account',
      custodianAccountId: 'custodian-account',
      role: 'manage' as const,
      encryptionMode: 'plain' as const,
    });
    const envelope = {
      v: 1 as const,
      requestId: operationId,
      target: { kind: 'machine' as const, machineId: 'target-machine' },
      input: {
        source: { kind: 'workspace' as const, workspaceId: 'workspace-source' },
        materialization: {
          kind: 'sync' as const,
          mode: 'copy_once' as const,
          targetMachineId: 'target-machine',
          targetPath: targetRoot,
        },
      },
    };
    const callerInputAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({
      v: 1,
      token: 'signed-projects-open-token',
      binding: {
        accountId: 'requester-account',
        authentication: { kind: 'account', tokenEpoch: 1 },
        accountEncryptionMode: 'plain',
        serverIdentityId: serverId,
        actionId: 'projects.open',
        machineId: 'target-machine',
        installationId: 'installation-target-machine',
        custodianAccountId: 'custodian-account',
        requestId: operationId,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        target: envelope.target,
        workspaceSyncAdmission: {
          relationshipId,
          sourceWorkspaceRefId: 'workspace-source',
          source: machineAdmission('source-machine'),
        },
      },
    });
    const sourceRouting = WorkspaceSyncSourceRoutingV1Schema.parse({
      v: 1,
      phase: 'prepare',
      operationId,
      accountServerId: serverId,
      sourceMachineId: 'source-machine',
      sourceRootPath: sourceRoot,
      originalActionEnvelope: envelope,
      sourceContext: {
        machineAdmission: machineAdmission('source-machine'),
        callerAuthority: 'present_user',
        workspaceWrites: 'allow',
      },
    });
    const keyPair = tweetnacl.sign.keyPair();
    const sourceMethod = `source-machine:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`;
    const workspaceSyncSourceExecution = WorkspaceSyncSourceExecutionV1Schema.parse({
      method: sourceMethod,
      requestId: 'admitted-source-call-1',
      params: { operationId },
      externalActionExecution: createExternalActionMachineRpcExecution({
        context: {
          externalActionExecutionAuthorization: callerInputAuthorization,
          externalActionTarget: envelope.target,
        },
        effectActionId: 'projects.open',
        installationId: 'installation-source-machine',
        method: sourceMethod,
        requestId: 'admitted-source-call-1',
        params: { operationId },
        workspaceSyncSourceRouting: sourceRouting,
        privateKey: keyPair.secretKey,
      }),
    });
    const writerTargetFor = (phase: 'preflight' | 'prepare' | 'release') => WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({
      v: 1,
      sourceWriter: { machineId: 'source-machine', installationId: 'installation-source-machine' },
      source: sourceRouting,
      target: {
        v: 1,
        phase,
        operationId,
        accountServerId: serverId,
        targetMachineId: 'target-machine',
        targetRootPath: targetRoot,
      },
    });
    const targetRoutingFor = (phase: 'preflight' | 'prepare' | 'release') => WorkspaceSyncTargetRoutingV1Schema.parse({
      v: 1,
      phase,
      operationId,
      accountServerId: serverId,
      targetMachineId: 'target-machine',
      targetRootPath: targetRoot,
      targetContext: {
        machineAdmission: machineAdmission('target-machine'),
        callerAuthority: 'present_user',
        workspaceWrites: 'allow',
      },
    });

    const preflightHandoffTargetReplacementHere = vi.fn<PrivateProjectNativeSync['preflightHandoffTargetReplacementHere']>(
      async () => ({ type: 'not_required' as const }),
    );
    const prepareBootstrapHere = vi.fn<PrivateProjectNativeSync['prepareBootstrapHere']>(async () => ({
      v: 1 as const,
      bootstrapOperationId: operationId,
      targetWorkspaceRefId: 'workspace-target',
      state: 'ready' as const,
      created: true,
      rootFingerprint: 'b'.repeat(64),
      policyDigest: contentPolicy.policyDigest,
    }));
    const releaseBootstrapHere = vi.fn<PrivateProjectNativeSync['releaseBootstrapHere']>(async () => ({
      ok: true as const,
      released: true,
    }));
    const bindTargetPhaseContext = vi.fn();
    const bindRelationship = vi.fn(async () => undefined);
    const verifyMachineAdmissionCurrent = vi.fn(async () => true);

    const workspaceSyncPrivateExecution = {
      input: { operationId },
      phase: 'open' as const,
      bindRelationship,
      execution: {
        credentials: { token: 'host-secret-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } },
        accountRowsCustody: {
          accountId: 'requester-account',
          serverId,
          projectAccountRowCipher: {} as never,
          isCurrent: async () => true,
        },
        nativeSync: {
          preflightHandoffTargetReplacementHere,
          prepareBootstrapHere,
          releaseBootstrapHere,
        } as unknown as PrivateProjectNativeSync,
        bindTargetPhaseContext,
        assertTransferCurrent: async () => undefined,
        release: async () => undefined,
      },
    } as NonNullable<RpcHandlerContext['workspaceSyncPrivateExecution']>;

    const signal = new AbortController().signal;
    const contextFor = (phase: 'preflight' | 'prepare' | 'release'): RpcHandlerContext => ({
      signal,
      callerInputAuthorization,
      machineAdmission: machineAdmission('target-machine'),
      callerAuthority: 'present_user',
      workspaceSyncTargetRouting: targetRoutingFor(phase),
      workspaceSyncSourceWriterTargetRouting: writerTargetFor(phase),
      workspaceSyncSourceExecution,
      verifyMachineAdmissionCurrent,
      workspaceSyncPrivateExecution,
      authorization: {
        kind: 'machine.rpc',
        serverId,
        actorAccountId: 'requester-account',
        machineId: 'target-machine',
      } as unknown as RpcHandlerContext['authorization'],
      transportRequestId: 'transport-req-1',
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT)?.({
      v: 1,
      serverId,
      machineId: 'target-machine',
      operationId,
      targetPath: targetRoot,
    }, contextFor('preflight'))).resolves.toEqual({ type: 'not_required' });

    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE)?.({
      v: 1,
      bootstrapOperationId: operationId,
      owner: {
        kind: 'copy_once',
        operation: {
          v: 1,
          operationId,
          controllerMachineId: 'source-machine',
          alphaWorkspaceRefId: 'workspace-source',
          betaWorkspaceRefId: 'workspace-target',
          contentPolicy,
        },
      },
      targetWorkspaceRefId: 'workspace-target',
      endpointRole: 'beta',
      policyDigest: contentPolicy.policyDigest,
      createIfMissing: true,
      targetBootstrap: 'materialize_from_source_workspace',
    }, contextFor('prepare'))).resolves.toMatchObject({ state: 'ready', targetWorkspaceRefId: 'workspace-target' });

    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE)?.({
      v: 1,
      bootstrapOperationId: operationId,
      owner: { kind: 'relationship', relationshipId },
      targetWorkspaceRefId: 'workspace-target',
      endpointRole: 'beta',
      policyDigest: contentPolicy.policyDigest,
      createIfMissing: true,
    }, contextFor('prepare'))).resolves.toMatchObject({ state: 'ready', targetWorkspaceRefId: 'workspace-target' });

    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE)?.({
      v: 1,
      bootstrapOperationId: operationId,
      targetWorkspaceRefId: 'workspace-target',
      reason: 'copy_committed',
    }, contextFor('release'))).resolves.toEqual({ ok: true, released: true });

    expect(bindTargetPhaseContext).toHaveBeenCalledTimes(2);
    expect(bindRelationship).toHaveBeenCalledWith(relationshipId);

    const forwardedContexts = [
      preflightHandoffTargetReplacementHere.mock.calls[0]?.[2],
      prepareBootstrapHere.mock.calls[0]?.[2],
      prepareBootstrapHere.mock.calls[1]?.[2],
      releaseBootstrapHere.mock.calls[0]?.[2],
    ];
    for (const forwarded of forwardedContexts) {
      expect(forwarded).toBeDefined();
      expect(forwarded?.workspaceSyncSourceExecution).toEqual(workspaceSyncSourceExecution);
      expect(forwarded?.callerInputAuthorization).toEqual(callerInputAuthorization);
      expect(forwarded?.verifyMachineAdmissionCurrent).toBe(verifyMachineAdmissionCurrent);
      expect(forwarded).not.toHaveProperty('workspaceSyncPrivateExecution');
      expect(forwarded).not.toHaveProperty('authorization');
      expect(forwarded).not.toHaveProperty('transportRequestId');
    }

    expect(service.preflightHandoffTargetReplacement).not.toHaveBeenCalled();
    expect(service.prepareBootstrapAtTarget).not.toHaveBeenCalled();
    expect(service.releaseBootstrapAtTarget).not.toHaveBeenCalled();
  });
});
