import { dirname, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { PluginError, isPluginError } from '@happier-dev/plugin-sdk/errors';
import { projectActionFailureCauseV1, readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { TransferEndpointCandidate, WorkspaceContentPolicyV1 } from '@happier-dev/protocol';
import type { ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createWorkspaceSyncTargetAuthority, isWorkspaceSyncLocalNamespace, type WorkspaceSyncLocalManagedTarget, type WorkspaceSyncTargetAuthority, type WorkspaceSyncTargetAuthorityDependencies, type WorkspaceSyncConflictRecoveryContext } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { createWorkspaceRootOwnershipManager, type WorkspaceRootOwnershipHandle, type WorkspaceRootOwnershipRequest, type WorkspaceRootOwnershipResult } from '@/workspaces/sync/workspaceSyncRootOwnership';
import { prepareWorkspaceSyncGitTarget } from '@/workspaces/sync/workspaceSyncTargetBootstrap';
import { createWorkspaceSyncSeedExport, materializeLocalWorkspaceSyncSeed, materializeWorkspaceSyncSeedExport, resolveWorkspaceSyncSeedTransfer } from '@/workspaces/sync/workspaceSyncSeedTransfer';
import { writeTransferPayloadSourceToFile } from '@/machines/transfer/transferPayloadFileSink';
import { readTransferPayloadChunk, resolveTransferPayloadSizeBytes } from '@/machines/transfer/transferPayloadSource';
import { materializeWorkspaceExportArtifactsWithScmWorkspace } from '@/scm/workspace/workspaceExportMaterialization';
import { inspectWorkspaceLocationWithScmWorkspace } from '@/scm/workspace/workspaceLocationInspection';
import { realizeWorkspaceCheckoutWithScmWorkspace } from '@/scm/workspace/workspaceCheckoutOperations';
import { requestDirectPeerTransferToFile } from '@/machines/transfer/directPeerTransport';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { resolveWorkspaceSyncNativeRuntime } from '@/workspaces/sync/workspaceSyncNativeRuntime';
import { launchWorkspaceSyncLocalAgent } from '@/daemon/startup/workspaceSyncNativeProcessLaunchers';
import { materializeProjectCheckout, type MaterializedProjectCheckout } from './materializeProjectCheckout';
import { createWorkspaceEffectScmRegistry, executeWorkspaceCheckoutEffect, type WorkspaceCheckoutEffect, type WorkspaceCheckoutEffectContext } from './workspaceEffect';
import { privateProjectCheckoutRefusal, resolvePrivateProjectCheckoutRoot } from './privateProjectCheckout';
import type { WorkspaceSyncSourceRootLoan } from '@/workspaces/sync/workspaceSyncTypes';
import type { WorkspaceSyncNativeCopyOwner } from '@/workspaces/sync/workspaceSyncFinalReadyFact';
import type { ScmWorkspaceIntegrationWorkspaceTransferMetadata } from '@/scm/workspace/workspaceTransfer';

export type PrivateProjectNativeSync = Pick<WorkspaceSyncTargetAuthority,
  'preflightHandoffTargetReplacementHere' | 'prepareBootstrapHere' | 'prepareBootstrapAtTarget' | 'getPreparedBootstrapOwnership' | 'releaseBootstrapHere' | 'borrowSourceRootForCopy'
  | 'authorizeWorkspaceSyncMachineAgent' | 'acquireWorkspaceSyncMachineIngress' | 'openLocalWorkspaceAgentIngress' | 'reconcileRetainedBootstraps' | 'releaseAllRetainedBootstraps'
  | 'readFileHere' | 'observeEntryHere' | 'stageConflictResolutionHere' | 'applyStagedConflictResolutionHere' | 'discardStagedConflictResolutionHere' | 'releaseConflictResolutionCaptureHere'> & Readonly<{
  recoverConflictResolutionHere(request: Parameters<WorkspaceSyncTargetAuthority['recoverConflictResolutionHere']>[0], signal?: AbortSignal,
    context?: Omit<WorkspaceSyncConflictRecoveryContext, 'getProjectSnapshot'>): ReturnType<WorkspaceSyncTargetAuthority['recoverConflictResolutionHere']>;
  replaceSnapshot(snapshot: ActiveProjectAccountRowsSnapshot | null): Promise<void>;
  inspectCheckout(subdir?: string): Promise<MaterializedProjectCheckout>;
  resolveLocalRoot(rootPath: string): Promise<string>;
  acquireLocalRoot(request: WorkspaceRootOwnershipRequest): Promise<WorkspaceRootOwnershipResult>;
  /** SOURCE seed of this member's own folder, built as the member; returns the seed envelope. */
  prepareSourceSeedExport(request: Readonly<{ operationId: string; sourcePath: string; contentPolicy: WorkspaceContentPolicyV1; exclusionCandidates?: readonly string[] }>): Promise<Uint8Array>;
  /** Finite Session return bytes materialized only into this admitted checkout. */
  materializeCapturedSeed(request: Readonly<{
    operationId: string;
    resolvePayloadSource(input: Readonly<{ transferId: string }>): Promise<Readonly<{
      sizeBytes: number;
      manifestHash: string;
      readChunk(input: Readonly<{ offset: number; length: number }>): Promise<Uint8Array>;
      dispose(): Promise<void>;
    }>>;
  }>): Promise<Readonly<{ dispose(): Promise<void> }>>;
  /** Canonical reviewed capture envelope and blob descriptors, read in this endpoint's filesystem. */
  prepareSourceConflictResolutionExport(request: Parameters<WorkspaceSyncTargetAuthority['prepareConflictResolutionExport']>[0]): Promise<Readonly<{
    payload: Uint8Array;
    blobs: Awaited<ReturnType<WorkspaceSyncTargetAuthority['prepareConflictResolutionExport']>>['blobs'];
  }>>;
  /** One chunk of a blob named by that seed, read as the member. */
  readSourceSeedBlob(request: Readonly<{ operationId: string; transferId: string; offset: number; length: number }>): Promise<Uint8Array>;
  dispose(): Promise<void>;
  agentExecutablePath: string;
}>;

/** Same-binary transport uses the existing bridge's disposable result scope. */
type DisposableRootHandle = WorkspaceRootOwnershipHandle & Readonly<{ dispose(): Promise<void> }>;
export type PrivateProjectNativeSyncProcessPort = Omit<PrivateProjectNativeSync, 'acquireWorkspaceSyncMachineIngress' | 'openLocalWorkspaceAgentIngress' | 'acquireLocalRoot' | 'prepareBootstrapAtTarget' | 'getPreparedBootstrapOwnership' | 'borrowSourceRootForCopy'> & Readonly<{
  getPreparedBootstrapOwnership(request: Parameters<WorkspaceSyncTargetAuthority['getPreparedBootstrapOwnership']>[0]): Promise<DisposableRootHandle>;
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
  localManagedTarget?: WorkspaceSyncLocalManagedTarget;
  snapshot: ActiveProjectAccountRowsSnapshot;
  /** Already verified by the incumbent managed Mutagen runtime owner. */
  agent: Readonly<{ executablePath: string }> | Readonly<{ releaseChannel: PublicReleaseRingId }>;
}>;

export type PrivateProjectSyncNetwork = Pick<WorkspaceSyncTargetAuthorityDependencies,
  'refreshProjectSnapshot' | 'readChildMachineFacts' | 'callWorkspaceTargetPhase' | 'callMachineRpc' | 'assertConflictResolutionAuthorized' | 'requestResolutionExport' | 'assertTargetReplacementAuthorized'> & Readonly<{
  /** Location facts come from the controller's SCM owner over the admitted target transport. */
  inspectNativeWorkspaceLocation?(input: Readonly<{ signal?: AbortSignal }>): ReturnType<typeof inspectWorkspaceLocationWithScmWorkspace>;
  /** The admitted controller owns SCM integration over its exact target transport. */
  reconcileNativeWorkspaceIntegration?(input: Readonly<{ workspaceIntegrationMetadata?: ScmWorkspaceIntegrationWorkspaceTransferMetadata;
    signal?: AbortSignal }>): Promise<void>;
  /** The native worker consumes the existing transfer source; host paths never cross into its filesystem. */
  requestNativeResolutionExport?(request: Parameters<NonNullable<WorkspaceSyncTargetAuthorityDependencies['requestResolutionExport']>>[0]): Promise<Readonly<{
    resolvePayloadSource(input: Readonly<{ transferId: string }>): Promise<Readonly<{
      sizeBytes: number;
      manifestHash: string;
      readChunk(input: Readonly<{ offset: number; length: number }>): Promise<Uint8Array>;
    }>>;
    release(): Promise<void>;
  }>>;
  /** Parent owns requester/transport authority; the member owns every file write. */
  prepareSourceSeed(input: Readonly<{ operationId: string; sourceMachineId: string;
    sourceWorkspaceRefId: string; contentPolicy: WorkspaceContentPolicyV1; exclusionCandidates?: readonly string[]; signal?: AbortSignal }>): Promise<Readonly<{
    transferId: string;
    sizeBytes: number;
    manifestHash: string;
    /** Callback-backed finite bytes; a guest never receives a carrier-local TCP endpoint. */
    resolvePayloadSource?(input: Readonly<{ transferId: string }>): Promise<Readonly<{
      sizeBytes: number;
      manifestHash: string;
      readChunk(input: Readonly<{ offset: number; length: number }>): Promise<Uint8Array>;
    }>>;
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

/** Finite recovery of the original copied base in the retained guest namespace. */
export type WorkspaceNativeCopyBaselineEffect = Readonly<{
  kind: 'native_copy_baseline';
  workspaceRoot: string;
  memberHome: string;
  owner: WorkspaceSyncNativeCopyOwner;
  policyDigest: WorkspaceContentPolicyV1['policyDigest'];
}>;

/** Private same-binary boundary preserves the canonical owner's typed refusal. */
export function privateSyncEffectError(error: unknown): Error {
  if (isPluginError(error)) return error;
  const code = readActionErrorCodeV1(error) ?? 'action_failed';
  return new PluginError({ code, message: error instanceof Error ? error.message : 'Private workspace Sync is unavailable',
    failureCause: projectActionFailureCauseV1(error, 'native_execution_effect', { allowUnknownErrorCode: true }),
    details: { reason: code, phase: 'native_execution_effect' } });
}

/** Placement only: canonical target authority, SCM and native launcher all run
 * inside the one admitted member process, with their ordinary custody maps. */
export async function executePrivateProjectSyncEffect(effect: WorkspaceNativeSyncEffect,
  configuration: PrivateProjectSyncEffectConfiguration, network: PrivateProjectSyncNetwork,
  context: WorkspaceCheckoutEffectContext): Promise<PrivateProjectNativeSyncProcessPort> {
  const agentExecutablePath = 'executablePath' in configuration.agent ? configuration.agent.executablePath
    : (await resolveWorkspaceSyncNativeRuntime(configuration.agent)).agentPath;
  const checkout = effect.checkout;
  const managedTarget = configuration.localManagedTarget && configuration.snapshot.workspaceRefs.find(ref => ref.id === checkout.workspaceRefId
    && isWorkspaceSyncLocalNamespace(ref, configuration.serverId, configuration.machineId, configuration.localManagedTarget));
  const targetRoot = configuration.localManagedTarget ? managedTarget?.rootPath : join(checkout.workspaceRoot, checkout.workspaceRefId);
  if (!targetRoot || configuration.localManagedTarget && (dirname(targetRoot) !== checkout.workspaceRoot || checkout.existingRootPath !== targetRoot)) {
    throw privateProjectCheckoutRefusal();
  }
  if (checkout.request.materialization.kind !== 'sync' || checkout.request.materialization.targetPath !== targetRoot) {
    throw privateProjectCheckoutRefusal();
  }
  let snapshot: ActiveProjectAccountRowsSnapshot | null = configuration.snapshot;
  const sourceDescriptor = checkout.request.source;
  const source = sourceDescriptor.kind === 'workspace'
    ? snapshot.workspaceRefs.find(ref => ref.id === sourceDescriptor.workspaceId && ref.serverId === configuration.serverId) : undefined;
  const isLocalWorkspace = (ref: import('@happier-dev/protocol').WorkspaceRefV1) => isWorkspaceSyncLocalNamespace(ref, configuration.serverId, configuration.machineId, configuration.localManagedTarget);
  const localSource = source && isLocalWorkspace(source) ? source : undefined;
  if (localSource && !configuration.localManagedTarget && localSource.rootPath !== resolvePrivateProjectCheckoutRoot(checkout.workspaceRoot, localSource.id)) throw privateProjectCheckoutRefusal();
  const localRoots = new Map<string, { rootPath: string; ownership?: WorkspaceRootOwnershipHandle }>([
    [checkout.workspaceRefId, { rootPath: targetRoot }], ...(localSource ? [[localSource.id, { rootPath: localSource.rootPath }] as const] : []),
  ]);
  const assertLocalRoot = (rootPath: string, workspaceRefId?: string) => {
    if (workspaceRefId ? localRoots.get(workspaceRefId)?.rootPath !== rootPath : ![...localRoots.values()].some(entry => entry.rootPath === rootPath)) throw privateProjectCheckoutRefusal();
  };
  const stateDirectory = join(effect.memberHome, '.happier', 'workspace-sync');
  const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory: join(effect.memberHome, '.happier', 'runtime', 'workspace-sync-root-ownership') });
  const assertBoundId = (workspaceRefId: string) => {
    if (workspaceRefId !== checkout.workspaceRefId) throw privateProjectCheckoutRefusal();
  };
  const replaceSnapshot = (next: ActiveProjectAccountRowsSnapshot | null) => {
    const target = next?.workspaceRefs.find(ref => ref.id === checkout.workspaceRefId && ref.serverId === configuration.serverId);
    if (target && (target.rootPath !== targetRoot || !isLocalWorkspace(target))) throw privateProjectCheckoutRefusal();
    const nextSource = localSource && next?.workspaceRefs.find(ref => ref.id === localSource.id && ref.serverId === configuration.serverId);
    if (nextSource && (nextSource.rootPath !== localSource?.rootPath || !isLocalWorkspace(nextSource))) throw privateProjectCheckoutRefusal();
    snapshot = next;
  };
  replaceSnapshot(snapshot);
  const registry = await createWorkspaceEffectScmRegistry(checkout, { ...context,
    managedGuestHome: configuration.localManagedTarget ? effect.memberHome : undefined });
  const nativeResolutionExport = network.requestNativeResolutionExport;
  const requestResolutionExport: WorkspaceSyncTargetAuthorityDependencies['requestResolutionExport'] = nativeResolutionExport
    ? async request => {
      const remote = await nativeResolutionExport(request);
      return {
        requestPayload: async ({ transferId, destinationPath }) => {
          const source = await remote.resolvePayloadSource({ transferId });
          await writeTransferPayloadSourceToFile({ source: { kind: 'native', sizeBytes: source.sizeBytes,
            manifestHash: source.manifestHash, readChunk: async input => Buffer.from(await source.readChunk(input)) }, destinationPath });
        },
        release: remote.release,
      };
    } : configuration.localManagedTarget ? undefined : network.requestResolutionExport;
  const authority = createWorkspaceSyncTargetAuthority({
    localServerId: configuration.serverId, localMachineId: configuration.machineId, localAccountId: configuration.accountId,
    localWorkspaceRefId: checkout.workspaceRefId,
    ...(configuration.localManagedTarget ? { localManagedTarget: configuration.localManagedTarget } : {}),
    ...(network.assertConflictResolutionAuthorized ? { assertConflictResolutionAuthorized: network.assertConflictResolutionAuthorized } : {}),
    ...(requestResolutionExport ? { requestResolutionExport } : {}),
    ...(network.assertTargetReplacementAuthorized ? { assertTargetReplacementAuthorized: network.assertTargetReplacementAuthorized } : {}),
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
    resolveLocalResolutionEndpoint: async (relationshipId, workspaceRefId) => {
      const root = localRoots.get(workspaceRefId);
      const handle = root?.ownership;
      const relationship = snapshot?.relationships.find(row => row.relationshipId === relationshipId);
      if (!root || !handle || !relationship) return null;
      return { relationship, canonicalRoot: handle.owner.canonicalRoot, assertCurrentAuthority: async () => {
        if (root.ownership !== handle || handle.owner.rootFingerprint === null) {
          throw Object.assign(new Error('Workspace root ownership is unavailable'), { code: 'workspace_root_ownership_lost' });
        }
        await handle.assertCurrentRootIdentity(handle.owner.rootFingerprint);
      } };
    },
    bootstrap: {
      materializationDirectory: join(stateDirectory, 'materialization'), rootOwnershipManager,
      prepareGitTarget: input => {
        if (input.sourceRootPath) assertLocalRoot(input.sourceRootPath);
        return prepareWorkspaceSyncGitTarget(input, {
          inspectWorkspaceLocation: input => {
            if (!configuration.localManagedTarget) return inspectWorkspaceLocationWithScmWorkspace({ ...input, registry: registry.registry });
            if (!network.inspectNativeWorkspaceLocation) throw Object.assign(new Error('Native SCM target transport is unavailable'), { code: 'workspace_sync_unavailable' });
            return network.inspectNativeWorkspaceLocation({ signal: context.signal });
          },
          realizeWorkspaceCheckout: input => realizeWorkspaceCheckoutWithScmWorkspace({ ...input, registry: registry.registry }),
        });
      },
      materializeLocalSeed: async input => {
        assertLocalRoot(input.sourcePath);
        // Same-machine source must be readable by the already selected member;
        // it never borrows daemon traversal or a different OS identity.
        return materializeLocalWorkspaceSyncSeed({ ...input, activeServerDir: stateDirectory,
          targetPath: input.canonicalRoot, workspaceTransfer: resolveWorkspaceSyncSeedTransfer(input.contentPolicy, input.exclusionCandidates), registry: registry.registry });
      },
      materializeRemoteSeed: async input => {
        const prepared = await network.prepareSourceSeed({ operationId: input.operationId, sourceMachineId: input.sourceMachineId,
          sourceWorkspaceRefId: input.sourceWorkspaceRefId, contentPolicy: input.contentPolicy,
          ...(input.exclusionCandidates ? { exclusionCandidates: input.exclusionCandidates } : {}), signal: input.signal });
        try {
          if (configuration.localManagedTarget && !prepared.resolvePayloadSource) {
            throw Object.assign(new Error('Native workspace seed byte source is unavailable'), { code: 'target_bootstrap_offline' });
          }
          return await materializeWorkspaceSyncSeedExport({ operationId: input.operationId, targetPath: input.canonicalRoot,
            materializationReceiptPath: input.materializationReceiptPath, originalTargetExists: input.originalTargetExists,
            targetFence: input.targetFence, signal: input.signal,
            requestPayload: async request => {
              if (prepared.resolvePayloadSource) {
                const source = await prepared.resolvePayloadSource({ transferId: request.transferId });
                await writeTransferPayloadSourceToFile({ source: { kind: 'native', sizeBytes: source.sizeBytes,
                  manifestHash: source.manifestHash, readChunk: async chunk => Buffer.from(await source.readChunk(chunk)) },
                destinationPath: request.destinationPath });
                return;
              }
              const payload = await prepared.openPayload({ transferId: request.transferId, signal: input.signal });
              try {
                await requestDirectPeerTransferToFile({ ...request, endpointCandidates: payload.endpointCandidates, signal: input.signal,
                  ...(request.transferId === input.operationId ? { expectedSizeBytes: prepared.sizeBytes, expectedManifestHash: prepared.manifestHash } : {}) });
              } finally { await payload.dispose(); }
            },
            materializeWorkspaceExportArtifacts: request => materializeWorkspaceExportArtifactsWithScmWorkspace({ ...request, registry: registry.registry,
              ...(configuration.localManagedTarget && network.reconcileNativeWorkspaceIntegration ? {
                reconcilePostMaterialization: async ({ workspaceIntegrationMetadata }) =>
                  network.reconcileNativeWorkspaceIntegration!({ workspaceIntegrationMetadata, signal: input.signal }),
              } : {}),
            }),
          });
        } finally { await prepared.dispose(); }
      },
    },
    openRootedAgent: async input => {
      context.signal.throwIfAborted();
      return launchWorkspaceSyncLocalAgent({ executablePath: agentExecutablePath,
        args: ['synchronizer', '--external', '--root', input.canonicalRoot], dataDirectory: join(stateDirectory, 'mutagen'), signal: input.signal });
    },
  });
  // All exported callbacks run behind the same private bridge. Preserve Error
  // codes once at that boundary; no duplicate target admission is introduced.
  const call = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); } catch (error) { throw privateSyncEffectError(error); }
  };
  let disposal: Promise<void> | undefined;
  let capturedSeed: Awaited<ReturnType<typeof materializeWorkspaceSyncSeedExport>> | undefined;
  // The daemon serves these seeds but never opens a path in this member folder (MEMBER-CHILD-READS-1115).
  const sourceSeeds = new Map<string, Readonly<{ scope: Awaited<ReturnType<typeof createWorkspaceSyncSeedExport>>['onDemandScope']; actionReceiptId?: string }>>();
  const disposableHandle = (handle: WorkspaceRootOwnershipHandle): DisposableRootHandle => ({ ...handle, dispose: handle.release });
  return {
    agentExecutablePath,
    borrowSourceRootForCopy: request => call(async () => {
      if (request.workspaceRefId !== checkout.workspaceRefId && request.workspaceRefId !== source?.id) throw privateProjectCheckoutRefusal();
      const loan = await authority.borrowSourceRootForCopy(request);
      return loan && { ...loan, dispose: loan.release };
    }),
    preflightHandoffTargetReplacementHere: (request, signal, ingress) => call(async () => {
      if (request.targetPath !== targetRoot) throw privateProjectCheckoutRefusal();
      return authority.preflightHandoffTargetReplacementHere(request, signal, ingress);
    }),
    getPreparedBootstrapOwnership: request => call(async () => {
      assertBoundId(request.targetWorkspaceRefId);
      return disposableHandle(await authority.getPreparedBootstrapOwnership(request));
    }),
    prepareBootstrapHere: (request, signal, ingress, admitted) => call(async () => {
      assertBoundId(request.targetWorkspaceRefId); context.onEffectsIssued();
      return authority.prepareBootstrapHere(request, signal, ingress, admitted);
    }),
    prepareBootstrapAtTarget: (request, ingress) => call(async () => {
      assertBoundId(request.targetWorkspaceRefId); context.onEffectsIssued();
      const { ownershipHandles, ...reply } = await authority.prepareBootstrapAtTarget(request, ingress);
      return { ...reply, ...(ownershipHandles ? { ownershipHandles: ownershipHandles.map(disposableHandle) } : {}) };
    }),
    resolveLocalRoot: rootPath => call(async () => {
      assertLocalRoot(rootPath);
      // A target not yet materialized resolves to its admitted path, as the
      // installed controller's own resolution does; bootstrap creates it.
      const canonicalRoot = await realpath(rootPath).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return rootPath;
        throw error;
      });
      if (canonicalRoot !== rootPath) throw privateProjectCheckoutRefusal();
      return canonicalRoot;
    }),
    acquireLocalRoot: request => call(async () => {
      assertLocalRoot(request.canonicalRoot); context.onEffectsIssued();
      const result = await rootOwnershipManager.tryAcquire(request);
      if ('kind' in result) return result;
      for (const entry of localRoots.values()) {
        if (entry.rootPath === request.canonicalRoot) entry.ownership = result;
      }
      const release = async () => {
        await result.release();
        for (const entry of localRoots.values()) {
          if (entry.ownership === result) delete entry.ownership;
        }
      };
      return { ...result, release, dispose: release };
    }),
    openLocalWorkspaceAgentIngress: request => call(async () => {
      assertLocalRoot(request.canonicalRoot, request.workspaceRefId);
      const ingress = await authority.openLocalWorkspaceAgentIngress(request);
      return { ...ingress, dispose: ingress.close };
    }),
    releaseBootstrapHere: (request, signal, ingress, admitted) => call(async () => {
      assertBoundId(request.targetWorkspaceRefId); return authority.releaseBootstrapHere(request, signal, ingress, admitted);
    }),
    acquireWorkspaceSyncMachineIngress: request => call(async () => {
      const ingress = await authority.acquireWorkspaceSyncMachineIngress(request);
      return { ...ingress, dispose: ingress.close };
    }),
    authorizeWorkspaceSyncMachineAgent: request => call(() => authority.authorizeWorkspaceSyncMachineAgent(request)),
    reconcileRetainedBootstraps: () => call(() => authority.reconcileRetainedBootstraps()),
    releaseAllRetainedBootstraps: () => call(() => authority.releaseAllRetainedBootstraps()),
    recoverConflictResolutionHere: (request, signal, recoveryContext) => call(async () => {
      const localResolutionEndpoint = recoveryContext?.localResolutionEndpoint;
      assertLocalRoot(localRoots.get(request.targetWorkspaceRefId)?.rootPath ?? '', request.targetWorkspaceRefId);
      if (localResolutionEndpoint) assertLocalRoot(localResolutionEndpoint.canonicalRoot, request.targetWorkspaceRefId);
      context.onEffectsIssued();
      return authority.recoverConflictResolutionHere(request, signal, { localResolutionEndpoint });
    }),
    prepareSourceSeedExport: request => call(async () => {
      assertLocalRoot(request.sourcePath);
      const built = await createWorkspaceSyncSeedExport({ operationId: request.operationId, activeServerDir: stateDirectory,
        sourcePath: request.sourcePath, workspaceTransfer: resolveWorkspaceSyncSeedTransfer(request.contentPolicy, request.exclusionCandidates), registry: registry.registry });
      sourceSeeds.set(request.operationId, { scope: built.onDemandScope });
      return new Uint8Array(built.payloadSource.payload);
    }),
    materializeCapturedSeed: request => call(async () => {
      context.signal.throwIfAborted();
      context.onEffectsIssued();
      capturedSeed = await materializeWorkspaceSyncSeedExport({ operationId: request.operationId,
        targetPath: targetRoot, signal: context.signal,
        requestPayload: async payload => {
          const source = await request.resolvePayloadSource({ transferId: payload.transferId });
          try {
            await writeTransferPayloadSourceToFile({ source: { kind: 'native', sizeBytes: source.sizeBytes,
              manifestHash: source.manifestHash, readChunk: async chunk => Buffer.from(await source.readChunk(chunk)) },
            destinationPath: payload.destinationPath });
          } finally { await source.dispose(); }
        },
        materializeWorkspaceExportArtifacts: payload => materializeWorkspaceExportArtifactsWithScmWorkspace({ ...payload, registry: registry.registry }),
      });
      const custody = capturedSeed;
      return { dispose: async () => { await custody.abort(); if (capturedSeed === custody) capturedSeed = undefined; } };
    }),
    prepareSourceConflictResolutionExport: request => call(async () => {
      assertBoundId(request.sourceWorkspaceRefId);
      const built = await authority.prepareConflictResolutionExport(request);
      sourceSeeds.set(request.operationId, { scope: built.onDemandScope, actionReceiptId: request.actionReceiptId });
      return { payload: new Uint8Array(await readTransferPayloadChunk({ source: built.payloadSource, offset: 0,
        length: await resolveTransferPayloadSizeBytes(built.payloadSource) })), blobs: built.blobs };
    }),
    readSourceSeedBlob: request => call(async () => {
      const seed = sourceSeeds.get(request.operationId)?.scope;
      if (!seed?.allowTransferId(request.transferId)) throw privateProjectCheckoutRefusal();
      const source = await seed.resolvePayloadSourceOnOpen({ transferId: request.transferId, requestBody: undefined });
      return new Uint8Array(await readTransferPayloadChunk({ source, offset: request.offset, length: request.length }));
    }),
    stageConflictResolutionHere: (request, signal) => call(async () => {
      assertBoundId(request.targetWorkspaceRefId); context.onEffectsIssued();
      return authority.stageConflictResolutionHere(request, signal);
    }),
    applyStagedConflictResolutionHere: (request, signal) => call(async () => {
      assertBoundId(request.targetWorkspaceRefId); context.onEffectsIssued();
      return authority.applyStagedConflictResolutionHere(request, signal);
    }),
    discardStagedConflictResolutionHere: (request, signal) => call(async () => {
      assertBoundId(request.targetWorkspaceRefId); return authority.discardStagedConflictResolutionHere(request, signal);
    }),
    releaseConflictResolutionCaptureHere: request => call(async () => {
      await authority.releaseConflictResolutionCaptureHere(request);
      for (const [operationId, entry] of sourceSeeds) {
        if (entry.actionReceiptId === request.actionReceiptId) sourceSeeds.delete(operationId);
      }
    }),
    readFileHere: (request, signal) => call(async () => { assertBoundId(request.workspaceRefId); return authority.readFileHere(request, signal); }),
    observeEntryHere: (request, signal) => call(async () => { assertBoundId(request.workspaceRefId); return authority.observeEntryHere(request, signal); }),
    replaceSnapshot: next => call(async () => { replaceSnapshot(next); }),
    inspectCheckout: subdir => call(async () => {
      if (configuration.localManagedTarget) {
        if (await realpath(targetRoot) !== targetRoot) throw privateProjectCheckoutRefusal();
        return materializeProjectCheckout({ materialization: { kind: 'attach' }, sourceDirectory: targetRoot,
          sourceRootPath: targetRoot, subdir, signal: context.signal });
      }
      return executeWorkspaceCheckoutEffect({ ...checkout, existingRootPath: targetRoot,
        request: { ...checkout.request, source: { kind: 'workspace', workspaceId: checkout.workspaceRefId }, materialization: { kind: 'attach' }, subdir } }, context);
    }),
    dispose: () => disposal ??= (async () => {
      await authority.releaseAllRetainedBootstraps();
      for (const root of localRoots.values()) {
        await root.ownership?.release();
        delete root.ownership;
      }
      await capturedSeed?.abort();
      await registry.dispose();
    })(),
  };
}
