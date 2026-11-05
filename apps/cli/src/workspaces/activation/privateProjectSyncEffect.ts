import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { PluginError, isPluginError } from '@happier-dev/plugin-sdk/errors';
import type { TransferEndpointCandidate, WorkspaceContentPolicyV1 } from '@happier-dev/protocol';
import type { ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createWorkspaceSyncTargetAuthority, type WorkspaceSyncTargetAuthority, type WorkspaceSyncTargetAuthorityDependencies, type WorkspaceSyncConflictRecoveryContext } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { createWorkspaceRootOwnershipManager, type WorkspaceRootOwnershipHandle, type WorkspaceRootOwnershipRequest, type WorkspaceRootOwnershipResult } from '@/workspaces/sync/workspaceSyncRootOwnership';
import { prepareWorkspaceSyncGitTarget } from '@/workspaces/sync/workspaceSyncTargetBootstrap';
import { materializeLocalWorkspaceSyncSeed, materializeWorkspaceSyncSeedExport, resolveWorkspaceSyncSeedTransfer } from '@/workspaces/sync/workspaceSyncSeedTransfer';
import { materializeWorkspaceExportArtifactsWithScmWorkspace } from '@/scm/workspace/workspaceExportMaterialization';
import { inspectWorkspaceLocationWithScmWorkspace } from '@/scm/workspace/workspaceLocationInspection';
import { realizeWorkspaceCheckoutWithScmWorkspace } from '@/scm/workspace/workspaceCheckoutOperations';
import { requestDirectPeerTransferToFile } from '@/machines/transfer/directPeerTransport';
import { launchWorkspaceSyncLocalAgent } from '@/daemon/startup/workspaceSyncNativeProcessLaunchers';
import type { MaterializedProjectCheckout } from './materializeProjectCheckout';
import { createWorkspaceEffectScmRegistry, executeWorkspaceCheckoutEffect, type WorkspaceCheckoutEffect, type WorkspaceCheckoutEffectContext } from './workspaceEffect';
import { privateProjectCheckoutRefusal, resolvePrivateProjectCheckoutRoot } from './privateProjectCheckout';
import type { WorkspaceSyncSourceRootLoan } from '@/workspaces/sync/workspaceSyncTypes';

export type PrivateProjectNativeSync = Pick<WorkspaceSyncTargetAuthority,
  'preflightHandoffTargetReplacementHere' | 'prepareBootstrapHere' | 'prepareBootstrapAtTarget' | 'releaseBootstrapHere' | 'borrowSourceRootForCopy'
  | 'acquireWorkspaceSyncMachineIngress' | 'openLocalWorkspaceAgentIngress' | 'reconcileRetainedBootstraps' | 'releaseAllRetainedBootstraps'
  | 'readFileHere' | 'observeEntryHere'> & Readonly<{
  recoverConflictResolutionHere(request: Parameters<WorkspaceSyncTargetAuthority['recoverConflictResolutionHere']>[0], signal?: AbortSignal,
    context?: Omit<WorkspaceSyncConflictRecoveryContext, 'getProjectSnapshot'>): ReturnType<WorkspaceSyncTargetAuthority['recoverConflictResolutionHere']>;
  replaceSnapshot(snapshot: ActiveProjectAccountRowsSnapshot | null): Promise<void>;
  inspectCheckout(subdir?: string): Promise<MaterializedProjectCheckout>;
  resolveLocalRoot(rootPath: string): Promise<string>;
  acquireLocalRoot(request: WorkspaceRootOwnershipRequest): Promise<WorkspaceRootOwnershipResult>;
  dispose(): Promise<void>;
}>;

/** Same-binary transport uses the existing bridge's disposable result scope. */
type DisposableRootHandle = WorkspaceRootOwnershipHandle & Readonly<{ dispose(): Promise<void> }>;
export type PrivateProjectNativeSyncProcessPort = Omit<PrivateProjectNativeSync, 'acquireWorkspaceSyncMachineIngress' | 'openLocalWorkspaceAgentIngress' | 'acquireLocalRoot' | 'prepareBootstrapAtTarget' | 'borrowSourceRootForCopy'> & Readonly<{
  borrowSourceRootForCopy(request: Parameters<WorkspaceSyncTargetAuthority['borrowSourceRootForCopy']>[0]): Promise<(WorkspaceSyncSourceRootLoan & { dispose(): Promise<void> }) | null>;
  acquireWorkspaceSyncMachineIngress(request: Parameters<WorkspaceSyncTargetAuthority['acquireWorkspaceSyncMachineIngress']>[0]):
    Promise<Awaited<ReturnType<WorkspaceSyncTargetAuthority['acquireWorkspaceSyncMachineIngress']>> & Readonly<{ dispose(): Promise<void> }>>;
  openLocalWorkspaceAgentIngress(request: Parameters<WorkspaceSyncTargetAuthority['openLocalWorkspaceAgentIngress']>[0]):
    Promise<Awaited<ReturnType<WorkspaceSyncTargetAuthority['openLocalWorkspaceAgentIngress']>> & Readonly<{ dispose(): Promise<void> }>>;
  acquireLocalRoot(request: WorkspaceRootOwnershipRequest): Promise<DisposableRootHandle | Extract<WorkspaceRootOwnershipResult, { kind: 'overlap' }>>;
  prepareBootstrapAtTarget(request: Parameters<WorkspaceSyncTargetAuthority['prepareBootstrapAtTarget']>[0], context?: Parameters<WorkspaceSyncTargetAuthority['prepareBootstrapAtTarget']>[1]):
    Promise<Omit<Awaited<ReturnType<WorkspaceSyncTargetAuthority['prepareBootstrapAtTarget']>>, 'ownershipHandles'> & { ownershipHandles?: readonly DisposableRootHandle[] }>;
}>;

export type PrivateProjectSyncEffectConfiguration = Readonly<{
  serverId: string;
  machineId: string;
  accountId: string;
  snapshot: ActiveProjectAccountRowsSnapshot;
  /** Already verified by the incumbent managed Mutagen runtime owner. */
  agent: Readonly<{ executablePath: string }>;
}>;

export type PrivateProjectSyncNetwork = Pick<WorkspaceSyncTargetAuthorityDependencies,
  'refreshProjectSnapshot' | 'readChildMachineFacts' | 'callWorkspaceTargetPhase' | 'callMachineRpc'> & Readonly<{
  /** Parent owns requester/transport authority; the member owns every file write. */
  prepareSourceSeed(input: Readonly<{ operationId: string; sourceMachineId: string;
    sourceWorkspaceRefId: string; contentPolicy: WorkspaceContentPolicyV1; signal?: AbortSignal }>): Promise<Readonly<{
    transferId: string;
    sizeBytes: number;
    manifestHash: string;
    openPayload(input: Readonly<{ transferId: string; signal?: AbortSignal }>): Promise<Readonly<{
      endpointCandidates: readonly TransferEndpointCandidate[];
      dispose(): Promise<void>;
    }>>;
    dispose(): Promise<void>;
  }>>;
}>;

export type WorkspaceNativeSyncEffect = Readonly<{
  kind: 'native_sync';
  checkout: WorkspaceCheckoutEffect;
  /** Captured native home, never inferred from an Account or request path. */
  memberHome: string;
}>;

/** Private same-binary boundary preserves the canonical owner's typed refusal. */
export function privateSyncEffectError(error: unknown): Error {
  if (isPluginError(error)) return error;
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : 'workspace_sync_unavailable';
  return new PluginError({ code, message: error instanceof Error ? error.message : 'Private workspace Sync is unavailable',
    details: { reason: code, phase: 'native_execution_effect' } });
}

/** Placement only: canonical target authority, SCM and native launcher all run
 * inside the one admitted member process, with their ordinary custody maps. */
export async function executePrivateProjectSyncEffect(effect: WorkspaceNativeSyncEffect,
  configuration: PrivateProjectSyncEffectConfiguration, network: PrivateProjectSyncNetwork,
  context: WorkspaceCheckoutEffectContext): Promise<PrivateProjectNativeSyncProcessPort> {
  const checkout = effect.checkout;
  const targetRoot = join(checkout.workspaceRoot, checkout.workspaceRefId);
  if (checkout.request.materialization.kind !== 'sync' || checkout.request.materialization.targetPath !== targetRoot) {
    throw privateProjectCheckoutRefusal();
  }
  let snapshot: ActiveProjectAccountRowsSnapshot | null = configuration.snapshot;
  const sourceDescriptor = checkout.request.source;
  const source = sourceDescriptor.kind === 'workspace'
    ? snapshot.workspaceRefs.find(ref => ref.id === sourceDescriptor.workspaceId && ref.serverId === configuration.serverId) : undefined;
  const localSource = source?.machineId === configuration.machineId ? source : undefined;
  if (localSource && localSource.rootPath !== resolvePrivateProjectCheckoutRoot(checkout.workspaceRoot, localSource.id)) throw privateProjectCheckoutRefusal();
  const localRoots = new Map([[checkout.workspaceRefId, targetRoot], ...(localSource ? [[localSource.id, localSource.rootPath] as const] : [])]);
  const assertLocalRoot = (rootPath: string, workspaceRefId?: string) => {
    if (workspaceRefId ? localRoots.get(workspaceRefId) !== rootPath : ![...localRoots.values()].includes(rootPath)) throw privateProjectCheckoutRefusal();
  };
  const stateDirectory = join(effect.memberHome, '.happier', 'workspace-sync');
  const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory: join(effect.memberHome, '.happier', 'runtime', 'workspace-sync-root-ownership') });
  const assertBoundId = (workspaceRefId: string) => {
    if (workspaceRefId !== checkout.workspaceRefId) throw privateProjectCheckoutRefusal();
  };
  const replaceSnapshot = (next: ActiveProjectAccountRowsSnapshot | null) => {
    const target = next?.workspaceRefs.find(ref => ref.id === checkout.workspaceRefId && ref.serverId === configuration.serverId);
    if (target && (target.rootPath !== targetRoot || target.machineId !== configuration.machineId)) throw privateProjectCheckoutRefusal();
    const nextSource = localSource && next?.workspaceRefs.find(ref => ref.id === localSource.id && ref.serverId === configuration.serverId);
    if (nextSource && (nextSource.rootPath !== localSource?.rootPath || nextSource.machineId !== configuration.machineId)) throw privateProjectCheckoutRefusal();
    snapshot = next;
  };
  replaceSnapshot(snapshot);
  const registry = await createWorkspaceEffectScmRegistry(checkout, context);
  const authority = createWorkspaceSyncTargetAuthority({
    localServerId: configuration.serverId, localMachineId: configuration.machineId, localAccountId: configuration.accountId,
    localWorkspaceRefId: checkout.workspaceRefId,
    getProjectSnapshot: () => snapshot,
    ...(network.refreshProjectSnapshot ? { refreshProjectSnapshot: async (signal, ingress) => {
      const next = await network.refreshProjectSnapshot!(signal, ingress);
      replaceSnapshot(next);
      return next;
    } } : {}),
    ...(network.readChildMachineFacts ? { readChildMachineFacts: network.readChildMachineFacts } : {}),
    ...(network.callWorkspaceTargetPhase ? { callWorkspaceTargetPhase: network.callWorkspaceTargetPhase } : {}),
    callMachineRpc: network.callMachineRpc,
    resolutionMaterialDirectory: join(stateDirectory, 'resolution'),
    bootstrap: {
      materializationDirectory: join(stateDirectory, 'materialization'), rootOwnershipManager,
      prepareGitTarget: input => {
        if (input.sourceRootPath) assertLocalRoot(input.sourceRootPath);
        return prepareWorkspaceSyncGitTarget(input, {
          inspectWorkspaceLocation: input => inspectWorkspaceLocationWithScmWorkspace({ ...input, registry: registry.registry }),
          realizeWorkspaceCheckout: input => realizeWorkspaceCheckoutWithScmWorkspace({ ...input, registry: registry.registry }),
        });
      },
      materializeLocalSeed: async input => {
        assertLocalRoot(input.sourcePath);
        // Same-machine source must be readable by the already selected member;
        // it never borrows daemon traversal or a different OS identity.
        return materializeLocalWorkspaceSyncSeed({ ...input, activeServerDir: stateDirectory,
          targetPath: input.canonicalRoot, workspaceTransfer: resolveWorkspaceSyncSeedTransfer(input.contentPolicy), registry: registry.registry });
      },
      materializeRemoteSeed: async input => {
        const prepared = await network.prepareSourceSeed({ operationId: input.operationId, sourceMachineId: input.sourceMachineId,
          sourceWorkspaceRefId: input.sourceWorkspaceRefId, contentPolicy: input.contentPolicy, signal: input.signal });
        try {
          return await materializeWorkspaceSyncSeedExport({ operationId: input.operationId, targetPath: input.canonicalRoot,
            materializationReceiptPath: input.materializationReceiptPath, originalTargetExists: input.originalTargetExists,
            targetFence: input.targetFence, signal: input.signal,
            requestPayload: async request => {
              const payload = await prepared.openPayload({ transferId: request.transferId, signal: input.signal });
              try {
                await requestDirectPeerTransferToFile({ ...request, endpointCandidates: payload.endpointCandidates, signal: input.signal,
                  ...(request.transferId === input.operationId ? { expectedSizeBytes: prepared.sizeBytes, expectedManifestHash: prepared.manifestHash } : {}) });
              } finally { await payload.dispose(); }
            },
            materializeWorkspaceExportArtifacts: request => materializeWorkspaceExportArtifactsWithScmWorkspace({ ...request, registry: registry.registry }),
          });
        } finally { await prepared.dispose(); }
      },
    },
    openRootedAgent: async input => {
      context.signal.throwIfAborted();
      return launchWorkspaceSyncLocalAgent({ executablePath: configuration.agent.executablePath,
        args: ['synchronizer', '--external', '--root', input.canonicalRoot], dataDirectory: join(stateDirectory, 'mutagen'), signal: input.signal });
    },
  });
  // All exported callbacks run behind the same private bridge. Preserve Error
  // codes once at that boundary; no duplicate target admission is introduced.
  const call = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); } catch (error) { throw privateSyncEffectError(error); }
  };
  let disposal: Promise<void> | undefined;
  const disposableHandle = (handle: WorkspaceRootOwnershipHandle): DisposableRootHandle => ({ ...handle, dispose: handle.release });
  return {
    borrowSourceRootForCopy: request => call(async () => {
      if (request.workspaceRefId !== checkout.workspaceRefId && request.workspaceRefId !== source?.id) throw privateProjectCheckoutRefusal();
      const loan = await authority.borrowSourceRootForCopy(request);
      return loan && { ...loan, dispose: loan.release };
    }),
    preflightHandoffTargetReplacementHere: (request, signal, ingress) => call(async () => {
      if (request.targetPath !== targetRoot) throw privateProjectCheckoutRefusal();
      return authority.preflightHandoffTargetReplacementHere(request, signal, ingress);
    }),
    prepareBootstrapHere: (request, signal, ingress) => call(async () => {
      assertBoundId(request.targetWorkspaceRefId); context.onEffectsIssued();
      return authority.prepareBootstrapHere(request, signal, ingress);
    }),
    prepareBootstrapAtTarget: (request, ingress) => call(async () => {
      assertBoundId(request.targetWorkspaceRefId); context.onEffectsIssued();
      const { ownershipHandles, ...reply } = await authority.prepareBootstrapAtTarget(request, ingress);
      return { ...reply, ...(ownershipHandles ? { ownershipHandles: ownershipHandles.map(disposableHandle) } : {}) };
    }),
    resolveLocalRoot: rootPath => call(async () => {
      assertLocalRoot(rootPath);
      const canonicalRoot = await realpath(rootPath);
      if (canonicalRoot !== rootPath) throw privateProjectCheckoutRefusal();
      return canonicalRoot;
    }),
    acquireLocalRoot: request => call(async () => {
      assertLocalRoot(request.canonicalRoot); context.onEffectsIssued();
      const result = await rootOwnershipManager.tryAcquire(request);
      return 'kind' in result ? result : disposableHandle(result);
    }),
    openLocalWorkspaceAgentIngress: request => call(async () => {
      assertLocalRoot(request.canonicalRoot, request.workspaceRefId);
      const ingress = await authority.openLocalWorkspaceAgentIngress(request);
      return { ...ingress, dispose: ingress.close };
    }),
    releaseBootstrapHere: (request, signal, ingress) => call(async () => {
      assertBoundId(request.targetWorkspaceRefId); return authority.releaseBootstrapHere(request, signal, ingress);
    }),
    acquireWorkspaceSyncMachineIngress: request => call(async () => {
      const ingress = await authority.acquireWorkspaceSyncMachineIngress(request);
      return { ...ingress, dispose: ingress.close };
    }),
    reconcileRetainedBootstraps: () => call(() => authority.reconcileRetainedBootstraps()),
    releaseAllRetainedBootstraps: () => call(() => authority.releaseAllRetainedBootstraps()),
    recoverConflictResolutionHere: (request, signal, recoveryContext) => call(async () => {
      const localResolutionEndpoint = recoveryContext?.localResolutionEndpoint;
      assertLocalRoot(localRoots.get(request.targetWorkspaceRefId) ?? '', request.targetWorkspaceRefId);
      if (localResolutionEndpoint) assertLocalRoot(localResolutionEndpoint.canonicalRoot, request.targetWorkspaceRefId);
      context.onEffectsIssued();
      return authority.recoverConflictResolutionHere(request, signal, { localResolutionEndpoint });
    }),
    readFileHere: (request, signal) => call(async () => { assertBoundId(request.workspaceRefId); return authority.readFileHere(request, signal); }),
    observeEntryHere: (request, signal) => call(async () => { assertBoundId(request.workspaceRefId); return authority.observeEntryHere(request, signal); }),
    replaceSnapshot: next => call(async () => { replaceSnapshot(next); }),
    inspectCheckout: subdir => call(() => executeWorkspaceCheckoutEffect({ ...checkout, existingRootPath: targetRoot,
      request: { ...checkout.request, source: { kind: 'workspace', workspaceId: checkout.workspaceRefId }, materialization: { kind: 'attach' }, subdir } }, context)),
    dispose: () => disposal ??= (async () => { await authority.releaseAllRetainedBootstraps(); await registry.dispose(); })(),
  };
}
