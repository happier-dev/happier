import { areWorkspaceSyncRelationshipDefinitionsEqual, deriveWorkspaceSyncConflictOperationId, HandoffTargetReplacementPreflightResultV1Schema, HandoffTargetReplacementPreflightV1Schema, ReadWorkspaceSyncFileResultV1Schema, WorkspaceSyncEntryExpectationV1Schema, WorkspaceSyncTargetEntryObserveV1Schema, WorkspaceSyncTargetBootstrapPrepareResultV1Schema, WorkspaceSyncTargetBootstrapPrepareV1Schema, WorkspaceSyncTargetBootstrapReleaseResultV1Schema, WorkspaceSyncTargetBootstrapReleaseV1Schema, WorkspaceSyncTargetConflictStageV1Schema, WorkspaceSyncConflictCaptureReleaseV1Schema, WorkspaceSyncTargetConflictApplyV1Schema, WorkspaceSyncTargetConflictApplyResultV1Schema, WorkspaceSyncTargetConflictRecoverV1Schema, WorkspaceSyncTargetConflictRecoverResultV1Schema, WorkspaceSyncTargetFileReadV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { deriveWorkspaceSyncTopology, resolveWorkspaceSyncEndpoint, resolveWorkspaceSyncRelationshipEndpointRoles, resolveWorkspaceSyncRelationshipTransferDirection } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { areWorkspaceSyncWorkerCopyProvenancesEqual, getWorkspaceSyncWorkerCopyV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { WorkspaceSyncChildMachineFacts } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveWorkspaceWriteActionAdmissionV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { assertResolvedHomeTargetIdentity, HomeTargetResolutionError, type ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { observeServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveCliHomeTarget } from '@/server/homeTarget';
import { configuration } from '@/configuration';
import { readManagedMachine } from '@/machines/managed/readManagedMachine';
import { ManagedInspectOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { isManagedDevcontainerChildProjectionCurrentV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { isDeepStrictEqual } from 'node:util';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { HandoffTargetReplacementApprovalV1Schema } from '@happier-dev/protocol/sessions/control/handoff/handoffTargetReplacementApprovalV1';
import { WorkspaceSyncCommittedCopyTargetV1Schema, WorkspaceSyncCommittedCopyTargetResultV1Schema,
  WorkspaceSyncCommittedCopyPreviewV1Schema, WorkspaceSyncCommittedCopyPreviewResultV1Schema,
  type WorkspaceSyncCommittedCopyPreviewV1, type WorkspaceSyncCommittedCopyPreviewResultV1,
  type WorkspaceSyncCommittedCopyTargetV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncCommittedCopyV1';
import type { ProjectWorkerCopyRetireInputV1 } from '@happier-dev/protocol';
import type { ProjectWorkerDependencyV1 } from '@happier-dev/protocol/workspaces/projectWorkerExecutionV1';
import type { ReadWorkspaceSyncFileResultV1, WorkspaceSyncEntryExpectationV1, WorkspaceSyncTargetEntryObserveV1, WorkspaceSyncConflictResolveActionInputV1, HandoffTargetReplacementPreflightResultV1, HandoffTargetReplacementPreflightV1, WorkspaceContentPolicyV1, WorkspaceRefV1, WorkspaceSyncCopyOnceV1, WorkspaceSyncRelationshipV1, WorkspaceSyncTargetBootstrapPrepareResultV1, WorkspaceSyncTargetBootstrapPrepareV1, WorkspaceSyncTargetBootstrapReleaseResultV1, WorkspaceSyncTargetBootstrapReleaseV1, WorkspaceSyncTargetConflictStageV1, WorkspaceSyncConflictCaptureReleaseV1, WorkspaceSyncTargetConflictApplyV1, WorkspaceSyncTargetConflictApplyResultV1, WorkspaceSyncTargetConflictRecoverV1, WorkspaceSyncTargetConflictRecoverResultV1, WorkspaceSyncTargetFileReadV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { WorkspaceSyncTargetRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema,
  type WorkspaceSyncTargetRoutingV1, type WorkspaceSyncSourceWriterTargetRoutingV1 } from '@happier-dev/protocol/socketRpc';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { MachineInstallationPublicIdentityV1 } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { assertWorkspaceSyncRequesterBootstrapSupported } from './workspaceSyncPreparation';
import { lstat, readdir, realpath, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';

import {
  getActiveProjectAccountRowsSnapshot,
  type ActiveProjectAccountRowsSnapshot,
} from '@/workspaces/projectAccountRows';
import { resolveWorkspaceRefById } from '@/workspaces/workspaceRefsV1';
import { applyCapturedWorkspaceSyncEntryAtRoot, captureWorkspaceSyncEntryAtRoot, recoverWorkspaceSyncEntryReplacementAtRoot } from './workspaceSyncConflicts';
import { discoverNativeConfinedWorkspaceSyncRecovery } from './workspaceSyncNativeConfinedFileSystem';
import { createWorkspaceSyncEntryExport, stageWorkspaceSyncEntryExport } from './workspaceSyncEntryTransfer';
import { ensureProtectedLocalStateDirectory } from '@/utils/fs/protectedLocalState';
import { observeWorkspaceSyncEntryAtRoot, readWorkspaceSyncFileAtRoot } from './workspaceSyncFileRead';
import type { WorkspaceSyncOwnedLocalAgent, WorkspaceSyncTargetEntryObserve } from './workspaceSyncController';
import { deriveWorkspaceSyncRelationshipId } from './workspaceSyncRelationshipIdentity';
import { computeWorkspaceSyncAbsentRootFingerprint } from './workspaceSyncRootIdentity';
import {
  computeWorkspaceSyncRootFingerprint,
  rehydrateWorkspaceSyncTargetBootstrap,
  workspaceSyncTargetBootstrap,
  inspectWorkspaceSyncCommittedCopy,
  removeWorkspaceSyncCommittedCopy,
  type WorkspaceSyncFinalReadyFact,
  type WorkspaceSyncTargetBootstrapDependencies,
  type WorkspaceSyncTargetBootstrapInput,
} from './workspaceSyncTargetBootstrap';
import type { WorkspaceRootOwnershipHandle, WorkspaceRootOwnershipManager } from './workspaceSyncRootOwnership';
import type { WorkspaceSyncSourceRootLoan } from './workspaceSyncTypes';
import type { DirectPeerOnDemandTransferScope } from '@/machines/transfer/directPeerTransport';
import type { TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import { prepareExistingGitWorkspaceSyncTarget } from './workspaceSyncTargetBootstrap';
import type { LiveWorkProducerV1, LiveWorkInventoryV1, LiveWorkItemV1 } from '@/daemon/lifecycle/managedActivity';
import type {
  WorkspaceExportMaterializationCustody,
  WorkspaceTargetMaterializationFence,
} from '@/scm/workspace/workspaceExportMaterialization';
import {
  createFirstBytesLocalCapability,
  matchesFirstBytesLocalCapability,
  readFirstBytesLocalCapability,
} from '@/daemon/peer/mediation/loopback/firstBytesLocalCapability';

export type WorkspaceSyncTargetFileReadRequest = Readonly<{
  relationshipId: string;
  targetMachineId: string;
  targetWorkspaceRefId: string;
  path: string;
  expectedDigest?: string;
  maxBytes: number;
  signal?: AbortSignal;
}>;

export type WorkspaceSyncTargetBootstrapPrepareRequest = Readonly<
  WorkspaceSyncTargetBootstrapPrepareV1 & Readonly<{ targetMachineId: string; signal?: AbortSignal;
    /** Original admitted namespace for the first-hop authorization; never serialized as a new grant. */
    admittedTarget?: Readonly<{ machineId: string; rootPath: string }> }>
>;
export type WorkspaceSyncTargetBootstrapReleaseRequest = Readonly<
  WorkspaceSyncTargetBootstrapReleaseV1 & Readonly<{ targetMachineId: string; signal?: AbortSignal;
    admittedTarget?: Readonly<{ machineId: string; rootPath: string }>;
    physicalEndpoint?: MachineInstallationPublicIdentityV1 }>
>;
/** Existing target RPCs sent by the actually admitted child socket, never the source custodian. */
export type WorkspaceSyncTargetPhaseDescriptor = Readonly<{
  machineId: string;
  method: typeof RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT
    | typeof RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE
    | typeof RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE;
  request: unknown;
  routing: Omit<WorkspaceSyncTargetRoutingV1, 'targetContext'>;
  /** Home-witnessed recipient retained before preparation; cleanup only, never a new target grant. */
  physicalEndpoint?: MachineInstallationPublicIdentityV1;
  signal?: AbortSignal;
}>;
/** Host-admitted personal retirement; approval and foreign requester ingress stay at their owners. */
export type WorkspaceSyncCommittedCopyRequest = WorkspaceSyncCommittedCopyTargetV1 & Readonly<{ signal?: AbortSignal }>;
export type WorkspaceSyncCommittedCopyPreviewRequest = WorkspaceSyncCommittedCopyPreviewV1 & Readonly<{ signal?: AbortSignal }>;
export type WorkspaceSyncTargetBootstrapAtTargetResult = WorkspaceSyncTargetBootstrapPrepareResultV1 & Readonly<{
  /**
   * Owner-local custody borrowed by the controller. This is never serialized
   * across the machine RPC boundary; release remains owned by this authority.
   */
  ownershipHandles?: readonly WorkspaceRootOwnershipHandle[];
}>;

export type AcquireWorkspaceSyncMachineIngressRequest = Readonly<{
  operationId: string;
  sourceMachineId: string;
  targetMachineId: string;
  /** Existing signed grant/operation deadline for the one native attach. */
  expiresAtMs?: number;
  signal?: AbortSignal;
}>;

export type WorkspaceSyncMachineIngress = Readonly<{
  port: number;
  /** One-use local listener capability consumed before any rooted-agent bytes. */
  localCapability: string;
  close(): Promise<void>;
}>;

/**
 * Local bootstrap resources supplied by the daemon composition root. The
 * staging directory and root-ownership manager are daemon-owned; the receiving
 * authority never accepts them over the wire.
 */
export type WorkspaceSyncTargetBootstrapAuthorityDependencies = Readonly<{
  materializationDirectory: string;
  rootOwnershipManager: WorkspaceRootOwnershipManager;
  /** Filesystem-boundary injection for testing final READY publication failure. */
  writeReadyFact?: (path: string, fact: Omit<WorkspaceSyncFinalReadyFact, 'completedAtMs'>) => Promise<void>;
  /** Filesystem-boundary injection for restart receipt rehydration and cleanup failure tests. */
  rehydrateMaterializationFromReceiptPath?: NonNullable<WorkspaceSyncTargetBootstrapDependencies['rehydrateMaterializationFromReceiptPath']>;
  /** Canonical SCM owner for verifying/materializing the selected Git target. */
  prepareGitTarget?: WorkspaceSyncTargetBootstrapInput['prepareGitTarget'];
  materializeRemoteSeed?: (input: Readonly<{
    operationId: string;
    sourceMachineId: string;
    sourceWorkspaceRefId: string;
    canonicalRoot: string;
    /** Complete bounded selection policy: a seed that drops it loses explicitly included ignored paths. */
    contentPolicy: WorkspaceContentPolicyV1;
    materializationReceiptPath: string;
    originalTargetExists: boolean;
    targetFence: WorkspaceTargetMaterializationFence;
    signal?: AbortSignal;
  }>) => Promise<WorkspaceExportMaterializationCustody>;
  materializeLocalSeed?: (input: Readonly<{
    operationId: string;
    sourcePath: string;
    canonicalRoot: string;
    contentPolicy: WorkspaceContentPolicyV1;
    materializationReceiptPath: string;
    originalTargetExists: boolean;
    targetFence: WorkspaceTargetMaterializationFence;
  }>) => Promise<WorkspaceExportMaterializationCustody>;
}>;

export type WorkspaceSyncTargetAuthority = Readonly<{
  activity: LiveWorkProducerV1;
  /** Host-admitted personal read; public ingress must validate current receiving authority. */
  previewCommittedCopyHere(request: WorkspaceSyncCommittedCopyPreviewRequest): Promise<WorkspaceSyncCommittedCopyPreviewResultV1>;
  previewCommittedCopyAtTarget(request: WorkspaceSyncCommittedCopyPreviewRequest): Promise<WorkspaceSyncCommittedCopyPreviewResultV1>;
  inspectCommittedCopyHere(request: WorkspaceSyncCommittedCopyRequest): Promise<void>;
  removeCommittedCopyHere(request: WorkspaceSyncCommittedCopyRequest): Promise<void>;
  inspectCommittedCopyAtTarget(request: WorkspaceSyncCommittedCopyRequest): Promise<void>;
  removeCommittedCopyAtTarget(request: WorkspaceSyncCommittedCopyRequest): Promise<void>;
  /** Owner-local: lend retained spoke custody for a finite source read. */
  borrowSourceRootForCopy(request: Readonly<{ operationId: string; workspaceRefId: string }>): Promise<WorkspaceSyncSourceRootLoan | null>;
  preflightHandoffTargetReplacementHere(request: HandoffTargetReplacementPreflightV1, signal?: AbortSignal, context?: RpcHandlerContext): Promise<HandoffTargetReplacementPreflightResultV1>;
  preflightHandoffTargetReplacementAtTarget(request: HandoffTargetReplacementPreflightV1 & Readonly<{ signal?: AbortSignal }>, context?: RpcHandlerContext): Promise<HandoffTargetReplacementPreflightResultV1>;
  stageConflictResolutionHere(request: WorkspaceSyncTargetConflictStageV1, signal?: AbortSignal): Promise<void>;
  applyStagedConflictResolutionHere(request: WorkspaceSyncTargetConflictApplyV1, signal?: AbortSignal): Promise<WorkspaceSyncTargetConflictApplyResultV1>;
  discardStagedConflictResolutionHere(request: WorkspaceSyncTargetConflictApplyV1, signal?: AbortSignal): Promise<void>;
  recoverConflictResolutionHere(request: WorkspaceSyncTargetConflictRecoverV1, signal?: AbortSignal): Promise<WorkspaceSyncTargetConflictRecoverResultV1>;
  recoverConflictResolutionAtTarget(request: WorkspaceSyncTargetConflictRecoverV1 & Readonly<{ signal?: AbortSignal }>): Promise<WorkspaceSyncTargetConflictRecoverResultV1>;
  readFileHere(request: WorkspaceSyncTargetFileReadV1, signal?: AbortSignal): Promise<ReadWorkspaceSyncFileResultV1>;
  observeEntryHere(request: WorkspaceSyncTargetEntryObserveV1, signal?: AbortSignal): Promise<WorkspaceSyncEntryExpectationV1>;
  stageConflictResolutionAtTarget(request: WorkspaceSyncTargetConflictStageV1 & Readonly<{ signal?: AbortSignal }>): Promise<void>;
  applyStagedConflictResolutionAtTarget(request: WorkspaceSyncTargetConflictApplyV1 & Readonly<{ signal?: AbortSignal }>): Promise<WorkspaceSyncTargetConflictApplyResultV1>;
  discardStagedConflictResolutionAtTarget(request: WorkspaceSyncTargetConflictApplyV1 & Readonly<{ signal?: AbortSignal }>): Promise<void>;
  releaseConflictResolutionCaptureHere(request: WorkspaceSyncConflictCaptureReleaseV1): Promise<void>;
  releaseConflictResolutionCaptureAtSource(request: WorkspaceSyncConflictCaptureReleaseV1): Promise<void>;
  readFileAtTarget(request: WorkspaceSyncTargetFileReadRequest): Promise<ReadWorkspaceSyncFileResultV1>;
  observeEntryAtTarget: WorkspaceSyncTargetEntryObserve;
  prepareBootstrapHere(request: WorkspaceSyncTargetBootstrapPrepareV1, signal?: AbortSignal, context?: RpcHandlerContext): Promise<WorkspaceSyncTargetBootstrapPrepareResultV1>;
  releaseBootstrapHere(request: WorkspaceSyncTargetBootstrapReleaseV1, signal?: AbortSignal, context?: RpcHandlerContext): Promise<WorkspaceSyncTargetBootstrapReleaseResultV1>;
  prepareBootstrapAtTarget(request: WorkspaceSyncTargetBootstrapPrepareRequest, context?: RpcHandlerContext): Promise<WorkspaceSyncTargetBootstrapAtTargetResult>;
  releaseBootstrapAtTarget(request: WorkspaceSyncTargetBootstrapReleaseRequest, context?: RpcHandlerContext): Promise<WorkspaceSyncTargetBootstrapReleaseResultV1>;
  acquireWorkspaceSyncMachineIngress(request: AcquireWorkspaceSyncMachineIngressRequest): Promise<WorkspaceSyncMachineIngress>;
  /** Owner-local, non-wire: release retained relationship fences the Project rows no longer own. */
  reconcileRetainedBootstraps(): Promise<void>;
  /** Owner-local, non-wire: release every retained handle on daemon shutdown. */
  releaseAllRetainedBootstraps(): Promise<void>;
  prepareSourceSeedExport(request: Readonly<{ operationId: string; sourceWorkspaceRefId: string; targetMachineId: string; contentPolicy: WorkspaceContentPolicyV1 }>): Promise<Readonly<{
    payloadSource: TransferPayloadSource;
    onDemandScope: DirectPeerOnDemandTransferScope;
  }>>;
  prepareConflictResolutionExport(request: WorkspaceSyncTargetConflictStageV1): Promise<Readonly<{
    payloadSource: TransferPayloadSource;
    onDemandScope: DirectPeerOnDemandTransferScope;
  }>>;
}>;

export type WorkspaceSyncTargetAuthorityDependencies = Readonly<{
  localServerId: string;
  localMachineId: string;
  getProjectSnapshot?: () => ActiveProjectAccountRowsSnapshot | null;
  /** Passive preview reads current Home rows, never the daemon's retained row cache. */
  refreshProjectSnapshot?(signal?: AbortSignal, context?: RpcHandlerContext): Promise<ActiveProjectAccountRowsSnapshot>;
  /** Current ordinary/managed/native facts, supplied by the real daemon composition. */
  readChildMachineFacts?(machineIds: readonly string[], signal?: AbortSignal): Promise<readonly WorkspaceSyncChildMachineFacts[]>;
  /** Host-private installed-child sender. Context and callbacks are never wire input. */
  callWorkspaceTargetPhase?(descriptor: WorkspaceSyncTargetPhaseDescriptor, context: RpcHandlerContext): Promise<unknown>;
  assertConflictResolutionAuthorized?(
    actionReceiptId: string,
    actionInput: WorkspaceSyncConflictResolveActionInputV1,
  ): Promise<void>;
  assertTargetReplacementAuthorized?(
    actionReceiptId: string,
    actionInput: unknown,
    approval: import('@happier-dev/protocol').HandoffTargetReplacementApprovalV1,
  ): Promise<void>;
  assertCommittedCopyRemovalAuthorized?(actionReceiptId: string, actionInput: ProjectWorkerCopyRetireInputV1): Promise<void>;
  readCommittedCopyDependencies?(actionInput: ProjectWorkerCopyRetireInputV1): Promise<readonly ProjectWorkerDependencyV1[]>;
  callMachineRpc(input: Readonly<{
    machineId: string;
    method: string;
    request: unknown;
    signal?: AbortSignal;
  }>): Promise<unknown>;
  bootstrap?: WorkspaceSyncTargetBootstrapAuthorityDependencies;
  openRootedAgent?(input: Readonly<{
    operationId: string;
    role: 'alpha' | 'beta';
    workspaceRefId: string;
    canonicalRoot: string;
    signal?: AbortSignal;
  }>): Promise<WorkspaceSyncOwnedLocalAgent>;
  /**
   * Derived once from the retired-state inspection at the daemon composition
   * boundary. Throws the exact typed legacy-state code before any local
   * delete/read/bootstrap-prepare mutation, routed target call, or rooted
   * agent ingress. Release/cleanup paths stay available: they never mutate
   * workspace state.
   */
  assertLegacyStateAvailable?: () => void;
  prepareSourceSeedExport?: (input: Readonly<{
    operationId: string;
    sourceWorkspaceRefId: string;
    targetMachineId: string;
    contentPolicy: WorkspaceContentPolicyV1;
  }>) => Promise<Readonly<{ payloadSource: TransferPayloadSource; onDemandScope: DirectPeerOnDemandTransferScope }>>;
  resolutionMaterialDirectory?: string;
  resolveLocalResolutionEndpoint?: (relationshipId: string, workspaceRefId: string) => Promise<Readonly<{
    /** The actual retained controller definition; required for transient recovery. */
    relationship?: WorkspaceSyncRelationshipV1;
    canonicalRoot: string;
    assertCurrentAuthority(): Promise<void>;
  }> | null>;
  requestResolutionExport?: (request: WorkspaceSyncTargetConflictStageV1 & Readonly<{ signal?: AbortSignal }>) => Promise<Readonly<{
    requestPayload(request: Readonly<{ transferId: string; destinationPath: string; expectedSizeBytes?: number; expectedManifestHash?: string }>): Promise<void>;
    release(): Promise<void>;
  }>>;
  discoverConflictRecovery?: typeof discoverNativeConfinedWorkspaceSyncRecovery;
  recoverConflictEntry?: typeof recoverWorkspaceSyncEntryReplacementAtRoot;
}>;

/** One read of the admitted relation, shared by Sync preparation and final child Workspace acceptance. */
export async function readWorkspaceSyncChildMachineFacts(input: Readonly<{
  serverId: string;
  serverHttpBaseUrl: string;
  homeTarget?: ResolvedHomeTarget;
  /** Local profile selects credentials/state only; it is never the wire Home qualifier. */
  localProfileId?: string;
  credentials?: StoredCredentials;
  machineIds: readonly string[];
  /** Namespace acceptance never borrows parent storage or requires parent reachability. */
  purpose?: 'physical_sync' | 'child_namespace' | 'admitted_mapping';
  signal?: AbortSignal;
  authorization?: ExternalActionExecutionAuthorizationV1;
  effectActionId?: string;
  externalAction?: NonNullable<Parameters<typeof callExactMachineRpc>[0]['externalAction']>;
}>): Promise<readonly WorkspaceSyncChildMachineFacts[]> {
  const localProfileId = input.localProfileId ?? configuration.activeServerId;
  return await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, async () => {
    const { ApiClient } = await import('@/api/api');
    if (!input.authorization && !input.credentials) throw authorityError('workspace_sync_child_unavailable', 'Requester content custody is unavailable');
    const api = input.authorization ? null : await ApiClient.create(input.credentials!);
    const readMachine = (machineId: string) => input.authorization
      ? ApiClient.getRequesterMachine(machineId, { authorization: input.authorization,
        effectActionId: input.effectActionId, signal: input.signal })
      : api!.getMachine(machineId, { signal: input.signal });
    const facts: WorkspaceSyncChildMachineFacts[] = [];
    for (const machineId of new Set(input.machineIds)) {
      const machine = await readMachine(machineId);
      if (!machine || machine.revokedAt != null || machine.replacedByMachineId) {
        throw authorityError('workspace_sync_child_unavailable', 'Current Machine is unavailable');
      }
      const projection = machine.metadata?.devcontainerChild;
      if (!projection) continue;
      if (projection.observation.storage.kind === 'bind' && input.purpose !== 'child_namespace') {
        try {
          let target = input.homeTarget;
          if (!target) {
            try {
              target = await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: localProfileId });
            } catch (error) {
              if (!(error instanceof HomeTargetResolutionError) || error.code !== 'profile_missing') throw error;
              target = await resolveCliHomeTarget({ kind: 'https_url', url: input.serverHttpBaseUrl });
            }
          }
          const observed = await observeServerFeaturesSnapshot({ serverUrl: input.serverHttpBaseUrl, signal: input.signal });
          const observedHomeId = observed.status === 'ready' ? observed.features.capabilities.serverIdentity.serverIdentityId : null;
          if (!observedHomeId || assertResolvedHomeTargetIdentity(target, observedHomeId) !== input.serverId) {
            throw authorityError('workspace_sync_child_unavailable', 'The physical bind Home identity is unavailable');
          }
        } catch {
          input.signal?.throwIfAborted();
          throw authorityError('workspace_sync_child_unavailable', 'The physical bind Home identity is unavailable');
        }
      }
      if (!machine.installationId || machine.metadata?.username !== projection.observation.user) {
        throw authorityError('workspace_sync_child_unavailable', 'Child installation or native user is unavailable');
      }
      let managedMachine = await readManagedMachine({ credentials: input.credentials,
        serverHttpBaseUrl: input.serverHttpBaseUrl, homeId: input.serverId,
        managedId: projection.relation.managedMachineId, signal: input.signal,
        ...(input.authorization ? { authorization: input.authorization, effectActionId: input.effectActionId } : {}) });
      if (input.purpose !== 'child_namespace' && !isManagedDevcontainerChildProjectionCurrentV1({ homeId: input.serverId, machineId,
        projection, managedMachine })) {
        throw authorityError('workspace_sync_child_unavailable', 'Child enrollment is no longer current');
      }
      let controller: WorkspaceSyncChildMachineFacts['controller'] = { ...managedMachine.controller, available: false };
      if (projection.observation.storage.kind === 'bind' && (input.purpose ?? 'physical_sync') === 'physical_sync') {
        try {
          const current = await readMachine(managedMachine.controller.machineId);
          controller = { machineId: current?.id ?? '', installationId: current?.installationId ?? '',
            available: current?.active === true && current.revokedAt == null && !current.replacedByMachineId };
        } catch {
          input.signal?.throwIfAborted();
          // Native controller failure is a factual unavailable result; child-local execution does not consume it.
        }
        if (controller.available && controller.installationId === managedMachine.controller.installationId) {
          try {
            if (input.authorization && !input.externalAction) throw authorityError('workspace_sync_child_unavailable', 'Requester transport authority is unavailable');
            if (!input.credentials) throw authorityError('workspace_sync_child_unavailable', 'Requester transport custody is unavailable');
            const inspected = ManagedInspectOutputV1Schema.parse(await callExactMachineRpc({ credentials: input.credentials,
              serverUrl: input.serverHttpBaseUrl, machineId: managedMachine.controller.machineId,
              method: 'machines.managed.inspect', request: { homeId: input.serverId, managedId: managedMachine.id },
              ...(input.externalAction ? { externalAction: input.externalAction } : {}),
              requireCurrentMachine: true, timeoutMs: null, signal: input.signal }));
            if (inspected.machine.observation?.availability !== 'present'
              || inspected.machine.controller.installationId !== controller.installationId
              || !isManagedDevcontainerChildProjectionCurrentV1({ homeId: input.serverId, machineId,
                projection, managedMachine: inspected.machine })) {
              throw authorityError('workspace_sync_child_unavailable', 'Native child storage is no longer current');
            }
            managedMachine = inspected.machine;
          } catch {
            input.signal?.throwIfAborted();
            throw authorityError('workspace_sync_child_unavailable', 'Native child storage is unavailable');
          }
        }
      }
      facts.push({ serverId: input.serverId, machineId, installationId: machine.installationId,
        projection, managedMachine, controller });
    }
    return facts;
  });
}

function authorityError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function resolveOwnedWorkspace(
  snapshot: ActiveProjectAccountRowsSnapshot | null,
  relationshipId: string,
  workspaceRefId: string,
  serverId: string,
  requiredState: 'enabled' | 'any' = 'enabled',
): Readonly<{ relationship: WorkspaceSyncRelationshipV1; workspace: WorkspaceRefV1 }> {
  const relationships = snapshot?.relationships ?? [];
  const relationshipMatches = relationships.filter((candidate) => (
    candidate.relationshipId === relationshipId && (requiredState === 'any' || candidate.enabled)
  ));
  if (relationshipMatches.length !== 1) {
    throw authorityError('relationship_not_ready', 'Workspace sync relationship is not ready');
  }
  const relationship = relationshipMatches[0]!;
  if (
    relationship.alphaWorkspaceRefId !== workspaceRefId
    && relationship.betaWorkspaceRefId !== workspaceRefId
  ) {
    throw authorityError('relationship_not_ready', 'Workspace reference is not owned by the relationship');
  }
  return { relationship, workspace: resolveWorkspaceRef(snapshot, workspaceRefId, serverId) };
}

function assertTargetMachine(workspace: WorkspaceRefV1, targetMachineId: string): void {
  if (!targetMachineId.trim() || workspace.machineId.trim() !== targetMachineId.trim()) {
    throw authorityError('peer_unavailable', 'Workspace sync target machine does not own the selected workspace');
  }
}

/**
 * A workspace may name this machine while belonging to another Personal Home.
 * Local target authority exists only for a workspace enrolled through this
 * daemon's current Home; transport reachability is a separate Lane 06 check.
 */
function assertLocalWorkspacePlacement(
  workspace: WorkspaceRefV1,
  localServerId: string,
  localMachineId: string,
): void {
  if (
    !localServerId.trim()
    || workspace.serverId.trim() !== localServerId.trim()
    || !localMachineId.trim()
    || workspace.machineId.trim() !== localMachineId.trim()
  ) {
    throw authorityError(
      'workspace_machine_not_enrolled',
      'Workspace sync target machine is not enrolled in this Home',
    );
  }
}

function assertOkResult(value: unknown): void {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || (value as Readonly<Record<string, unknown>>).ok !== true
  ) {
    throw authorityError('indeterminate', 'Workspace sync target mutation returned an invalid result');
  }
}

function assertResultOk(value: unknown): asserts value is { ok: true; released: boolean } {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || (value as Readonly<Record<string, unknown>>).ok !== true
    || typeof (value as Readonly<Record<string, unknown>>).released !== 'boolean'
  ) {
    throw authorityError('indeterminate', 'Workspace sync target bootstrap release returned an invalid result');
  }
}

/** Resolves the single workspace ref for an id or fails closed. */
function resolveWorkspaceRef(
  snapshot: ActiveProjectAccountRowsSnapshot | null,
  workspaceRefId: string,
  serverId: string,
): WorkspaceRefV1 {
  const workspace = resolveWorkspaceRefById(snapshot?.workspaceRefs ?? [], workspaceRefId, serverId);
  if (!workspace) {
    throw authorityError('peer_unavailable', 'Workspace sync endpoint is unavailable');
  }
  return workspace;
}

async function resolveEnabledRelationshipReplayTarget(input: Readonly<{
  snapshot: ActiveProjectAccountRowsSnapshot | null;
  operationId: string;
  canonicalRoot: string;
  localServerId: string;
  localMachineId: string;
}>): Promise<Readonly<{
  relationship: WorkspaceSyncRelationshipV1;
  target: WorkspaceRefV1;
}> | null> {
  const relationshipId = deriveWorkspaceSyncRelationshipId(input.operationId);
  const matches = (input.snapshot?.relationships ?? []).filter((relationship) => (
    relationship.relationshipId === relationshipId && relationship.enabled
  ));
  if (matches.length !== 1) return null;
  const target = resolveWorkspaceRefById(
    input.snapshot?.workspaceRefs ?? [],
    matches[0]!.betaWorkspaceRefId,
    input.localServerId,
  );
  if (
    !target
    || target.serverId.trim() !== input.localServerId
    || target.machineId.trim() !== input.localMachineId
  ) return null;
  const targetCanonicalRoot = await realpath(target.rootPath).catch(() => null);
  return targetCanonicalRoot === input.canonicalRoot
    ? { relationship: matches[0]!, target }
    : null;
}

/**
 * Resolves the bootstrap owner against the current Project rows and
 * returns the locally resolved target/source roots plus the owner operation
 * id. Every decision is made from the receiving daemon's own snapshot; the
 * caller supplies identity fields only.
 */
function resolveBootstrapOwner(
  snapshot: ActiveProjectAccountRowsSnapshot | null,
  request: WorkspaceSyncTargetBootstrapPrepareV1,
  serverId: string,
  admittedCopy?: Readonly<{ target: WorkspaceRefV1; sourceWriterMachineId: string }>,
): Readonly<{
  operationId: string;
  targetRootPath: string;
  sourceRootPath: string | undefined;
  relationshipId: string | null;
  targetWorkspaceRefId: string;
  targetWorkspace: WorkspaceRefV1;
  sourceWorkspaceRefId: string;
  sourceWorkspace: WorkspaceRefV1 | null;
  sourceMachineId: string;
  endpointRole: 'alpha' | 'beta';
  contentPolicy: WorkspaceContentPolicyV1;
  relationship: WorkspaceSyncRelationshipV1 | null;
}> {
  const target = admittedCopy?.target ?? resolveWorkspaceRef(snapshot, request.targetWorkspaceRefId, serverId);
  if (request.owner.kind === 'relationship') {
    const relationshipId = request.owner.relationshipId;
    const relationships = snapshot?.relationships ?? [];
    const persistedMatches = relationships.filter((candidate) => (
      candidate.relationshipId === relationshipId && candidate.enabled
    ));
    const transient = request.transientRelationship;
    if (transient) {
      const sameId = relationships.filter((candidate) => candidate.relationshipId === relationshipId);
      if (sameId.length > 1 || (sameId[0] && !areWorkspaceSyncRelationshipDefinitionsEqual(sameId[0], transient))) {
        throw authorityError('bootstrap_definition_conflict', 'Transient relationship conflicts with Account Settings');
      }
    } else if (persistedMatches.length !== 1) {
      throw authorityError('relationship_not_ready', 'Workspace sync relationship is not ready');
    }
    const relationship = transient ?? persistedMatches[0]!;
    const alpha = resolveWorkspaceRef(snapshot, relationship.alphaWorkspaceRefId, serverId);
    const beta = resolveWorkspaceRef(snapshot, relationship.betaWorkspaceRefId, serverId);
    const initialRoles = resolveWorkspaceSyncRelationshipEndpointRoles({
      mode: relationship.mode,
      controllerMachineId: relationship.controllerMachineId,
      alphaMachineId: alpha.machineId,
      betaMachineId: beta.machineId,
    });
    if (!initialRoles) {
      throw authorityError('bootstrap_definition_conflict', 'Workspace sync relationship controller placement is invalid');
    }
    const expectedRefId = request.endpointRole === 'alpha'
      ? relationship.alphaWorkspaceRefId
      : relationship.betaWorkspaceRefId;
    if (request.targetWorkspaceRefId !== expectedRefId) {
      throw authorityError('relationship_not_ready', 'Workspace sync bootstrap target does not match the declared relationship endpoint');
    }
    if (request.policyDigest !== relationship.contentPolicy.policyDigest) {
      throw authorityError('bootstrap_definition_conflict', 'Workspace sync bootstrap policy digest conflicts with the relationship');
    }
    const sourceRefId = request.endpointRole === 'alpha'
      ? relationship.betaWorkspaceRefId
      : relationship.alphaWorkspaceRefId;
    const source = sourceRefId === relationship.alphaWorkspaceRefId ? alpha : beta;
    if (request.targetBootstrap !== undefined) {
      if (request.endpointRole !== initialRoles.targetEndpointRole) {
        throw authorityError('bootstrap_definition_conflict', 'Workspace sync bootstrap target does not match the relationship initial roles');
      }
    } else if (!resolveWorkspaceSyncRelationshipTransferDirection({
      relationship,
      sourceWorkspaceRefId: sourceRefId,
      targetWorkspaceRefId: request.targetWorkspaceRefId,
    })) {
      throw authorityError('bootstrap_definition_conflict', 'Workspace sync relationship does not allow this transfer direction');
    }
    return {
      operationId: relationship.relationshipId,
      targetRootPath: target.rootPath,
      sourceRootPath: source.rootPath,
      relationshipId: relationship.relationshipId,
      targetWorkspaceRefId: request.targetWorkspaceRefId,
      targetWorkspace: target,
      sourceWorkspaceRefId: sourceRefId,
      sourceWorkspace: source,
      sourceMachineId: source.machineId.trim(),
      endpointRole: request.endpointRole,
      contentPolicy: relationship.contentPolicy,
      relationship,
    };
  }
  const operation = request.owner.operation;
  // A copy_once operation always bootstraps its beta endpoint.
  if (request.endpointRole !== 'beta' || request.targetWorkspaceRefId !== operation.betaWorkspaceRefId) {
    throw authorityError('bootstrap_definition_conflict', 'Workspace sync bootstrap target does not match the copy_once operation');
  }
  if (request.policyDigest !== operation.contentPolicy.policyDigest) {
    throw authorityError('bootstrap_definition_conflict', 'Workspace sync bootstrap policy digest conflicts with the copy_once operation');
  }
  if (admittedCopy && operation.controllerMachineId.trim() !== admittedCopy.sourceWriterMachineId) {
    throw authorityError('bootstrap_definition_conflict', 'Workspace sync copy controller does not match the admitted source writer');
  }
  const remoteSource = admittedCopy && admittedCopy.sourceWriterMachineId !== target.machineId.trim();
  const source = remoteSource ? null : resolveWorkspaceRef(snapshot, operation.alphaWorkspaceRefId, serverId);
  const sourceMachineId = source?.machineId.trim() ?? admittedCopy!.sourceWriterMachineId;
  if (operation.controllerMachineId.trim() !== sourceMachineId) {
    throw authorityError('bootstrap_definition_conflict', 'Workspace sync copy controller does not own the source endpoint');
  }
  return {
    operationId: operation.operationId,
    targetRootPath: target.rootPath,
    sourceRootPath: source?.rootPath,
    relationshipId: null,
    targetWorkspaceRefId: target.id,
    targetWorkspace: target,
    sourceWorkspaceRefId: operation.alphaWorkspaceRefId,
    sourceWorkspace: source,
    sourceMachineId,
    endpointRole: request.endpointRole,
    contentPolicy: operation.contentPolicy,
    relationship: null,
  };
}

/** Stable canonical definition used to distinguish idempotent duplicates from conflicts. */
function canonicalBootstrapDefinition(request: WorkspaceSyncTargetBootstrapPrepareV1): string {
  const owner = request.owner.kind === 'relationship'
    ? { kind: 'relationship', relationshipId: request.owner.relationshipId }
    : {
      kind: 'copy_once',
      operation: {
        v: request.owner.operation.v,
        operationId: request.owner.operation.operationId,
        controllerMachineId: request.owner.operation.controllerMachineId,
        alphaWorkspaceRefId: request.owner.operation.alphaWorkspaceRefId,
        betaWorkspaceRefId: request.owner.operation.betaWorkspaceRefId,
        contentPolicy: {
          v: request.owner.operation.contentPolicy.v,
          selection: request.owner.operation.contentPolicy.selection,
          extraIgnorePatterns: [...request.owner.operation.contentPolicy.extraIgnorePatterns],
          extraIncludePatterns: [...request.owner.operation.contentPolicy.extraIncludePatterns],
          policyDigest: request.owner.operation.contentPolicy.policyDigest,
        },
      },
    };
  return JSON.stringify({
    v: request.v,
    bootstrapOperationId: request.bootstrapOperationId,
    owner,
    ...(request.transientRelationship ? { transientRelationship: request.transientRelationship } : {}),
    targetWorkspaceRefId: request.targetWorkspaceRefId,
    endpointRole: request.endpointRole,
    policyDigest: request.policyDigest,
    createIfMissing: request.createIfMissing,
    ...(request.targetBootstrap ? { targetBootstrap: request.targetBootstrap } : {}),
    ...(request.targetReplacementApproval
      ? { targetReplacementApproval: request.targetReplacementApproval }
      : {}),
  });
}

type RetainedSourceWriterTargetRouting = Omit<WorkspaceSyncSourceWriterTargetRoutingV1, 'target'> & Readonly<{
  target: Omit<WorkspaceSyncSourceWriterTargetRoutingV1['target'], 'phase'>;
}>;

type RetainedBootstrap = Readonly<{
  bootstrapOperationId: string;
  definition: string;
  result: WorkspaceSyncTargetBootstrapPrepareResultV1;
  handle: WorkspaceRootOwnershipHandle;
  materializationCustody?: WorkspaceExportMaterializationCustody;
  publishReady(): Promise<void>;
  /** Process-local projection of the durable READY fact; true means custody may only commit. */
  readyPublished: boolean;
  relationshipId: string | null;
  operationId: string;
  sourceWorkspaceRefId: string;
  sourceMachineId: string;
  sourceRootPath: string | undefined;
  targetWorkspaceRefId: string;
  targetMachineId: string;
  targetRootPath: string;
  endpointRole: 'alpha' | 'beta';
  relationshipDefinition: WorkspaceSyncRelationshipV1 | null;
  /** Existing transient authority retained only until its durable relationship is observed enabled. */
  transientAuthority: boolean;
  createIfMissing: boolean;
  /** Original admitted child authority; cleanup never substitutes the parent custodian. */
  targetRouting?: Omit<WorkspaceSyncTargetRoutingV1, 'phase'>;
  /** The same installed source writer may release this loan after child retirement. */
  sourceWriterTargetRouting?: RetainedSourceWriterTargetRouting;
}>;

type ResolvedBootstrapOwner = ReturnType<typeof resolveBootstrapOwner>;

function retainedBootstrapMatchesOwner(
  entry: RetainedBootstrap,
  owner: ResolvedBootstrapOwner,
  request: WorkspaceSyncTargetBootstrapPrepareV1,
): boolean {
  return entry.relationshipId === owner.relationshipId
    && entry.operationId === owner.operationId
    && entry.sourceWorkspaceRefId === owner.sourceWorkspaceRefId
    && entry.sourceMachineId === owner.sourceMachineId
    && entry.sourceRootPath === owner.sourceRootPath
    && entry.targetWorkspaceRefId === owner.targetWorkspaceRefId
    && entry.targetMachineId === owner.targetWorkspace.machineId.trim()
    && entry.targetRootPath === owner.targetRootPath
    && entry.endpointRole === owner.endpointRole
    && entry.result.policyDigest === request.policyDigest
    && (entry.relationshipDefinition === null
      ? owner.relationship === null
      : owner.relationship !== null
        && areWorkspaceSyncRelationshipDefinitionsEqual(entry.relationshipDefinition, owner.relationship));
}

/**
 * Relationship creation prepares the target from transient intent, then the
 * same operation re-enters after that exact definition is published to
 * Account Settings. Bootstrap mechanics are intentionally absent on the
 * settings-owned replay; every stable relationship/endpoint fact must still
 * match the retained authority.
 */
function isExactPersistedRelationshipReentry(
  entry: RetainedBootstrap,
  owner: ResolvedBootstrapOwner,
  request: WorkspaceSyncTargetBootstrapPrepareV1,
): boolean {
  return request.owner.kind === 'relationship'
    && request.transientRelationship === undefined
    && request.targetBootstrap === undefined
    && request.targetReplacementApproval === undefined
    && entry.bootstrapOperationId === request.bootstrapOperationId
    && entry.relationshipDefinition !== null
    && entry.createIfMissing === request.createIfMissing
    && retainedBootstrapMatchesOwner(entry, owner, request);
}

function retainedAuthorityKey(input: Readonly<{
  relationshipId: string | null;
  operationId: string;
  endpointRole: 'alpha' | 'beta';
  targetWorkspaceRefId: string;
}>): string {
  return JSON.stringify(input.relationshipId
    ? ['relationship', input.relationshipId, input.endpointRole, input.targetWorkspaceRefId]
    : ['copy_once', input.operationId, input.endpointRole, input.targetWorkspaceRefId]);
}

function closeListeningServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

export function createWorkspaceSyncTargetAuthority(
  dependencies: WorkspaceSyncTargetAuthorityDependencies,
): WorkspaceSyncTargetAuthority {
  const localMachineId = dependencies.localMachineId.trim();
  const localServerId = dependencies.localServerId.trim();
  if (!localMachineId) throw new TypeError('Workspace sync target authority requires a local machine id');
  if (!localServerId) throw new TypeError('Workspace sync target authority requires a local server id');
  const readSnapshot = dependencies.getProjectSnapshot ?? getActiveProjectAccountRowsSnapshot;
  const getSnapshot = (): ActiveProjectAccountRowsSnapshot => {
    const snapshot = readSnapshot();
    if (!snapshot) {
      throw authorityError('project_account_rows_unavailable', 'Project rows are unavailable');
    }
    return snapshot;
  };
  const readInvocationSnapshot = async (signal?: AbortSignal, context?: RpcHandlerContext): Promise<ActiveProjectAccountRowsSnapshot> => {
    const authorization = context?.callerInputAuthorization;
    if (!authorization) return getSnapshot();
    const account = authorization.requesterAccountProjection;
    const http = authorization.requesterHttpProjection;
    if (!account || !http || !dependencies.refreshProjectSnapshot
      || account.accountId !== authorization.binding.accountId || http.accountId !== account.accountId
      || account.serverId !== localServerId || http.serverId !== localServerId
      || context?.machineAdmission?.actorAccountId !== account.accountId
      || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()
      || !await account.isCurrent() || !await http.isCurrent()) {
      throw authorityError('project_requester_authority_unavailable', 'The admitted requester is no longer current');
    }
    signal?.throwIfAborted();
    return await dependencies.refreshProjectSnapshot(signal, context);
  };
  const bootstrap = dependencies.bootstrap ?? null;
  const assertStateAvailable = dependencies.assertLegacyStateAvailable ?? (() => undefined);

  // The receipt names the chosen execution namespace. Only the canonical native
  // mapper can bind it to this owner's physical filesystem; it never restamps it.
  const readReplacementTarget = async (machineId: string, rootPath: string, signal?: AbortSignal) => {
    const childMachines = await dependencies.readChildMachineFacts?.([machineId], signal) ?? [];
    const facts = childMachines.filter(child => child.serverId === localServerId && child.machineId === machineId);
    if (facts.length === 0) return { machineId, rootPath, approvalRoot: null, facts, workspace: null, endpoint: null };
    const workspaceRefs = getSnapshot().workspaceRefs;
    const workspace = resolveWorkspaceRefV1(workspaceRefs, { serverId: localServerId, machineId, rootPath });
    if (workspace.kind !== 'resolved') {
      throw authorityError('workspace_sync_child_unavailable', 'The chosen child target root is unavailable');
    }
    const mapped = resolveWorkspaceSyncEndpoint({ workspace: workspace.ref, workspaceRefs, childMachines });
    if (!mapped.ok) throw authorityError(mapped.code, 'The chosen child target storage is unavailable');
    return { machineId: mapped.endpoint.machineId, rootPath: mapped.endpoint.rootPath,
      approvalRoot: mapped.endpoint.id === workspace.ref.id ? null : workspace.ref.rootPath,
      facts, workspace: workspace.ref, endpoint: mapped.endpoint };
  };
  const bindReplacementTarget = async (machineId: string, rootPath: string, signal?: AbortSignal) => {
    const accepted = await readReplacementTarget(machineId, rootPath, signal);
    return { ...accepted, assertCurrent: async () => {
      const current = await readReplacementTarget(machineId, rootPath, signal);
      const address = (workspace: WorkspaceRefV1 | null) => workspace === null ? null : {
        id: workspace.id, serverId: workspace.serverId, machineId: workspace.machineId,
        rootPath: workspace.rootPath, projectKey: workspace.projectKey,
      };
      const binding = (target: typeof accepted) => ({
        machineId: target.machineId, rootPath: target.rootPath, approvalRoot: target.approvalRoot,
        workspace: address(target.workspace), endpoint: address(target.endpoint),
        facts: target.facts.map(fact => ({ installationId: fact.installationId,
          projection: fact.projection, controller: fact.controller })),
      });
      if (!isDeepStrictEqual(binding(current), binding(accepted))) {
        throw authorityError('workspace_sync_child_unavailable', 'The chosen child target storage changed before replacement');
      }
    } };
  };

  // Process-local custody is keyed by stable relationship endpoint authority,
  // not by the handoff request that happened to prepare it. The Project rows and
  // final READY fact remain the restart sources; no runtime id is persisted.
  const retained = new Map<string, RetainedBootstrap>();
  const readTargetRouting = async (
    context: RpcHandlerContext | undefined,
    phase: 'prepare' | 'release',
    operationId: string,
  ): Promise<Omit<WorkspaceSyncTargetRoutingV1, 'phase'> | undefined> => {
    if (!context?.workspaceSyncTargetRouting) return undefined;
    const { phase: admittedPhase, ...routing } = WorkspaceSyncTargetRoutingV1Schema.parse(context.workspaceSyncTargetRouting);
    if (admittedPhase !== phase || routing.operationId !== operationId || routing.accountServerId !== localServerId
      || routing.targetMachineId !== context.machineAdmission?.machineId
      || !isDeepStrictEqual(routing.targetContext.machineAdmission, context.machineAdmission)
      || routing.targetContext.callerAuthority !== context.callerAuthority
      || !isDeepStrictEqual(routing.targetContext.sessionActionOrigin, context.sessionActionOrigin)
      || !isDeepStrictEqual(routing.targetContext.callerInputConstraints, context.callerInputConstraints)
      || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()) {
      throw authorityError('workspace_sync_child_unavailable', 'The original target admission is unavailable');
    }
    return routing;
  };
  const readSourceWriterTargetRouting = async (
    context: RpcHandlerContext | undefined,
    phase: 'prepare' | 'release',
    operationId: string,
    targetRouting?: Omit<WorkspaceSyncTargetRoutingV1, 'phase'>,
  ): Promise<RetainedSourceWriterTargetRouting | undefined> => {
    const raw = context && 'workspaceSyncSourceWriterTargetRouting' in context
      ? context.workspaceSyncSourceWriterTargetRouting : undefined;
    if (!raw) return undefined;
    const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(raw);
    const { phase: admittedPhase, ...target } = routing.target;
    if (admittedPhase !== phase || target.operationId !== operationId || target.accountServerId !== localServerId) {
      throw authorityError('bootstrap_definition_conflict', 'Source writer target phase does not match this operation');
    }
    if (phase === 'prepare') {
      if (!targetRouting) throw authorityError('workspace_sync_child_unavailable', 'The admitted target context is unavailable');
      const { targetContext: _targetContext, ...admittedTarget } = targetRouting;
      if (!isDeepStrictEqual(target, admittedTarget)) {
        throw authorityError('bootstrap_definition_conflict', 'Source writer target placement does not match the admitted target');
      }
    } else {
      const admission = context?.machineAdmission;
      if (context?.workspaceSyncTargetRouting || !admission
        || admission.machineId !== routing.sourceWriter.machineId
        || admission.installationId !== routing.sourceWriter.installationId
        || admission.actorAccountId !== admission.custodianAccountId
        || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()) {
        throw authorityError('workspace_sync_child_unavailable', 'The installed source writer cleanup transport is unavailable');
      }
    }
    return { ...routing, target };
  };
  const assertPrepareWrites = (
    request: WorkspaceSyncTargetBootstrapPrepareV1,
    targetContext: WorkspaceSyncTargetRoutingV1['targetContext'],
    relationship: WorkspaceSyncRelationshipV1 | null = null,
  ): void => {
    const contentPolicy = relationship?.contentPolicy
      ?? (request.owner.kind === 'copy_once' ? request.owner.operation.contentPolicy : null);
    if (!contentPolicy) throw authorityError('relationship_not_ready', 'The workspace relationship is unavailable');
    const workspaceAction = relationship && request.targetBootstrap !== undefined
      ? { kind: 'create_relationship', mode: relationship.mode, contentPolicy, flushBeforeCommit: true }
      : relationship
        ? { kind: 'relationship', relationshipId: relationship.relationshipId, flushBeforeCommit: false }
        : { kind: 'copy_once', contentPolicy };
    const admission = resolveWorkspaceWriteActionAdmissionV1({ spec: getActionSpec('session.handoff'),
      actionInput: { workspaceAction }, workspaceWrites: targetContext.workspaceWrites,
      currentWorkspaceWrites: targetContext.sessionActionOrigin?.workspaceWrites,
      agentCaller: targetContext.sessionActionOrigin !== undefined });
    if (!admission.ok) throw authorityError(admission.errorCode, admission.errorCode);
  };
  const inFlight = new Map<string, Promise<unknown>>();
  const activeIngresses = new Map<string, Set<() => Promise<void>>>();
  const sourceLoans = new Map<string, Set<string>>();
  const sourceLoanOwners = new Map<string, string>();
  const deferredDiscards = new Map<string, 'commit' | 'abort'>();
  const activityListeners = new Set<() => void>();
  const notifyActivity = (): void => {
    for (const listener of activityListeners) {
      try { listener(); } catch { /* Observation cannot change target custody. */ }
    }
  };
  const activity: LiveWorkProducerV1 = Object.freeze({
    read(): Omit<LiveWorkInventoryV1, 'idleSince'> {
      assertStateAvailable();
      const ids = new Set([...retained.keys(), ...inFlight.keys(), ...activeIngresses.keys(),
        ...sourceLoans.keys(), ...deferredDiscards.keys()]);
      const items: LiveWorkItemV1[] = [...ids].map(ownerRef => {
        const entry = retained.get(ownerRef);
        const held = inFlight.has(ownerRef) || (activeIngresses.get(ownerRef)?.size ?? 0) > 0
          || (sourceLoans.get(ownerRef)?.size ?? 0) > 0 || deferredDiscards.has(ownerRef)
          || (entry && (!entry.readyPublished || entry.transientAuthority || entry.relationshipId === null));
        const settled = entry?.readyPublished && (!entry.materializationCustody || entry.materializationCustody.receipt.committed !== undefined);
        return { category: 'sync', ownerRef, attribution: { kind: 'unknown' },
          state: held ? 'active' : settled ? 'settled' : 'unknown' };
      });
      return { items, coverage: closing || readSnapshot() === null ? 'unknown' : 'complete' };
    },
    subscribe(listener: () => void): () => void {
      activityListeners.add(listener);
      return () => { activityListeners.delete(listener); };
    },
  });
  let closing = false;

  const commitPublishedMaterializationCustody = async (entry: RetainedBootstrap): Promise<void> => {
    if (!entry.readyPublished) return;
    await entry.materializationCustody?.commit();
  };

  const parseCommittedCopy = (request: WorkspaceSyncCommittedCopyRequest) => {
    assertStateAvailable();
    request.signal?.throwIfAborted();
    // Signal is owner-local cancellation, not part of the closed wire authority envelope.
    const { signal: _signal, ...wire } = request;
    const parsed = WorkspaceSyncCommittedCopyTargetV1Schema.parse(wire);
    const relationship = parsed.actionInput.expectedRelationship;
    const removal = parsed.actionInput.removeTargetCopy!;
    const workerCopy = getWorkspaceSyncWorkerCopyV1(relationship);
    if (!workerCopy) throw authorityError('workspace_copy_not_worker', 'Workspace relationship has no worker-copy creation provenance');
    if (removal.workspaceRefId !== workerCopy.targetWorkspaceRefId) {
      throw authorityError('workspace_unavailable', 'Workspace removal is not the worker-copy target');
    }
    if (parsed.actionInput.workspace.serverId !== localServerId
      || parsed.actionInput.machineId !== relationship.controllerMachineId
      || ![relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId].includes(parsed.actionInput.workspace.refId)
      || ![relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId].includes(removal.workspaceRefId)) {
      throw authorityError('approval_stale', 'Reviewed workspace retirement placement changed');
    }
    return { parsed, relationship, removal, workerCopy };
  };

  const resolveCommittedCopy = (request: WorkspaceSyncCommittedCopyRequest) => {
    const { parsed, relationship, removal, workerCopy } = parseCommittedCopy(request);
    if (!bootstrap) throw authorityError('target_bootstrap_required', 'Workspace copy custody is unavailable');
    const snapshot = getSnapshot();
    const endpointRole = relationship.alphaWorkspaceRefId === removal.workspaceRefId ? 'alpha'
      : relationship.betaWorkspaceRefId === removal.workspaceRefId ? 'beta' : null;
    if (!endpointRole) throw authorityError('bootstrap_definition_conflict', 'Workspace is not a reviewed relationship endpoint');
    const workspace = resolveWorkspaceRef(snapshot, removal.workspaceRefId, localServerId);
    if (workspace.machineId.trim() !== localMachineId) {
      throw authorityError('workspace_sync_target_mismatch', 'Committed copy removal must run at its target machine');
    }
    return {
      relationship,
      parsed,
      workspace,
      snapshot,
      endpointRole,
      bootstrap,
      copy: {
        rootPath: workspace.rootPath,
        relationshipId: relationship.relationshipId,
        endpointRole,
        rootFingerprint: removal.rootFingerprint,
        materializationDirectory: bootstrap.materializationDirectory,
        workerCopyCreation: { serverId: localServerId, relationshipId: relationship.relationshipId,
          sourceWorkspaceRefId: workerCopy.sourceWorkspaceRefId,
          targetWorkspaceRefId: removal.workspaceRefId },
        ...(request.signal ? { signal: request.signal } : {}),
      } satisfies Parameters<typeof inspectWorkspaceSyncCommittedCopy>[0],
    };
  };

  const assertCommittedCopyApproved = async (request: WorkspaceSyncCommittedCopyRequest) => {
    const { parsed } = parseCommittedCopy(request);
    if (!dependencies.assertCommittedCopyRemovalAuthorized) {
      throw authorityError('approval_required', 'Workspace copy removal Action receipt authority is unavailable');
    }
    await dependencies.assertCommittedCopyRemovalAuthorized(parsed.actionReceiptId, parsed.actionInput);
    if (!dependencies.readCommittedCopyDependencies) {
      throw authorityError('workspace_sync_dependencies_unavailable', 'Workspace copy dependencies are unavailable');
    }
    const active = await dependencies.readCommittedCopyDependencies(parsed.actionInput);
    if (active.length > 0) {
      throw Object.assign(authorityError('workspace_sync_relationship_in_use', 'Workspace copy has dependent work'), { dependencies: active });
    }
  };

  const assertCommittedCopyRelationshipCurrent = (snapshot: ActiveProjectAccountRowsSnapshot, relationship: WorkspaceSyncRelationshipV1) => {
    const matches = snapshot.relationships.filter((value) => value.relationshipId === relationship.relationshipId);
    if (matches.length !== 1 || !areWorkspaceSyncRelationshipDefinitionsEqual(matches[0]!, relationship)
      || !areWorkspaceSyncWorkerCopyProvenancesEqual(matches[0]!, relationship)
      || matches[0]!.enabled !== relationship.enabled
      || matches[0]!.createdAtMs !== relationship.createdAtMs
      || matches[0]!.updatedAtMs !== relationship.updatedAtMs) {
      throw authorityError('bootstrap_definition_conflict', 'Workspace relationship changed since review');
    }
  };

  const resolveCommittedCopyPreview = (request: WorkspaceSyncCommittedCopyPreviewRequest, snapshot: ActiveProjectAccountRowsSnapshot) => {
    assertStateAvailable();
    request.signal?.throwIfAborted();
    const { signal: _signal, ...wire } = request;
    const parsed = WorkspaceSyncCommittedCopyPreviewV1Schema.parse(wire);
    const relationship = parsed.expectedRelationship;
    const endpoints = [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId];
    if (parsed.workspace.serverId !== localServerId || parsed.machineId !== relationship.controllerMachineId
      || !endpoints.includes(parsed.workspace.refId) || !endpoints.includes(parsed.targetWorkspaceRefId)) {
      throw authorityError('root_mismatch', 'Workspace copy preview placement changed');
    }
    assertCommittedCopyRelationshipCurrent(snapshot, relationship);
    // Both endpoints must still belong to this Home's canonical Account graph.
    for (const workspaceRefId of endpoints) resolveWorkspaceRef(snapshot, workspaceRefId, localServerId);
    const workspace = resolveWorkspaceRef(snapshot, parsed.targetWorkspaceRefId, localServerId);
    if (workspace.machineId.trim() !== parsed.targetMachineId) {
      throw authorityError('root_mismatch', 'Workspace copy preview target changed');
    }
    return { parsed, relationship, workspace,
      endpointRole: relationship.alphaWorkspaceRefId === workspace.id ? 'alpha' as const : 'beta' as const };
  };

  const refreshCommittedCopyPreview = async (request: WorkspaceSyncCommittedCopyPreviewRequest) => {
    assertStateAvailable();
    request.signal?.throwIfAborted();
    if (!dependencies.refreshProjectSnapshot) {
      throw authorityError('workspace_copy_preview_unavailable', 'Current Home rows for workspace copy preview are unavailable');
    }
    return resolveCommittedCopyPreview(request, await dependencies.refreshProjectSnapshot(request.signal));
  };

  const inspectCommittedCopyPreviewHere = async (
    request: WorkspaceSyncCommittedCopyPreviewRequest,
    resolved: ReturnType<typeof resolveCommittedCopyPreview>,
  ): Promise<WorkspaceSyncCommittedCopyPreviewResultV1> => {
    if (resolved.workspace.machineId.trim() !== localMachineId) {
      throw authorityError('root_mismatch', 'Workspace copy preview must run at its physical target');
    }
    if (!bootstrap) throw authorityError('target_bootstrap_required', 'Workspace copy custody is unavailable');
    let observed: Readonly<{ rootFingerprint: string; sizeBytes?: number }> | null = null;
    try {
      observed = await inspectWorkspaceSyncCommittedCopy({ rootPath: resolved.workspace.rootPath,
        relationshipId: resolved.relationship.relationshipId, endpointRole: resolved.endpointRole,
        materializationDirectory: bootstrap.materializationDirectory,
        measureSize: true,
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'workspace_copy_not_owned')) throw error;
    }
    const current = await refreshCommittedCopyPreview(request);
    if (current.workspace.rootPath !== resolved.workspace.rootPath) {
      throw authorityError('root_mismatch', 'Workspace copy preview root changed during inspection');
    }
    if (!observed) return { ok: false, errorCode: 'workspace_copy_not_owned' };
    return { ok: true, preview: { targetMachineId: resolved.workspace.machineId.trim(),
      workspaceRefId: resolved.workspace.id, rootFingerprint: observed.rootFingerprint,
      ...(observed.sizeBytes === undefined ? {} : { sizeBytes: observed.sizeBytes }) } };
  };

  const committedCopyAtTarget = async (request: WorkspaceSyncCommittedCopyRequest, phase: 'inspect' | 'remove') => {
    const { parsed, removal } = parseCommittedCopy(request);
    const workspace = resolveWorkspaceRef(getSnapshot(), removal.workspaceRefId, localServerId);
    if (workspace.machineId.trim() === localMachineId) {
      await (phase === 'inspect' ? authority.inspectCommittedCopyHere : authority.removeCommittedCopyHere)(request);
      return;
    }
    const result = await dependencies.callMachineRpc({ machineId: workspace.machineId.trim(),
      method: phase === 'inspect' ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT : RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_REMOVE,
      request: parsed, ...(request.signal ? { signal: request.signal } : {}),
    });
    const parsedResult = WorkspaceSyncCommittedCopyTargetResultV1Schema.safeParse(result);
    if (!parsedResult.success) {
      assertOkResult(result);
      throw parsedResult.error;
    }
    if (!parsedResult.data.ok) {
      throw Object.assign(authorityError(parsedResult.data.errorCode, 'Workspace copy has dependent work'), { dependencies: parsedResult.data.dependencies });
    }
  };

  const exclusive = <T>(id: string, action: () => Promise<T>, allowClosing = false): Promise<T> => {
    const prior = inFlight.get(id) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(async () => {
      if (closing && !allowClosing) throw authorityError('peer_unavailable', 'Workspace sync target authority is shutting down');
      return await action();
    });
    const registered = next.catch(() => undefined);
    inFlight.set(id, registered);
    notifyActivity();
    void registered.then(() => { if (inFlight.get(id) === registered) inFlight.delete(id); notifyActivity(); });
    return next;
  };

  const discardRetained = async (
    authorityKey: string,
    outcome: 'commit' | 'abort' = 'abort',
  ): Promise<void> => {
    let entry = retained.get(authorityKey);
    if (!entry) return;
    const cleanupFailures: unknown[] = [];
    let materializationCustodyExternalized = false;
    let custodySettlementFailed = false;
    const ingressClosers = [...(activeIngresses.get(authorityKey) ?? [])];
    const ingressResults = await Promise.allSettled(ingressClosers.map(async (close) => await close()));
    for (const result of ingressResults) {
      if (result.status === 'rejected') cleanupFailures.push(result.reason);
    }
    if (cleanupFailures.length === 1) throw cleanupFailures[0];
    if (cleanupFailures.length > 1) {
      throw new AggregateError(cleanupFailures, 'Workspace sync target ingress cleanup failed');
    }
    if ((sourceLoans.get(authorityKey)?.size ?? 0) > 0) {
      // The relationship may stop while a copy is reading its old spoke.
      // Close ingress now, but keep its physical source handle until that
      // finite borrower releases it.
      deferredDiscards.set(authorityKey, outcome);
      return;
    }
    try {
      if (outcome === 'commit' || entry.readyPublished) {
        if (!entry.readyPublished) {
          await entry.publishReady();
          entry = { ...entry, readyPublished: true };
          retained.set(authorityKey, entry);
        }
        await commitPublishedMaterializationCustody(entry);
      }
      else await entry.materializationCustody?.abort();
    } catch (error) {
      custodySettlementFailed = true;
      materializationCustodyExternalized = (error as { code?: unknown }).code
        === 'workspace_target_materialization_manual_recovery';
      // The durable receipt is now the sole recovery authority. Keeping this
      // process-local entry would retry a destructive action that has already
      // failed its object-custody proof on every later reconcile/shutdown.
      if (!materializationCustodyExternalized) cleanupFailures.push(error);
    }
    if (outcome === 'commit' && !entry.readyPublished && cleanupFailures.length > 0) {
      if (cleanupFailures.length === 1) throw cleanupFailures[0];
      throw new AggregateError(cleanupFailures, 'Workspace sync target READY publication failed');
    }
    if (entry.readyPublished && custodySettlementFailed && !materializationCustodyExternalized) {
      if (cleanupFailures.length === 1) throw cleanupFailures[0];
      throw new AggregateError(cleanupFailures, 'Workspace sync committed target custody cleanup failed');
    }
    await entry.handle.release().catch((error: unknown) => {
      cleanupFailures.push(error);
    });
    if (cleanupFailures.length === 0 || materializationCustodyExternalized) {
      retained.delete(authorityKey);
      activeIngresses.delete(authorityKey);
      deferredDiscards.delete(authorityKey);
      notifyActivity();
      if (cleanupFailures.length === 0) return;
    }
    if (cleanupFailures.length === 1) throw cleanupFailures[0];
    throw new AggregateError(cleanupFailures, 'Workspace sync target authority cleanup failed');
  };

  const relationshipOwnsEndpoint = (
    snapshot: ActiveProjectAccountRowsSnapshot | null,
    entry: RetainedBootstrap,
    requireEnabled: boolean,
  ): boolean => {
    if (!entry.relationshipId) return false;
    const matches = (snapshot?.relationships ?? []).filter((candidate) => (
      candidate.relationshipId === entry.relationshipId && (!requireEnabled || candidate.enabled)
    ));
    if (matches.length !== 1) return false;
    const relationship = matches[0]!;
    const expectedTargetRef = entry.endpointRole === 'alpha'
      ? relationship.alphaWorkspaceRefId
      : relationship.betaWorkspaceRefId;
    const expectedSourceRef = entry.endpointRole === 'alpha'
      ? relationship.betaWorkspaceRefId
      : relationship.alphaWorkspaceRefId;
    const target = resolveWorkspaceRefById(snapshot?.workspaceRefs ?? [], expectedTargetRef, localServerId);
    const source = resolveWorkspaceRefById(snapshot?.workspaceRefs ?? [], expectedSourceRef, localServerId);
    return expectedTargetRef === entry.targetWorkspaceRefId
      && expectedSourceRef === entry.sourceWorkspaceRefId
      && entry.relationshipDefinition !== null
      && areWorkspaceSyncRelationshipDefinitionsEqual(relationship, entry.relationshipDefinition)
      && target?.serverId.trim() === localServerId.trim()
      && target?.machineId.trim() === entry.targetMachineId
      && source?.machineId.trim() === entry.sourceMachineId
      && relationship.contentPolicy.policyDigest === entry.result.policyDigest;
  };

  /** A retained relationship fence must survive only while its durable relationship owns the endpoint. */
  const relationshipStillOwnsEndpoint = (
    snapshot: ActiveProjectAccountRowsSnapshot | null,
    entry: RetainedBootstrap,
  ): boolean => relationshipOwnsEndpoint(snapshot, entry, true);

  const rehydrateRelationshipEndpoint = async (input: Readonly<{
    relationship: WorkspaceSyncRelationshipV1;
    endpointRole: 'alpha' | 'beta';
    targetWorkspace: WorkspaceRefV1;
    sourceWorkspace: WorkspaceRefV1;
    recoverMaterializationOnly?: boolean;
  }>): Promise<RetainedBootstrap | null> => {
    if (!bootstrap || input.targetWorkspace.machineId.trim() !== localMachineId) return null;
    assertLocalWorkspacePlacement(input.targetWorkspace, localServerId, localMachineId);
    const authorityKey = retainedAuthorityKey({
      relationshipId: input.relationship.relationshipId,
      operationId: input.relationship.relationshipId,
      endpointRole: input.endpointRole,
      targetWorkspaceRefId: input.targetWorkspace.id,
    });
    return await exclusive(authorityKey, async () => {
      const existing = retained.get(authorityKey);
      if (existing) {
        await commitPublishedMaterializationCustody(existing);
        return existing;
      }
      const prepared = await rehydrateWorkspaceSyncTargetBootstrap({
        rootPath: input.targetWorkspace.rootPath,
        relationshipId: input.relationship.relationshipId,
        endpointRole: input.endpointRole,
        targetWorkspaceRefId: input.targetWorkspace.id,
        policyDigest: input.relationship.contentPolicy.policyDigest,
        contentSelection: input.relationship.contentPolicy.selection,
        materializationDirectory: bootstrap.materializationDirectory,
        rootOwnershipManager: bootstrap.rootOwnershipManager,
        ...(input.recoverMaterializationOnly ? { requireMaterializationReceipt: true } : {}),
        ...(bootstrap.prepareGitTarget ? { prepareGitTarget: bootstrap.prepareGitTarget } : {}),
      }, bootstrap.rehydrateMaterializationFromReceiptPath
        ? { rehydrateMaterializationFromReceiptPath: bootstrap.rehydrateMaterializationFromReceiptPath }
        : undefined);
      if (!prepared) return null;
      const bootstrapOperationId = `rehydrated:${input.relationship.relationshipId}:${input.endpointRole}`;
      const result = WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse({
        v: 1,
        bootstrapOperationId,
        targetWorkspaceRefId: input.targetWorkspace.id,
        state: 'ready',
        created: false,
        rootFingerprint: prepared.rootFingerprint,
        policyDigest: prepared.policyDigest,
      });
      const entry: RetainedBootstrap = {
        bootstrapOperationId,
        definition: 'rehydrated-from-settings-and-materialization-receipt',
        result,
        handle: prepared.ownershipHandles[0]!,
        relationshipId: input.relationship.relationshipId,
        operationId: input.relationship.relationshipId,
        sourceWorkspaceRefId: input.sourceWorkspace.id,
        sourceMachineId: input.sourceWorkspace.machineId.trim(),
        sourceRootPath: input.sourceWorkspace.rootPath,
        targetWorkspaceRefId: input.targetWorkspace.id,
        targetMachineId: input.targetWorkspace.machineId.trim(),
        targetRootPath: input.targetWorkspace.rootPath,
        endpointRole: input.endpointRole,
        relationshipDefinition: input.relationship,
        transientAuthority: false,
        createIfMissing: false,
        ...(prepared.materializationCustody
          ? { materializationCustody: prepared.materializationCustody }
          : {}),
        publishReady: prepared.publishReady,
        readyPublished: prepared.readyPublished,
      };
      retained.set(authorityKey, entry);
      await commitPublishedMaterializationCustody(entry);
      return entry;
    });
  };

  const rehydrateCopyOnceEndpoint = async (input: Readonly<{
    request: WorkspaceSyncTargetBootstrapPrepareV1 & Readonly<{ owner: Readonly<{ kind: 'copy_once'; operation: WorkspaceSyncCopyOnceV1 }> }>;
    targetWorkspace: WorkspaceRefV1;
    sourceWorkspace: WorkspaceRefV1;
  }>): Promise<RetainedBootstrap | null> => {
    if (!bootstrap || input.targetWorkspace.machineId.trim() !== localMachineId) return null;
    assertLocalWorkspacePlacement(input.targetWorkspace, localServerId, localMachineId);
    const operation = input.request.owner.operation;
    const authorityKey = retainedAuthorityKey({
      relationshipId: null,
      operationId: operation.operationId,
      endpointRole: 'beta',
      targetWorkspaceRefId: input.targetWorkspace.id,
    });
    return await exclusive(authorityKey, async () => {
      const existing = retained.get(authorityKey);
      if (existing) {
        await commitPublishedMaterializationCustody(existing);
        return existing;
      }
      const prepared = await rehydrateWorkspaceSyncTargetBootstrap({
        rootPath: input.targetWorkspace.rootPath,
        relationshipId: operation.operationId,
        endpointRole: 'beta',
        targetWorkspaceRefId: input.targetWorkspace.id,
        policyDigest: operation.contentPolicy.policyDigest,
        contentSelection: operation.contentPolicy.selection,
        materializationDirectory: bootstrap.materializationDirectory,
        rootOwnershipManager: bootstrap.rootOwnershipManager,
        ...(bootstrap.prepareGitTarget ? { prepareGitTarget: bootstrap.prepareGitTarget } : {}),
      }, bootstrap.rehydrateMaterializationFromReceiptPath
        ? { rehydrateMaterializationFromReceiptPath: bootstrap.rehydrateMaterializationFromReceiptPath }
        : undefined);
      if (!prepared) return null;
      const result = WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse({
        v: 1,
        bootstrapOperationId: input.request.bootstrapOperationId,
        targetWorkspaceRefId: input.targetWorkspace.id,
        state: 'ready',
        created: false,
        rootFingerprint: prepared.rootFingerprint,
        policyDigest: prepared.policyDigest,
      });
      const entry: RetainedBootstrap = {
        bootstrapOperationId: input.request.bootstrapOperationId,
        definition: canonicalBootstrapDefinition(input.request),
        result,
        handle: prepared.ownershipHandles[0]!,
        relationshipId: null,
        operationId: operation.operationId,
        sourceWorkspaceRefId: input.sourceWorkspace.id,
        sourceMachineId: input.sourceWorkspace.machineId.trim(),
        sourceRootPath: input.sourceWorkspace.rootPath,
        targetWorkspaceRefId: input.targetWorkspace.id,
        targetMachineId: input.targetWorkspace.machineId.trim(),
        targetRootPath: input.targetWorkspace.rootPath,
        endpointRole: 'beta',
        relationshipDefinition: null,
        transientAuthority: false,
        createIfMissing: input.request.createIfMissing,
        ...(prepared.materializationCustody
          ? { materializationCustody: prepared.materializationCustody }
          : {}),
        publishReady: prepared.publishReady,
        readyPublished: prepared.readyPublished,
      };
      retained.set(authorityKey, entry);
      await commitPublishedMaterializationCustody(entry);
      return entry;
    });
  };

  const rehydrateIngressOwner = async (facts: Readonly<{
    operationId: string;
    sourceMachineId: string;
    targetMachineId: string;
  }>): Promise<void> => {
    const snapshot = getSnapshot();
    const relationships = (snapshot?.relationships ?? []).filter((candidate) => (
      candidate.relationshipId === facts.operationId && candidate.enabled
    ));
    if (relationships.length !== 1) return;
    const relationship = relationships[0]!;
    const refs = snapshot?.workspaceRefs ?? [];
    const candidates = (['alpha', 'beta'] as const).flatMap((endpointRole) => {
      const targetRefId = endpointRole === 'alpha' ? relationship.alphaWorkspaceRefId : relationship.betaWorkspaceRefId;
      const sourceRefId = endpointRole === 'alpha' ? relationship.betaWorkspaceRefId : relationship.alphaWorkspaceRefId;
      const targetWorkspace = resolveWorkspaceRefById(refs, targetRefId, localServerId);
      const sourceWorkspace = resolveWorkspaceRefById(refs, sourceRefId, localServerId);
      return targetWorkspace && sourceWorkspace
        && targetWorkspace.machineId.trim() === facts.targetMachineId
        && sourceWorkspace.machineId.trim() === facts.sourceMachineId
        ? [{ endpointRole, targetWorkspace, sourceWorkspace }]
        : [];
    });
    if (candidates.length !== 1) return;
    await rehydrateRelationshipEndpoint({ relationship, ...candidates[0]! });
  };

  const assertRetainedRootIdentity = async (input: Readonly<{
    authorityKey: string;
    entry: RetainedBootstrap;
    rootPath: string;
  }>): Promise<string> => {
    try {
      await input.entry.handle.bindCurrentRootIdentity();
    } catch {
      await discardRetained(input.authorityKey);
      throw authorityError('root_changed', 'Workspace sync target root identity changed');
    }
    const canonicalRoot = await realpath(input.rootPath).catch(() => null);
    const rootFingerprint = canonicalRoot
      ? await computeWorkspaceSyncRootFingerprint(canonicalRoot).catch(() => null)
      : null;
    if (canonicalRoot !== input.entry.handle.owner.canonicalRoot
      || rootFingerprint === null
      || rootFingerprint !== input.entry.result.rootFingerprint
      || input.entry.handle.owner.rootFingerprint !== input.entry.result.rootFingerprint) {
      await discardRetained(input.authorityKey);
      throw authorityError('root_changed', 'Workspace sync target root identity changed');
    }
    return canonicalRoot;
  };

  const requireRetainedRelationshipEndpoint = async (input: Readonly<{
    relationship: WorkspaceSyncRelationshipV1;
    workspace: WorkspaceRefV1;
  }>): Promise<Readonly<{
    authorityKey: string;
    entry: RetainedBootstrap;
    canonicalRoot: string;
  }>> => {
    const endpointRole = input.relationship.alphaWorkspaceRefId === input.workspace.id
      ? 'alpha'
      : input.relationship.betaWorkspaceRefId === input.workspace.id
        ? 'beta'
        : null;
    if (!endpointRole) {
      throw authorityError('relationship_not_ready', 'Workspace reference is not owned by the relationship');
    }
    const sourceWorkspaceRefId = endpointRole === 'alpha'
      ? input.relationship.betaWorkspaceRefId
      : input.relationship.alphaWorkspaceRefId;
    const sourceWorkspace = resolveWorkspaceRef(getSnapshot(), sourceWorkspaceRefId, localServerId);
    const authorityKey = retainedAuthorityKey({
      relationshipId: input.relationship.relationshipId,
      operationId: input.relationship.relationshipId,
      endpointRole,
      targetWorkspaceRefId: input.workspace.id,
    });
    let entry = retained.get(authorityKey) ?? null;
    if (!entry) {
      entry = await rehydrateRelationshipEndpoint({
        relationship: input.relationship,
        endpointRole,
        targetWorkspace: input.workspace,
        sourceWorkspace,
      });
    }
    if (!entry || !relationshipStillOwnsEndpoint(getSnapshot(), entry)) {
      throw authorityError('relationship_not_ready', 'Workspace sync target root is not retained by a ready relationship');
    }
    const canonicalRoot = await assertRetainedRootIdentity({
      authorityKey,
      entry,
      rootPath: input.workspace.rootPath,
    });
    return { authorityKey, entry, canonicalRoot };
  };

  const assertRetainedRelationshipEndpointCurrent = async (input: Readonly<{
    authorityKey: string;
    entry: RetainedBootstrap;
    workspace: WorkspaceRefV1;
  }>): Promise<void> => {
    if (retained.get(input.authorityKey) !== input.entry
      || !relationshipStillOwnsEndpoint(getSnapshot(), input.entry)) {
      throw authorityError('relationship_not_ready', 'Workspace sync target root is no longer retained by the relationship');
    }
    await assertRetainedRootIdentity({
      authorityKey: input.authorityKey,
      entry: input.entry,
      rootPath: input.workspace.rootPath,
    });
  };

  const resolveRecoveryWorkspace = async (request: WorkspaceSyncTargetConflictRecoverV1) => {
    const { relationship, workspace } = resolveOwnedWorkspace(
      getSnapshot(), request.relationshipId, request.targetWorkspaceRefId, localServerId, 'any',
    );
    if (workspace.machineId !== request.targetMachineId) {
      throw authorityError('approval_stale', 'Reviewed workspace conflict recovery endpoint changed');
    }
    if (relationship.enabled) return { relationship, workspace, transientAccess: null };

    // Initial relationship preparation deliberately leaves the durable graph
    // disabled. Only the already retained controller/target root may settle its
    // journal before engine ingress; a paused row alone grants no recovery loan.
    type Access = Readonly<{ canonicalRoot: string; assertCurrentAuthority(): Promise<void> }>;
    const checkedAccess = (access: Access, localWorkspace: WorkspaceRefV1): Access => ({
      canonicalRoot: access.canonicalRoot,
      assertCurrentAuthority: async () => {
        const current = resolveOwnedWorkspace(getSnapshot(), relationship.relationshipId, workspace.id, localServerId, 'any');
        if (!areWorkspaceSyncRelationshipDefinitionsEqual(current.relationship, relationship)
          || !isDeepStrictEqual(current.workspace, workspace)
          || !isDeepStrictEqual(resolveWorkspaceRef(getSnapshot(), localWorkspace.id, localServerId), localWorkspace)) {
          throw authorityError('relationship_not_ready', 'Workspace recovery endpoint is no longer owned by the retained definition');
        }
        const canonicalRoot = await realpath(localWorkspace.rootPath).catch(() => null);
        if (canonicalRoot !== access.canonicalRoot) {
          throw authorityError('root_changed', 'Workspace recovery root identity changed');
        }
        await access.assertCurrentAuthority();
      },
    });
    const localMemberIds = workspace.machineId === localMachineId
      ? [workspace.id]
      : [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId];
    for (const refId of localMemberIds) {
      const member = resolveWorkspaceRef(getSnapshot(), refId, localServerId);
      if (member.machineId !== localMachineId) continue;
      assertLocalWorkspacePlacement(member, localServerId, localMachineId);
      const controllerAccess = await dependencies.resolveLocalResolutionEndpoint?.(relationship.relationshipId, member.id);
      if (!controllerAccess?.relationship
        || !areWorkspaceSyncRelationshipDefinitionsEqual(controllerAccess.relationship, relationship)) continue;
      const transientAccess = checkedAccess(controllerAccess, member);
      await transientAccess.assertCurrentAuthority();
      return { relationship, workspace, transientAccess };
    }
    if (workspace.machineId === localMachineId) {
      assertLocalWorkspacePlacement(workspace, localServerId, localMachineId);
      const endpointRole = relationship.alphaWorkspaceRefId === workspace.id ? 'alpha' : 'beta';
      const authorityKey = retainedAuthorityKey({ relationshipId: relationship.relationshipId,
        operationId: relationship.relationshipId, endpointRole, targetWorkspaceRefId: workspace.id });
      const entry = retained.get(authorityKey);
      if (entry?.transientAuthority && relationshipOwnsEndpoint(getSnapshot(), entry, false)) {
        const canonicalRoot = await assertRetainedRootIdentity({ authorityKey, entry, rootPath: workspace.rootPath });
        const transientAccess = checkedAccess({ canonicalRoot, assertCurrentAuthority: async () => {
          if (retained.get(authorityKey) !== entry || !entry.transientAuthority
            || !relationshipOwnsEndpoint(getSnapshot(), entry, false)) {
            throw authorityError('relationship_not_ready', 'Workspace recovery target no longer retains its transient bootstrap');
          }
          await assertRetainedRootIdentity({ authorityKey, entry, rootPath: workspace.rootPath });
        } }, workspace);
        await transientAccess.assertCurrentAuthority();
        return { relationship, workspace, transientAccess };
      }
    }
    throw authorityError('relationship_not_ready', 'Workspace sync disabled endpoint has no current bootstrap recovery custody');
  };

  const approvedResolutionEffect = (request: WorkspaceSyncTargetConflictStageV1 | WorkspaceSyncTargetConflictApplyV1) => {
    if (request.alternativeIndex === null) {
      return {
        source: request.actionInput.source,
        target: request.actionInput.targets.find((candidate) => candidate.workspaceRefId === request.targetWorkspaceRefId),
        sourcePath: request.actionInput.path,
        targetPath: request.actionInput.path,
        kind: 'selected' as const,
      };
    }
    const alternative = request.actionInput.strategy === 'keep_both'
      ? request.actionInput.alternatives[request.alternativeIndex]
      : undefined;
    if (!alternative || alternative.source.expected.kind !== 'file') {
      throw authorityError('approval_stale', 'Reviewed workspace conflict alternative changed');
    }
    return {
      source: alternative.source,
      target: alternative.destination,
      sourcePath: request.actionInput.path,
      targetPath: alternative.destination.path,
      kind: 'alternative' as const,
    };
  };
  const validateResolutionEndpoint = async (
    request: WorkspaceSyncTargetConflictStageV1 | WorkspaceSyncTargetConflictApplyV1,
    endpoint: 'source' | 'target',
  ): Promise<Readonly<{
    relationship: WorkspaceSyncRelationshipV1;
    workspace: WorkspaceRefV1;
    canonicalRoot: string;
    assertCurrentAuthority(): Promise<void>;
  }>> => {
    const effect = approvedResolutionEffect(request);
    if (request.operationId !== deriveWorkspaceSyncConflictOperationId({
        actionReceiptId: request.actionReceiptId,
        kind: effect.kind,
        workspaceRefId: request.targetWorkspaceRefId,
        path: request.path,
        ...(request.alternativeIndex === null ? {} : { alternativeIndex: request.alternativeIndex }),
      })
      || request.actionInput.controllerMachineId !== (getSnapshot()?.relationships ?? [])
        .find((relationship) => relationship.relationshipId === request.relationshipId)?.controllerMachineId
      || !request.actionInput.relationshipIds.includes(request.relationshipId)
      || effect.targetPath !== request.path) {
      throw authorityError('approval_stale', 'Reviewed workspace conflict authority changed');
    }
    const snapshot = getSnapshot();
    const relationships = (snapshot?.relationships ?? []).filter((candidate) => candidate.enabled);
    const topology = deriveWorkspaceSyncTopology({
      serverId: localServerId,
      workspaceRefs: snapshot?.workspaceRefs ?? [],
      relationships,
    });
    const set = topology.sets.find((candidate) => candidate.hubWorkspaceRefId === request.actionInput.hubWorkspaceRefId
      && candidate.controllerMachineId === request.actionInput.controllerMachineId
      && candidate.relationships.some((member) => member.relationshipId === request.relationshipId));
    const approvedIds = [...request.actionInput.relationshipIds].sort();
    const currentIds = set?.relationships.map((member) => member.relationshipId).sort() ?? [];
    const sourceRelationshipId = 'sourceRelationshipId' in request
      ? request.sourceRelationshipId
      : set?.relationships.find((member) => member.alphaWorkspaceRefId === effect.source.workspaceRefId
        || member.betaWorkspaceRefId === effect.source.workspaceRefId)?.relationshipId;
    if (!set || JSON.stringify(approvedIds) !== JSON.stringify(currentIds)
      || !sourceRelationshipId || !currentIds.includes(sourceRelationshipId)) {
      throw authorityError('approval_stale', 'Reviewed workspace conflict linked set changed');
    }
    const sourceMember = set.relationships.find((member) => member.relationshipId === sourceRelationshipId);
    if (!sourceMember || (sourceMember.alphaWorkspaceRefId !== effect.source.workspaceRefId
      && sourceMember.betaWorkspaceRefId !== effect.source.workspaceRefId)) {
      throw authorityError('approval_stale', 'Reviewed workspace conflict source link changed');
    }
    const workspaceRefId = endpoint === 'source' && 'sourceWorkspaceRefId' in request
      ? request.sourceWorkspaceRefId
      : request.targetWorkspaceRefId;
    const endpointRelationshipId = endpoint === 'source' ? sourceRelationshipId : request.relationshipId;
    const { relationship, workspace } = resolveOwnedWorkspace(snapshot, endpointRelationshipId, workspaceRefId, localServerId);
    const approvedTarget = effect.target;
    const targetPlacement = resolveOwnedWorkspace(getSnapshot(), request.relationshipId, request.targetWorkspaceRefId, localServerId).workspace;
    if (!approvedTarget || targetPlacement.machineId !== request.targetMachineId
      || ('targetExpected' in request && JSON.stringify(approvedTarget.expected) !== JSON.stringify(request.targetExpected))) {
      throw authorityError('approval_stale', 'Reviewed workspace conflict destination changed');
    }
    const expectedEndpoint = endpoint === 'source' ? effect.source : effect.target;
    const expected = endpoint === 'source' && 'sourceExpected' in request
      ? request.sourceExpected
      : endpoint === 'target' && 'targetExpected' in request
        ? request.targetExpected
        : expectedEndpoint?.expected;
    if (!expectedEndpoint || expectedEndpoint.workspaceRefId !== workspaceRefId
      || JSON.stringify(expectedEndpoint.expected) !== JSON.stringify(expected)
      || ('sourceMachineId' in request && endpoint === 'source' && workspace.machineId !== request.sourceMachineId)
      || workspace.machineId !== request.targetMachineId && endpoint === 'target') {
      throw authorityError('approval_stale', 'Reviewed workspace conflict endpoint changed');
    }
    assertLocalWorkspacePlacement(workspace, localServerId, localMachineId);
    if (!dependencies.assertConflictResolutionAuthorized) {
      throw authorityError('approval_required', 'Workspace conflict Action receipt authority is unavailable');
    }
    await dependencies.assertConflictResolutionAuthorized(request.actionReceiptId, request.actionInput);
    if (relationship.controllerMachineId === localMachineId) {
      const access = await dependencies.resolveLocalResolutionEndpoint?.(relationship.relationshipId, workspace.id);
      if (!access) throw authorityError('workspace_root_ownership_lost', 'Controller does not retain the reviewed workspace endpoint');
      await access.assertCurrentAuthority();
      return { relationship, workspace, ...access };
    }
    const retainedEndpoint = await requireRetainedRelationshipEndpoint({ relationship, workspace });
    return {
      relationship, workspace, canonicalRoot: retainedEndpoint.canonicalRoot,
      assertCurrentAuthority: async () => await assertRetainedRelationshipEndpointCurrent({
        authorityKey: retainedEndpoint.authorityKey,
        entry: retainedEndpoint.entry,
        workspace,
      }),
    };
  };

  const stagedResolutions = new Map<string, Readonly<{
    workspaceRefId: string;
    path: string;
    expectation: import('@happier-dev/protocol').WorkspaceSyncEntryExpectationV1;
    targetExpected: import('@happier-dev/protocol').WorkspaceSyncEntryExpectationV1;
    stagingDirectory: string;
    materialPath: string | null;
  }>>();
  const stagedResolutionKey = (operationId: string, workspaceRefId: string, path: string): string =>
    JSON.stringify([operationId, workspaceRefId, path]);
  const capturedResolutions = new Map<string, Readonly<{
    actionReceiptId: string;
    sourceWorkspaceRefId: string;
    path: string;
    actionInput: WorkspaceSyncConflictResolveActionInputV1;
    expectation: WorkspaceSyncEntryExpectationV1;
    materialPath: string | null;
    captureDirectory: string;
  }>>();
  const capturedResolutionKey = (actionReceiptId: string, sourceWorkspaceRefId: string, path: string, expectation: WorkspaceSyncEntryExpectationV1): string =>
    JSON.stringify([actionReceiptId, sourceWorkspaceRefId, path, expectation]);
  const resolutionDirectory = dependencies.resolutionMaterialDirectory;
  let resolutionDirectoryReady: Promise<string> | null = null;
  const requireResolutionDirectory = async (): Promise<string> => {
    if (!resolutionDirectory) throw authorityError('agent_unavailable', 'Reviewed workspace conflict material directory is unavailable');
    resolutionDirectoryReady ??= (async () => {
      await ensureProtectedLocalStateDirectory(resolutionDirectory, { authority: 'owned' });
      // Captures and successful target stages are process-owned private material,
      // not native recovery evidence. No old daemon operation can still own
      // them when this fresh authority starts.
      for (const entry of await readdir(resolutionDirectory, { withFileTypes: true })) {
        if (entry.isDirectory() && (entry.name.startsWith('capture-') || entry.name.startsWith('stage-'))) {
          await rm(join(resolutionDirectory, entry.name), { recursive: true, force: true });
        }
      }
      return resolutionDirectory;
    })().catch((error: unknown) => {
      resolutionDirectoryReady = null;
      throw error;
    });
    return await resolutionDirectoryReady;
  };
  const recoverConflictResolutionHere = async (
    rawRequest: WorkspaceSyncTargetConflictRecoverV1,
    signal?: AbortSignal,
  ): Promise<WorkspaceSyncTargetConflictRecoverResultV1> => {
    assertStateAvailable();
    signal?.throwIfAborted();
    const request = WorkspaceSyncTargetConflictRecoverV1Schema.parse(rawRequest);
    const { relationship, workspace, transientAccess } = await resolveRecoveryWorkspace(request);
    assertLocalWorkspacePlacement(workspace, localServerId, localMachineId);
    const recoveryDirectory = await requireResolutionDirectory();
    const records = await (dependencies.discoverConflictRecovery ?? discoverNativeConfinedWorkspaceSyncRecovery)({ recoveryDirectory });
    if (records.length === 0) {
      await transientAccess?.assertCurrentAuthority();
      return { status: 'settled' };
    }
    const canonicalRoot = await realpath(workspace.rootPath);
    const matching = records.filter((record) => record.rootPath === canonicalRoot);
    if (matching.length === 0) {
      await transientAccess?.assertCurrentAuthority();
      return { status: 'settled' };
    }
    let access = transientAccess ?? await dependencies.resolveLocalResolutionEndpoint?.(relationship.relationshipId, workspace.id) ?? null;
    let release: (() => Promise<void>) | null = null;
    if (!access) {
      try {
        const retainedEndpoint = await requireRetainedRelationshipEndpoint({ relationship, workspace });
        access = {
          canonicalRoot: retainedEndpoint.canonicalRoot,
          assertCurrentAuthority: async () => await assertRetainedRelationshipEndpointCurrent({
            authorityKey: retainedEndpoint.authorityKey,
            entry: retainedEndpoint.entry,
            workspace,
          }),
        };
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'relationship_not_ready') throw error;
        if (!bootstrap) throw error;
        const acquired = await bootstrap.rootOwnershipManager.tryAcquire({
          ownerId: `workspace-sync-recovery:${relationship.relationshipId}:${workspace.id}`,
          canonicalRoot,
          operation: 'sync',
        });
        if ('kind' in acquired) throw authorityError('workspace_root_in_use', 'Workspace conflict recovery root overlaps an active operation');
        access = {
          canonicalRoot: acquired.owner.canonicalRoot,
          assertCurrentAuthority: async () => {
            if (acquired.owner.rootFingerprint === null
              || await computeWorkspaceSyncRootFingerprint(acquired.owner.canonicalRoot) !== acquired.owner.rootFingerprint) {
              throw authorityError('workspace_root_ownership_lost', 'Workspace conflict recovery root identity changed');
            }
          },
        };
        release = acquired.release;
      }
    }
    try {
      if (!access) throw authorityError('workspace_root_ownership_lost', 'Workspace conflict recovery root is unavailable');
      if (access.canonicalRoot !== canonicalRoot) throw authorityError('workspace_root_ownership_lost', 'Reviewed workspace recovery root changed');
      await access.assertCurrentAuthority();
      for (const record of matching) {
        signal?.throwIfAborted();
        const outcome = await (dependencies.recoverConflictEntry ?? recoverWorkspaceSyncEntryReplacementAtRoot)({
          rootPath: access.canonicalRoot,
          recoveryDirectory,
          operationId: record.operationId,
          assertCurrentAuthority: access.assertCurrentAuthority,
        });
        if (outcome.status === 'recovery_needed') {
          return WorkspaceSyncTargetConflictRecoverResultV1Schema.parse(outcome);
        }
      }
      return { status: 'settled' };
    } finally {
      await release?.();
    }
  };
  const prepareConflictResolutionExport = async (
    rawRequest: WorkspaceSyncTargetConflictStageV1,
  ): Promise<Readonly<{ payloadSource: TransferPayloadSource; onDemandScope: DirectPeerOnDemandTransferScope }>> => {
    assertStateAvailable();
    const request = WorkspaceSyncTargetConflictStageV1Schema.parse(rawRequest);
    const source = await validateResolutionEndpoint(request, 'source');
    const effect = approvedResolutionEffect(request);
    const cacheKey = capturedResolutionKey(request.actionReceiptId, request.sourceWorkspaceRefId, effect.sourcePath, request.sourceExpected);
    const retained = capturedResolutions.get(cacheKey);
    if (retained) {
      if (retained.sourceWorkspaceRefId !== request.sourceWorkspaceRefId || retained.path !== effect.sourcePath
        || JSON.stringify(retained.actionInput) !== JSON.stringify(request.actionInput)
        || JSON.stringify(retained.expectation) !== JSON.stringify(request.sourceExpected)) {
        throw authorityError('approval_stale', 'Reviewed workspace conflict capture owner changed');
      }
      const exported = await createWorkspaceSyncEntryExport({
        operationId: request.operationId,
        expectation: retained.expectation,
        materialPath: retained.materialPath,
      });
      return { payloadSource: exported.payloadSource, onDemandScope: exported.onDemandScope };
    }
    const directory = await requireResolutionDirectory();
    const captureDirectory = await mkdtemp(join(directory, 'capture-'));
    try {
      const captured = await captureWorkspaceSyncEntryAtRoot({
        rootPath: source.canonicalRoot,
        relativePath: effect.sourcePath,
        expected: request.sourceExpected,
        captureDirectory,
        operationId: deriveWorkspaceSyncConflictOperationId({
          actionReceiptId: request.actionReceiptId,
          kind: 'capture',
          workspaceRefId: request.sourceWorkspaceRefId,
          path: effect.sourcePath,
        }),
        assertCurrentAuthority: source.assertCurrentAuthority,
      });
      const exported = await createWorkspaceSyncEntryExport({
        operationId: request.operationId,
        expectation: captured.expectation,
        materialPath: captured.materialPath,
      });
      capturedResolutions.set(cacheKey, {
        actionReceiptId: request.actionReceiptId,
        sourceWorkspaceRefId: request.sourceWorkspaceRefId,
        path: effect.sourcePath,
        actionInput: request.actionInput,
        expectation: captured.expectation,
        materialPath: captured.materialPath,
        captureDirectory,
      });
      return {
        payloadSource: exported.payloadSource,
        onDemandScope: exported.onDemandScope,
      };
    } catch (error) {
      await rm(captureDirectory, { recursive: true, force: true });
      throw error;
    }
  };
  const releaseConflictResolutionCaptureHere = async (rawRequest: WorkspaceSyncConflictCaptureReleaseV1): Promise<void> => {
    const request = WorkspaceSyncConflictCaptureReleaseV1Schema.parse(rawRequest);
    if (request.operationId !== request.actionReceiptId || request.sourceMachineId !== localMachineId) {
      throw authorityError('approval_stale', 'Reviewed workspace conflict capture owner changed');
    }
    for (const [key, captured] of capturedResolutions) {
      if (captured.actionReceiptId !== request.actionReceiptId) continue;
      if (JSON.stringify(captured.actionInput) !== JSON.stringify(request.actionInput)) {
        throw authorityError('approval_stale', 'Reviewed workspace conflict capture owner changed');
      }
      await rm(captured.captureDirectory, { recursive: true, force: true });
      capturedResolutions.delete(key);
    }
  };
  const stageConflictResolutionHere = async (
    rawRequest: WorkspaceSyncTargetConflictStageV1,
    signal?: AbortSignal,
  ): Promise<void> => {
    assertStateAvailable();
    signal?.throwIfAborted();
    const request = WorkspaceSyncTargetConflictStageV1Schema.parse(rawRequest);
    const target = await validateResolutionEndpoint(request, 'target');
    const effect = approvedResolutionEffect(request);
    const source = resolveOwnedWorkspace(getSnapshot(), request.sourceRelationshipId, request.sourceWorkspaceRefId, localServerId).workspace;
    if (source.machineId !== request.sourceMachineId || request.sourceWorkspaceRefId !== effect.source.workspaceRefId
      || JSON.stringify(request.sourceExpected) !== JSON.stringify(effect.source.expected)) {
      throw authorityError('approval_stale', 'Reviewed workspace conflict source changed');
    }
    if (!dependencies.requestResolutionExport) {
      throw authorityError('agent_unavailable', 'Reviewed workspace conflict transfer is unavailable');
    }
    const stagedKey = stagedResolutionKey(request.operationId, target.workspace.id, request.path);
    if (stagedResolutions.has(stagedKey)) {
      throw authorityError('conflict_changed', 'Reviewed workspace conflict material is already staged for this endpoint');
    }
    const directory = await requireResolutionDirectory();
    const stagingDirectory = await mkdtemp(join(directory, 'stage-'));
    let remote: Awaited<ReturnType<NonNullable<typeof dependencies.requestResolutionExport>>> | null = null;
    try {
      remote = await dependencies.requestResolutionExport({ ...request, ...(signal ? { signal } : {}) });
      const materialPath = await stageWorkspaceSyncEntryExport({
        operationId: request.operationId,
        stagingDirectory,
        expectation: request.sourceExpected,
        requestPayload: remote.requestPayload,
      });
      await target.assertCurrentAuthority();
      stagedResolutions.set(stagedKey, {
        workspaceRefId: target.workspace.id,
        path: request.path,
        expectation: request.sourceExpected,
        targetExpected: request.targetExpected,
        stagingDirectory,
        materialPath,
      });
    } catch (error) {
      stagedResolutions.delete(stagedKey);
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    } finally {
      // The finite-transfer owner also expires an unreleased export. Failure
      // to release it cannot invalidate already verified target material.
      await remote?.release().catch(() => undefined);
    }
  };
  const applyStagedConflictResolutionHere = async (
    rawRequest: WorkspaceSyncTargetConflictApplyV1,
    signal?: AbortSignal,
  ): Promise<WorkspaceSyncTargetConflictApplyResultV1> => {
    assertStateAvailable();
    signal?.throwIfAborted();
    const request = WorkspaceSyncTargetConflictApplyV1Schema.parse(rawRequest);
    const target = await validateResolutionEndpoint(request, 'target');
    const effect = approvedResolutionEffect(request);
    const stagedKey = stagedResolutionKey(request.operationId, target.workspace.id, request.path);
    const staged = stagedResolutions.get(stagedKey);
    if (!staged || staged.workspaceRefId !== target.workspace.id || staged.path !== request.path
      || JSON.stringify(staged.expectation) !== JSON.stringify(effect.source.expected)
      || JSON.stringify(staged.targetExpected) !== JSON.stringify(effect.target?.expected)) {
      throw authorityError('conflict_changed', 'Reviewed workspace conflict staging is no longer available');
    }
    const recoveryDirectory = await requireResolutionDirectory();
    const outcome = await applyCapturedWorkspaceSyncEntryAtRoot({
        rootPath: target.canonicalRoot,
        relativePath: request.path,
        expectedDestination: staged.targetExpected,
        selectedExpectation: staged.expectation,
        materialPath: staged.materialPath,
        recoveryDirectory,
        operationId: request.operationId,
        assertCurrentAuthority: target.assertCurrentAuthority,
    });
    if (outcome.status !== 'recovery_needed') {
      stagedResolutions.delete(stagedKey);
      await rm(staged.stagingDirectory, { recursive: true, force: true });
    }
    return WorkspaceSyncTargetConflictApplyResultV1Schema.parse(outcome);
  };
  const discardStagedConflictResolutionHere = async (
    rawRequest: WorkspaceSyncTargetConflictApplyV1,
    signal?: AbortSignal,
  ): Promise<void> => {
    signal?.throwIfAborted();
    const request = WorkspaceSyncTargetConflictApplyV1Schema.parse(rawRequest);
    const effect = approvedResolutionEffect(request);
    const stagedKey = stagedResolutionKey(request.operationId, request.targetWorkspaceRefId, request.path);
    const staged = stagedResolutions.get(stagedKey);
    if (!staged) return;
    if (request.operationId !== deriveWorkspaceSyncConflictOperationId({
        actionReceiptId: request.actionReceiptId,
        kind: effect.kind,
        workspaceRefId: request.targetWorkspaceRefId,
        path: request.path,
        ...(request.alternativeIndex === null ? {} : { alternativeIndex: request.alternativeIndex }),
      })
      || request.targetMachineId !== localMachineId
      || effect.target?.workspaceRefId !== request.targetWorkspaceRefId
      || effect.targetPath !== request.path
      || JSON.stringify(staged.expectation) !== JSON.stringify(effect.source.expected)
      || JSON.stringify(staged.targetExpected) !== JSON.stringify(effect.target?.expected)) {
      throw authorityError('approval_stale', 'Reviewed workspace conflict stage owner changed');
    }
    await rm(staged.stagingDirectory, { recursive: true, force: true });
    stagedResolutions.delete(stagedKey);
  };

  const readFileHere = async (
    rawRequest: WorkspaceSyncTargetFileReadV1,
    signal?: AbortSignal,
  ): Promise<ReadWorkspaceSyncFileResultV1> => {
    assertStateAvailable();
    signal?.throwIfAborted();
    const request = WorkspaceSyncTargetFileReadV1Schema.parse(rawRequest);
    const { relationship, workspace } = resolveOwnedWorkspace(getSnapshot(), request.relationshipId, request.workspaceRefId, localServerId);
    assertLocalWorkspacePlacement(workspace, localServerId, localMachineId);
    // Disclosure uses the same retained relationship/root object authority as
    // conflict deletion. A replacement root at the granted pathname is not the
    // root the relationship was granted, so it must yield no bytes.
    const retainedEndpoint = await requireRetainedRelationshipEndpoint({ relationship, workspace });
    signal?.throwIfAborted();
    return ReadWorkspaceSyncFileResultV1Schema.parse(await readWorkspaceSyncFileAtRoot({
      rootPath: retainedEndpoint.canonicalRoot,
      relativePath: request.path,
      maxBytes: request.maxBytes,
      ...(request.expectedDigest === undefined ? {} : { expectedDigest: request.expectedDigest }),
      assertCurrentAuthority: async () => await assertRetainedRelationshipEndpointCurrent({
        authorityKey: retainedEndpoint.authorityKey,
        entry: retainedEndpoint.entry,
        workspace,
      }),
    }));
  };

  const observeEntryHere = async (
    rawRequest: WorkspaceSyncTargetEntryObserveV1,
    signal?: AbortSignal,
  ): Promise<WorkspaceSyncEntryExpectationV1> => {
    assertStateAvailable();
    signal?.throwIfAborted();
    const request = WorkspaceSyncTargetEntryObserveV1Schema.parse(rawRequest);
    const { relationship, workspace } = resolveOwnedWorkspace(getSnapshot(), request.relationshipId, request.workspaceRefId, localServerId);
    assertLocalWorkspacePlacement(workspace, localServerId, localMachineId);
    const retainedEndpoint = await requireRetainedRelationshipEndpoint({ relationship, workspace });
    signal?.throwIfAborted();
    return WorkspaceSyncEntryExpectationV1Schema.parse(await observeWorkspaceSyncEntryAtRoot({
      rootPath: retainedEndpoint.canonicalRoot,
      relativePath: request.path,
      assertCurrentAuthority: async () => await assertRetainedRelationshipEndpointCurrent({
        authorityKey: retainedEndpoint.authorityKey,
        entry: retainedEndpoint.entry,
        workspace,
      }),
    }));
  };

  const authority: WorkspaceSyncTargetAuthority = {
    activity,
    previewCommittedCopyHere: async (request) => await inspectCommittedCopyPreviewHere(request, await refreshCommittedCopyPreview(request)),
    previewCommittedCopyAtTarget: async (request) => {
      const resolved = await refreshCommittedCopyPreview(request);
      const { parsed, workspace } = resolved;
      if (workspace.machineId.trim() === localMachineId) return await inspectCommittedCopyPreviewHere(request, resolved);
      const raw = await dependencies.callMachineRpc({ machineId: workspace.machineId.trim(),
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT, request: parsed,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const result = WorkspaceSyncCommittedCopyPreviewResultV1Schema.safeParse(raw);
      if (!result.success) {
        assertOkResult(raw);
        throw result.error;
      }
      if (result.data.ok && (result.data.preview.targetMachineId !== parsed.targetMachineId
        || result.data.preview.workspaceRefId !== parsed.targetWorkspaceRefId)) {
        throw authorityError('root_mismatch', 'Workspace copy preview response changed target');
      }
      if ((await refreshCommittedCopyPreview(request)).workspace.rootPath !== workspace.rootPath) {
        throw authorityError('root_mismatch', 'Workspace copy preview root changed during inspection');
      }
      return result.data;
    },
    inspectCommittedCopyHere: async (request) => {
      await assertCommittedCopyApproved(request);
      const resolved = resolveCommittedCopy(request);
      assertCommittedCopyRelationshipCurrent(resolved.snapshot, resolved.relationship);
      await inspectWorkspaceSyncCommittedCopy(resolved.copy);
    },
    removeCommittedCopyHere: async (request) => {
      await assertCommittedCopyApproved(request);
      const resolved = resolveCommittedCopy(request);
      if (resolved.snapshot.relationships.some((relationship) => (
        relationship.alphaWorkspaceRefId === resolved.workspace.id || relationship.betaWorkspaceRefId === resolved.workspace.id
      ))) {
        throw authorityError('workspace_root_in_use', 'Workspace copy still belongs to a relationship');
      }
      await authority.reconcileRetainedBootstraps();
      await removeWorkspaceSyncCommittedCopy({ ...resolved.copy, rootOwnershipManager: resolved.bootstrap.rootOwnershipManager });
    },
    inspectCommittedCopyAtTarget: async (request) => await committedCopyAtTarget(request, 'inspect'),
    removeCommittedCopyAtTarget: async (request) => await committedCopyAtTarget(request, 'remove'),
    borrowSourceRootForCopy: async ({ operationId, workspaceRefId }) => {
      assertStateAvailable();
      const snapshot = getSnapshot();
      const workspace = resolveWorkspaceRefById(snapshot?.workspaceRefs ?? [], workspaceRefId, localServerId);
      if (!workspace || workspace.machineId.trim() !== localMachineId || workspace.serverId.trim() !== localServerId) return null;
      const relationships = (snapshot?.relationships ?? []).filter((relationship) => {
        if (!relationship.enabled) return false;
        const alpha = resolveWorkspaceRefById(snapshot?.workspaceRefs ?? [], relationship.alphaWorkspaceRefId, localServerId);
        const beta = resolveWorkspaceRefById(snapshot?.workspaceRefs ?? [], relationship.betaWorkspaceRefId, localServerId);
        if (!alpha || !beta) return false;
        const roles = resolveWorkspaceSyncRelationshipEndpointRoles({
          mode: relationship.mode,
          controllerMachineId: relationship.controllerMachineId,
          alphaMachineId: alpha.machineId,
          betaMachineId: beta.machineId,
        });
        return roles && (roles.targetEndpointRole === 'alpha' ? alpha.id : beta.id) === workspaceRefId;
      });
      if (relationships.length === 0) return null;
      if (relationships.length !== 1) throw authorityError('relationship_not_ready', 'Workspace sync source has conflicting retained target owners');
      const { authorityKey, entry } = await requireRetainedRelationshipEndpoint({ relationship: relationships[0]!, workspace });
      return await exclusive(authorityKey, async () => {
        if (retained.get(authorityKey) !== entry || !entry.readyPublished) {
          throw authorityError('relationship_not_ready', 'Workspace sync source is not a committed linked spoke');
        }
        await assertRetainedRelationshipEndpointCurrent({ authorityKey, entry, workspace });
        const priorOwner = sourceLoanOwners.get(operationId);
        if (priorOwner && priorOwner !== authorityKey) throw authorityError('relationship_not_ready', 'Workspace copy source loan conflicts with an active operation');
        const members = sourceLoans.get(authorityKey) ?? new Set<string>();
        members.add(operationId);
        sourceLoans.set(authorityKey, members);
        sourceLoanOwners.set(operationId, authorityKey);
        return {
          handle: entry.handle,
          release: async () => await exclusive(authorityKey, async () => {
            if (sourceLoanOwners.get(operationId) !== authorityKey) return;
            sourceLoanOwners.delete(operationId);
            members.delete(operationId);
            if (members.size > 0) return;
            sourceLoans.delete(authorityKey);
            const outcome = deferredDiscards.get(authorityKey);
            if (outcome) await discardRetained(authorityKey, outcome);
          }, true),
        };
      });
    },
    preflightHandoffTargetReplacementHere: async (rawRequest, signal, context) => {
      assertStateAvailable();
      signal?.throwIfAborted();
      const request = HandoffTargetReplacementPreflightV1Schema.parse(rawRequest);
      if (request.serverId !== localServerId) {
        throw authorityError('target_unavailable', 'Handoff target placement does not match this daemon');
      }
      const target = await bindReplacementTarget(request.machineId, request.targetPath, signal);
      if (context?.workspaceSyncTargetRouting) {
        const routing = WorkspaceSyncTargetRoutingV1Schema.parse(context.workspaceSyncTargetRouting);
        if (routing.phase !== 'preflight' || routing.operationId !== request.operationId
          || routing.accountServerId !== localServerId || routing.targetMachineId !== request.machineId
          || routing.targetRootPath !== request.targetPath
          || !isDeepStrictEqual(routing.targetContext.machineAdmission, context.machineAdmission)
          || routing.targetContext.callerAuthority !== context.callerAuthority
          || !isDeepStrictEqual(routing.targetContext.sessionActionOrigin, context.sessionActionOrigin)
          || !isDeepStrictEqual(routing.targetContext.callerInputConstraints, context.callerInputConstraints)
          || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()) {
          throw authorityError('workspace_sync_child_unavailable', 'The original target admission is unavailable');
        }
        const child = target.facts.find(fact => fact.machineId === request.machineId);
        if (!child || child.installationId !== context.machineAdmission?.installationId
          || target.machineId !== localMachineId) {
          throw authorityError('workspace_sync_child_unavailable', 'The admitted child target does not resolve to this parent');
        }
      }
      if (context?.machineAdmission && !context.workspaceSyncTargetRouting
        && target.machineId === localMachineId
        && (request.machineId !== localMachineId || context.machineAdmission.machineId !== localMachineId
          || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent())) {
        throw authorityError('workspace_sync_child_unavailable', 'The target admission does not belong to this Machine');
      }
      if (target.machineId !== localMachineId) {
        const child = target.facts.find(fact => fact.machineId === request.machineId);
        if (!child || request.machineId !== localMachineId || !context?.machineAdmission
          || context.workspaceSyncTargetRouting || context.machineAdmission.machineId !== request.machineId
          || context.machineAdmission.installationId !== child.installationId
          || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()) {
          throw authorityError('workspace_sync_child_unavailable', 'The original target admission is unavailable');
        }
        if (!dependencies.callWorkspaceTargetPhase) {
          throw authorityError('workspace_sync_update_required', 'The admitted target child transport is unavailable');
        }
        await target.assertCurrent();
        return HandoffTargetReplacementPreflightResultV1Schema.parse(await dependencies.callWorkspaceTargetPhase({
          machineId: target.machineId,
          method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT,
          request,
          routing: { v: 1, phase: 'preflight', operationId: request.operationId,
            accountServerId: localServerId, targetMachineId: request.machineId, targetRootPath: request.targetPath },
          ...(signal ? { signal } : {}),
        }, context));
      }
      const requested = normalize(resolve(target.rootPath));
      if (requested === resolve('/')) {
        throw authorityError('workspace_root_unsafe', 'Handoff target root is invalid');
      }
      const before = await lstat(requested).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (before && (!before.isDirectory() || before.isSymbolicLink())) {
        throw authorityError('workspace_root_unsafe', 'Handoff target root must be a real directory');
      }
      const canonicalRoot = before
        ? await realpath(requested)
        : await realpath(dirname(requested))
          .then((parent) => normalize(join(parent, basename(requested))))
          .catch(() => null);
      if (!canonicalRoot || canonicalRoot === resolve('/')) {
        throw authorityError('workspace_root_unsafe', 'Handoff target parent is unavailable');
      }
      if (!bootstrap) throw authorityError('workspace_sync_unavailable', 'Workspace sync bootstrap authority is unavailable');
      const snapshot = getSnapshot();
      const replayTarget = await resolveEnabledRelationshipReplayTarget({
        snapshot,
        operationId: request.operationId,
        canonicalRoot,
        localServerId,
        localMachineId,
      });
      if (replayTarget) {
        const authorityKey = retainedAuthorityKey({
          relationshipId: replayTarget.relationship.relationshipId,
          operationId: replayTarget.relationship.relationshipId,
          endpointRole: 'beta',
          targetWorkspaceRefId: replayTarget.target.id,
        });
        const entry = retained.get(authorityKey);
        // Only already-retained target custody can bypass a competing
        // preflight acquisition. Settings prove the stable Action-derived
        // relationship and endpoint; the retained owner proves this daemon
        // still holds that exact physical root. The relationship owner remains
        // responsible for full immutable-definition equality on re-entry.
        if (entry
          && entry.relationshipId === replayTarget.relationship.relationshipId
          && entry.targetWorkspaceRefId === replayTarget.target.id) {
          const retainedRoot = await assertRetainedRootIdentity({
            authorityKey,
            entry,
            rootPath: replayTarget.target.rootPath,
          });
          if (retainedRoot === canonicalRoot) {
            return HandoffTargetReplacementPreflightResultV1Schema.parse({ type: 'not_required' });
          }
        }
      }
      const ownership = await bootstrap.rootOwnershipManager.tryAcquire({
        ownerId: request.operationId,
        canonicalRoot,
        operation: 'handoff',
        deferRootIdentityBinding: true,
      });
      if ('kind' in ownership) throw authorityError('workspace_root_in_use', 'Handoff target root overlaps an active operation');
      try {
        signal?.throwIfAborted();
        await target.assertCurrent();
        const current = await lstat(requested).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        if (current && (!current.isDirectory() || current.isSymbolicLink())) {
          throw authorityError('workspace_root_unsafe', 'Handoff target root must be a real directory');
        }
        // Only source materialization replaces what is already here; attaching
        // an existing checkout preserves it and reconciles the difference as
        // ordinary conflicts. This mirrors the bootstrap owner's own rule, so
        // the proof this preflight stamps is the one that owner will require.
        // An omitted intent keeps the original materializing meaning.
        const replacesWhenNonEmpty = request.destinationIntent !== 'use_existing';
        let replacesNonEmptyTarget = false;
        // An absent root has no object identity to fingerprint; its canonical
        // absence is the fact the approval binds, so a root appearing later
        // fails the replay comparison exactly like a changed root would.
        let rootFingerprint = computeWorkspaceSyncAbsentRootFingerprint(canonicalRoot);
        if (current) {
          const currentCanonicalRoot = await realpath(requested);
          if (currentCanonicalRoot !== canonicalRoot) {
            throw authorityError('root_changed', 'Handoff target root changed during inspection');
          }
          replacesNonEmptyTarget = replacesWhenNonEmpty
            && (await readdir(currentCanonicalRoot)).length > 0;
          await ownership.bindCurrentRootIdentity();
          rootFingerprint = await computeWorkspaceSyncRootFingerprint(currentCanonicalRoot);
        }
        // Exact mirroring authorizes deleting target-only files for the life of
        // the relationship, so it needs the destination confirmation even when
        // there is nothing to replace today. Both consequences of one
        // destination decision travel in one proof.
        const consequences = [
          ...(replacesNonEmptyTarget ? ['replace_nonempty_workspace_target'] as const : []),
          ...(request.activatesExactMirror ? ['delete_target_only_files_during_exact_mirror'] as const : []),
        ];
        if (consequences.length === 0) {
          return HandoffTargetReplacementPreflightResultV1Schema.parse({ type: 'not_required' });
        }
        return HandoffTargetReplacementPreflightResultV1Schema.parse({
          type: 'approval_required',
          approval: HandoffTargetReplacementApprovalV1Schema.parse({
            v: 1,
            consequences,
            serverId: localServerId,
            machineId: request.machineId,
            canonicalRoot: target.approvalRoot ?? canonicalRoot,
            rootFingerprint,
            operationId: request.operationId,
          }),
        });
      } finally {
        await ownership.release();
      }
    },

    preflightHandoffTargetReplacementAtTarget: async (request, context) => {
      const { signal: _signal, ...wireInput } = request;
      const wireRequest = HandoffTargetReplacementPreflightV1Schema.parse(wireInput);
      if (wireRequest.serverId !== localServerId) {
        throw authorityError('target_unavailable', 'Handoff target server does not match this daemon');
      }
      const source = context?.workspaceSyncSourceWriterTargetRouting?.source ?? context?.workspaceSyncSourceRouting;
      if (context?.callerInputAuthorization && source) {
        if (!source.sourceContext || source.accountServerId !== localServerId || source.operationId !== wireRequest.operationId
          || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()
          || !dependencies.callWorkspaceTargetPhase) {
          throw authorityError('workspace_sync_update_required', 'The admitted original target transport is unavailable');
        }
        return HandoffTargetReplacementPreflightResultV1Schema.parse(await dependencies.callWorkspaceTargetPhase({
          machineId: wireRequest.machineId, method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT,
          request: wireRequest, routing: { v: 1, phase: 'preflight', operationId: wireRequest.operationId,
            accountServerId: localServerId, targetMachineId: wireRequest.machineId, targetRootPath: wireRequest.targetPath },
          ...(request.signal ? { signal: request.signal } : {}),
        }, context));
      }
      const target = await readReplacementTarget(wireRequest.machineId, wireRequest.targetPath, request.signal);
      if (target.machineId === localMachineId) {
        return await authority.preflightHandoffTargetReplacementHere(wireRequest, request.signal);
      }
      return HandoffTargetReplacementPreflightResultV1Schema.parse(await dependencies.callMachineRpc({
        machineId: target.machineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT,
        request: wireRequest,
        ...(request.signal ? { signal: request.signal } : {}),
      }));
    },

    prepareSourceSeedExport: async (request) => {
      if (!dependencies.prepareSourceSeedExport) {
        throw authorityError('target_bootstrap_offline', 'Workspace sync source seed is unavailable');
      }
      return await dependencies.prepareSourceSeedExport({
        operationId: request.operationId,
        sourceWorkspaceRefId: request.sourceWorkspaceRefId,
        targetMachineId: request.targetMachineId,
        contentPolicy: request.contentPolicy,
      });
    },
    prepareConflictResolutionExport,
    releaseConflictResolutionCaptureHere,
    stageConflictResolutionHere,
    applyStagedConflictResolutionHere,
    discardStagedConflictResolutionHere,
    recoverConflictResolutionHere,
    readFileHere,
    observeEntryHere,
    stageConflictResolutionAtTarget: async (request) => {
      assertStateAvailable();
      const parsed = WorkspaceSyncTargetConflictStageV1Schema.parse(request);
      const { workspace } = resolveOwnedWorkspace(getSnapshot(), parsed.relationshipId, parsed.targetWorkspaceRefId, localServerId);
      if (workspace.machineId !== parsed.targetMachineId) {
        throw authorityError('approval_stale', 'Reviewed workspace conflict target Machine changed');
      }
      if (workspace.machineId === localMachineId) {
        await stageConflictResolutionHere(parsed, request.signal);
        return;
      }
      const response = await dependencies.callMachineRpc({
        machineId: workspace.machineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_STAGE,
        request: parsed,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      assertOkResult(response);
    },
    applyStagedConflictResolutionAtTarget: async (request) => {
      assertStateAvailable();
      const parsed = WorkspaceSyncTargetConflictApplyV1Schema.parse(request);
      const { workspace } = resolveOwnedWorkspace(getSnapshot(), parsed.relationshipId, parsed.targetWorkspaceRefId, localServerId);
      if (workspace.machineId !== parsed.targetMachineId) {
        throw authorityError('approval_stale', 'Reviewed workspace conflict target Machine changed');
      }
      if (workspace.machineId === localMachineId) {
        return await applyStagedConflictResolutionHere(parsed, request.signal);
      }
      return WorkspaceSyncTargetConflictApplyResultV1Schema.parse(await dependencies.callMachineRpc({
        machineId: workspace.machineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_APPLY,
        request: parsed,
        ...(request.signal ? { signal: request.signal } : {}),
      }));
    },
    discardStagedConflictResolutionAtTarget: async (request) => {
      const parsed = WorkspaceSyncTargetConflictApplyV1Schema.parse(request);
      if (parsed.targetMachineId === localMachineId) {
        await discardStagedConflictResolutionHere(parsed, request.signal);
        return;
      }
      const response = await dependencies.callMachineRpc({
        machineId: parsed.targetMachineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_STAGE_DISCARD,
        request: parsed,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      assertOkResult(response);
    },
    releaseConflictResolutionCaptureAtSource: async (request) => {
      const parsed = WorkspaceSyncConflictCaptureReleaseV1Schema.parse(request);
      if (parsed.sourceMachineId === localMachineId) {
        await releaseConflictResolutionCaptureHere(parsed);
        return;
      }
      const response = await dependencies.callMachineRpc({
        machineId: parsed.sourceMachineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_CAPTURE_RELEASE,
        request: parsed,
      });
      assertOkResult(response);
    },
    recoverConflictResolutionAtTarget: async (request) => {
      assertStateAvailable();
      const parsed = WorkspaceSyncTargetConflictRecoverV1Schema.parse({
        relationshipId: request.relationshipId,
        targetMachineId: request.targetMachineId,
        targetWorkspaceRefId: request.targetWorkspaceRefId,
      });
      const { workspace, transientAccess } = await resolveRecoveryWorkspace(parsed);
      if (workspace.machineId === localMachineId) {
        return await recoverConflictResolutionHere(parsed, request.signal);
      }
      await transientAccess?.assertCurrentAuthority();
      return WorkspaceSyncTargetConflictRecoverResultV1Schema.parse(await dependencies.callMachineRpc({
        machineId: workspace.machineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_RECOVER,
        request: parsed,
        ...(request.signal ? { signal: request.signal } : {}),
      }));
    },
    readFileAtTarget: async (request) => {
      assertStateAvailable();
      const targetRequest = WorkspaceSyncTargetFileReadV1Schema.parse({
        relationshipId: request.relationshipId,
        workspaceRefId: request.targetWorkspaceRefId,
        path: request.path,
        maxBytes: request.maxBytes,
        ...(request.expectedDigest === undefined ? {} : { expectedDigest: request.expectedDigest }),
      });
      const { workspace } = resolveOwnedWorkspace(getSnapshot(), targetRequest.relationshipId, targetRequest.workspaceRefId, localServerId);
      assertTargetMachine(workspace, request.targetMachineId);
      if (workspace.machineId.trim() === localMachineId) {
        return await readFileHere(targetRequest, request.signal);
      }
      return ReadWorkspaceSyncFileResultV1Schema.parse(await dependencies.callMachineRpc({
        machineId: workspace.machineId.trim(),
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ,
        request: targetRequest,
        ...(request.signal ? { signal: request.signal } : {}),
      }));
    },
    observeEntryAtTarget: async (request) => {
      assertStateAvailable();
      const targetRequest = WorkspaceSyncTargetEntryObserveV1Schema.parse({
        relationshipId: request.relationshipId,
        workspaceRefId: request.targetWorkspaceRefId,
        path: request.path,
      });
      const { workspace } = resolveOwnedWorkspace(getSnapshot(), targetRequest.relationshipId, targetRequest.workspaceRefId, localServerId);
      assertTargetMachine(workspace, request.targetMachineId);
      if (workspace.machineId.trim() === localMachineId) {
        return await observeEntryHere(targetRequest, request.signal);
      }
      return WorkspaceSyncEntryExpectationV1Schema.parse(await dependencies.callMachineRpc({
        machineId: workspace.machineId.trim(),
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_ENTRY_OBSERVE,
        request: targetRequest,
        ...(request.signal ? { signal: request.signal } : {}),
      }));
    },

    prepareBootstrapHere: async (rawRequest, signal, context) => {
      assertStateAvailable();
      signal?.throwIfAborted();
      const request = WorkspaceSyncTargetBootstrapPrepareV1Schema.parse(rawRequest);
      if (!bootstrap) {
        throw authorityError('workspace_sync_unavailable', 'Workspace sync target bootstrap is unavailable');
      }
      const writerTarget = context?.workspaceSyncSourceWriterTargetRouting
        ? WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(context.workspaceSyncSourceWriterTargetRouting) : undefined;
      const admittedContext = writerTarget && !context?.workspaceSyncTargetRouting
        && writerTarget.target.targetMachineId === localMachineId && context?.machineAdmission
        ? { ...context, workspaceSyncTargetRouting: WorkspaceSyncTargetRoutingV1Schema.parse({ ...writerTarget.target,
            targetContext: { ...writerTarget.source.sourceContext, machineAdmission: context.machineAdmission } }) }
        : context;
      const targetRouting = await readTargetRouting(admittedContext, 'prepare', request.bootstrapOperationId);
      const sourceWriterTargetRouting = await readSourceWriterTargetRouting(context, 'prepare', request.bootstrapOperationId, targetRouting);
      let admittedTarget: Awaited<ReturnType<typeof bindReplacementTarget>> | undefined;
      if (sourceWriterTargetRouting && targetRouting) {
        assertWorkspaceSyncRequesterBootstrapSupported({ authorization: context?.callerInputAuthorization,
          ownerKind: request.owner.kind });
        assertPrepareWrites(request, targetRouting.targetContext);
        admittedTarget = await bindReplacementTarget(targetRouting.targetMachineId, targetRouting.targetRootPath, signal);
        const child = admittedTarget.facts.find(fact => fact.machineId === targetRouting.targetMachineId);
        if (!child || child.installationId !== targetRouting.targetContext.machineAdmission.installationId
          || !admittedTarget.endpoint) {
          throw authorityError('workspace_sync_child_unavailable', 'The admitted child target does not resolve to this endpoint');
        }
        if (admittedTarget.machineId !== localMachineId) {
          if (targetRouting.targetMachineId !== localMachineId || context?.workspaceSyncTargetRouting
            || !dependencies.callWorkspaceTargetPhase || !context) {
            throw authorityError('workspace_sync_child_unavailable', 'The admitted target transport is unavailable');
          }
          await admittedTarget.assertCurrent();
          return WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse(await dependencies.callWorkspaceTargetPhase({
            machineId: admittedTarget.machineId, method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE,
            request, routing: { v: 1, phase: 'prepare', operationId: request.bootstrapOperationId,
              accountServerId: localServerId, targetMachineId: targetRouting.targetMachineId,
              targetRootPath: targetRouting.targetRootPath }, ...(signal ? { signal } : {}),
          }, context));
        }
      }
      // The physical TARGET owns its rows. A qualified joint request carries
      // only the remote SOURCE locator; its installed writer requalifies that
      // row when serving the seed, rather than sharing the borrower's graph.
      const admittedCopy = sourceWriterTargetRouting && admittedTarget?.endpoint && request.owner.kind === 'copy_once'
        ? { target: admittedTarget.endpoint, sourceWriterMachineId: sourceWriterTargetRouting.sourceWriter.machineId } : undefined;
      const invocationSnapshot = admittedCopy ? getSnapshot() : await readInvocationSnapshot(signal, context);
      const owner = resolveBootstrapOwner(invocationSnapshot, request, localServerId, admittedCopy);
      assertLocalWorkspacePlacement(owner.targetWorkspace, localServerId, localMachineId);
      // resolveBootstrapOwner may use a caller's transient runtime definition. Only
      // the receiving target's already-staged Home row can prove original creation.
      const persistedRelationship = invocationSnapshot?.relationships.find(relationship => relationship.relationshipId === owner.relationshipId);
      const persistedWorkerCopy = persistedRelationship && getWorkspaceSyncWorkerCopyV1(persistedRelationship);
      const workerCopyCreation = persistedRelationship && persistedWorkerCopy && owner.relationship
        && areWorkspaceSyncRelationshipDefinitionsEqual(persistedRelationship, owner.relationship)
        && areWorkspaceSyncWorkerCopyProvenancesEqual(persistedRelationship, owner.relationship)
        && persistedWorkerCopy.sourceWorkspaceRefId === owner.sourceWorkspaceRefId
        && persistedWorkerCopy.targetWorkspaceRefId === owner.targetWorkspaceRefId
        ? { serverId: localServerId, relationshipId: persistedRelationship.relationshipId,
          sourceWorkspaceRefId: persistedWorkerCopy.sourceWorkspaceRefId, targetWorkspaceRefId: persistedWorkerCopy.targetWorkspaceRefId }
        : undefined;
      const localSourceRootPath = owner.sourceMachineId === localMachineId ? owner.sourceRootPath : undefined;
      if (owner.sourceMachineId === localMachineId && localSourceRootPath === undefined) {
        throw authorityError('workspace_ref_not_ready', 'The local source root is unavailable');
      }
      if (sourceWriterTargetRouting && (request.owner.kind !== 'copy_once'
        || request.owner.operation.operationId !== sourceWriterTargetRouting.source.operationId)) {
        throw authorityError('bootstrap_definition_conflict', 'The source writer copy operation changed');
      }
      if (targetRouting) {
        assertPrepareWrites(request, targetRouting.targetContext, owner.relationship);
        admittedTarget ??= await bindReplacementTarget(targetRouting.targetMachineId, targetRouting.targetRootPath, signal);
        const child = admittedTarget.facts.find(fact => fact.machineId === targetRouting.targetMachineId);
        if (!child || child.installationId !== targetRouting.targetContext.machineAdmission.installationId
          || admittedTarget.machineId !== localMachineId || admittedTarget.rootPath !== owner.targetRootPath
          || admittedTarget.endpoint?.id !== owner.targetWorkspaceRefId) {
          throw authorityError('workspace_sync_child_unavailable', 'The admitted child target does not resolve to this endpoint');
        }
      }
      assertWorkspaceSyncRequesterBootstrapSupported({ authorization: context?.callerInputAuthorization,
        ownerKind: request.owner.kind, targetReplacement: request.targetReplacementApproval !== undefined,
        materializesRemoteSource: request.targetBootstrap === 'materialize_from_source_workspace'
          && owner.sourceMachineId !== localMachineId && admittedCopy === undefined });
      // Exact mirroring authorizes deleting target-only files for the life of
      // the relationship, whichever way this endpoint is established: attaching
      // an existing folder is non-destructive today and still deletes its
      // target-only files on the next reconciliation. The consequence therefore
      // belongs to every new mirroring endpoint, not only to a materializing
      // one. An established relationship rehydrating its READY custody carries
      // no bootstrap choice and needs no new proof.
      const activatesExactMirror = owner.relationship?.mode === 'mirror_exactly'
        && request.targetBootstrap !== undefined;
      let approvedTarget: Awaited<ReturnType<typeof bindReplacementTarget>> | undefined;
      // This daemon owns local authorization, and its prepare RPC is reachable
      // without the Action wrapper, so the complete binding is proven here
      // before any retained lookup or filesystem work. Canonical root and
      // object identity stay with bootstrap, which inspects the real target.
      if (request.targetReplacementApproval) {
        const approval = request.targetReplacementApproval;
        if (!dependencies.assertTargetReplacementAuthorized
          || !request.targetReplacementApprovalReceiptId
          || request.targetReplacementApprovalActionInput === undefined) {
          throw authorityError('approval_stale', 'Workspace target replacement approval has no Action receipt');
        }
        await dependencies.assertTargetReplacementAuthorized(
          request.targetReplacementApprovalReceiptId,
          request.targetReplacementApprovalActionInput,
          approval,
        );
        if (approval.serverId !== localServerId) {
          throw authorityError('approval_stale', 'Workspace target replacement approval placement is stale');
        }
        approvedTarget = await bindReplacementTarget(approval.machineId, approval.canonicalRoot, signal);
        if (approvedTarget.machineId !== localMachineId
          || (approvedTarget.endpoint !== null && (approvedTarget.endpoint.id !== owner.targetWorkspaceRefId
            || approvedTarget.rootPath !== owner.targetRootPath))) {
          throw authorityError('approval_stale', 'Workspace target replacement approval placement is stale');
        }
        const boundToThisOwner = owner.relationshipId === null
          ? approval.operationId === owner.operationId
          : deriveWorkspaceSyncRelationshipId(approval.operationId) === owner.relationshipId;
        if (!boundToThisOwner) {
          throw authorityError('approval_stale', 'Workspace target replacement approval is stamped for another operation');
        }
        if (approval.consequences.includes('delete_target_only_files_during_exact_mirror') !== activatesExactMirror) {
          throw authorityError('approval_stale', 'Workspace target replacement approval does not match this relationship mode');
        }
      }
      const authorityKey = retainedAuthorityKey({
        relationshipId: owner.relationshipId,
        operationId: owner.operationId,
        endpointRole: owner.endpointRole,
        targetWorkspaceRefId: owner.targetWorkspaceRefId,
      });
      const definition = canonicalBootstrapDefinition(request);
      const operationBinding = [...retained.entries()].find(([, entry]) => (
        entry.bootstrapOperationId === request.bootstrapOperationId
      ));
      if (operationBinding
        && (operationBinding[0] !== authorityKey
          || (operationBinding[1].definition !== definition
            && !isExactPersistedRelationshipReentry(operationBinding[1], owner, request)))) {
        throw authorityError('bootstrap_definition_conflict', 'Workspace sync bootstrap operation id already owns a different definition');
      }
      if (!request.targetBootstrap && !retained.has(authorityKey)) {
        if (!owner.relationship) {
          const rehydrated = request.owner.kind === 'copy_once' && owner.sourceWorkspace
            ? await rehydrateCopyOnceEndpoint({
                request: request as WorkspaceSyncTargetBootstrapPrepareV1 & Readonly<{ owner: Readonly<{ kind: 'copy_once'; operation: WorkspaceSyncCopyOnceV1 }> }>,
                targetWorkspace: owner.targetWorkspace,
                sourceWorkspace: owner.sourceWorkspace,
              })
            : null;
          if (!rehydrated) {
            throw authorityError('target_bootstrap_required', 'Workspace sync target requires an explicit bootstrap choice');
          }
        } else {
          if (!owner.sourceWorkspace) throw authorityError('workspace_ref_not_ready', 'The relationship source is unavailable');
          const rehydrated = await rehydrateRelationshipEndpoint({
            relationship: owner.relationship,
            endpointRole: owner.endpointRole,
            targetWorkspace: owner.targetWorkspace,
            sourceWorkspace: owner.sourceWorkspace,
          });
          if (!rehydrated) {
            throw authorityError('target_bootstrap_required', 'Existing workspace relationship has no verified target bootstrap');
          }
        }
      }
      return await exclusive(authorityKey, async () => {
        signal?.throwIfAborted();
        await admittedTarget?.assertCurrent();
        if (context?.callerInputAuthorization
          && !isDeepStrictEqual(owner, resolveBootstrapOwner(admittedCopy ? getSnapshot()
            : await readInvocationSnapshot(signal, context), request, localServerId, admittedCopy))) {
          throw authorityError('workspace_ref_not_ready', 'The admitted requester endpoint changed before preparation');
        }
        const retainedEntry = retained.get(authorityKey);
        if (retainedEntry) {
          if (retainedEntry.bootstrapOperationId === request.bootstrapOperationId
            && (!isDeepStrictEqual(retainedEntry.targetRouting, targetRouting)
              || !isDeepStrictEqual(retainedEntry.sourceWriterTargetRouting, sourceWriterTargetRouting))) {
            throw authorityError('bootstrap_definition_conflict', 'Workspace sync target authority changed before preparation');
          }
          const persistedRelationshipReentry = isExactPersistedRelationshipReentry(retainedEntry, owner, request);
          if (retainedEntry.bootstrapOperationId === request.bootstrapOperationId
            && retainedEntry.definition !== definition
            && !persistedRelationshipReentry) {
            throw authorityError('bootstrap_definition_conflict', 'Workspace sync bootstrap operation id already owns a different definition');
          }
          if (!retainedBootstrapMatchesOwner(retainedEntry, owner, request)) {
            throw authorityError('bootstrap_definition_conflict', 'Workspace sync target authority conflicts with the current settings owner');
          }
          if (retainedEntry.bootstrapOperationId === request.bootstrapOperationId) {
            if (persistedRelationshipReentry) {
              const currentRoot = await realpath(owner.targetRootPath).catch(() => null);
              const currentFingerprint = currentRoot
                ? await computeWorkspaceSyncRootFingerprint(currentRoot).catch(() => null)
                : null;
              if (currentRoot !== retainedEntry.handle.owner.canonicalRoot
                || currentFingerprint !== retainedEntry.result.rootFingerprint) {
                await discardRetained(authorityKey);
                throw authorityError('root_changed', 'Workspace sync target root identity changed before settings reconciliation');
              }
              retained.set(authorityKey, { ...retainedEntry, definition });
            }
            return retainedEntry.result;
          }
          const currentRoot = await realpath(owner.targetRootPath).catch(() => null);
          const currentFingerprint = currentRoot
            ? await computeWorkspaceSyncRootFingerprint(currentRoot).catch(() => null)
            : null;
          if (currentRoot !== retainedEntry.handle.owner.canonicalRoot
            || currentFingerprint !== retainedEntry.result.rootFingerprint) {
            await discardRetained(authorityKey);
            throw authorityError('root_changed', 'Workspace sync target root identity changed before handoff rebinding');
          }
          const reboundResult = WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse({
            ...retainedEntry.result,
            bootstrapOperationId: request.bootstrapOperationId,
            created: false,
          });
          const { targetRouting: _priorTargetRouting, sourceWriterTargetRouting: _priorSourceWriterTargetRouting, ...retainedBasis } = retainedEntry;
          retained.set(authorityKey, {
            ...retainedBasis,
            bootstrapOperationId: request.bootstrapOperationId,
            definition,
            result: reboundResult,
            ...(targetRouting ? { targetRouting } : {}),
            ...(sourceWriterTargetRouting ? { sourceWriterTargetRouting } : {}),
          });
          return reboundResult;
        }
        signal?.throwIfAborted();
        const remoteMaterialize = request.targetBootstrap === 'materialize_from_source_workspace'
          && owner.sourceMachineId !== localMachineId
          ? async (canonicalRoot: string, materializationReceiptPath: string, originalTargetExists: boolean, targetFence: WorkspaceTargetMaterializationFence): Promise<WorkspaceExportMaterializationCustody> => {
              if (!bootstrap.materializeRemoteSeed) {
                throw authorityError('target_bootstrap_offline', 'Workspace sync source seed is unavailable');
              }
              return await bootstrap.materializeRemoteSeed({
                operationId: owner.operationId,
                sourceMachineId: owner.sourceMachineId,
                sourceWorkspaceRefId: owner.sourceWorkspaceRefId,
                canonicalRoot,
                contentPolicy: owner.contentPolicy,
                materializationReceiptPath,
                originalTargetExists,
                targetFence,
                ...(signal ? { signal } : {}),
              });
            }
          : null;
        const localMaterialize = request.targetBootstrap === 'materialize_from_source_workspace'
          && localSourceRootPath !== undefined
          ? async (canonicalRoot: string, materializationReceiptPath: string, originalTargetExists: boolean, targetFence: WorkspaceTargetMaterializationFence): Promise<WorkspaceExportMaterializationCustody> => {
              if (!bootstrap.materializeLocalSeed) {
                throw authorityError('target_bootstrap_offline', 'Workspace sync local source seed is unavailable');
              }
              return await bootstrap.materializeLocalSeed({
                operationId: owner.operationId,
                sourcePath: localSourceRootPath,
                canonicalRoot,
                contentPolicy: owner.contentPolicy,
                materializationReceiptPath,
                originalTargetExists,
                targetFence,
              });
            }
          : null;
        const prepared = await workspaceSyncTargetBootstrap({
          rootPath: owner.targetRootPath,
          ...(localSourceRootPath !== undefined
            ? { sourceRootPath: localSourceRootPath }
            : {}),
          relationshipId: owner.operationId,
          endpointRole: request.endpointRole,
          targetWorkspaceRefId: owner.targetWorkspaceRefId,
          policyDigest: request.policyDigest,
          contentSelection: owner.contentPolicy.selection,
          ...(workerCopyCreation ? { workerCopyCreation } : {}),
          ...(request.targetReplacementApproval
            ? { targetReplacementApproval: request.targetReplacementApproval }
            : {}),
          ...(approvedTarget?.approvalRoot ? { targetReplacementApprovalTarget: {
            canonicalRoot: approvedTarget.approvalRoot, assertCurrent: approvedTarget.assertCurrent,
          } } : {}),
          activatesExactMirror,
          materializationDirectory: bootstrap.materializationDirectory,
          rootOwnershipManager: bootstrap.rootOwnershipManager,
          ...(owner.contentPolicy.selection === 'git_worktree' && remoteMaterialize
            ? { prepareGitTarget: async (gitInput: Parameters<NonNullable<WorkspaceSyncTargetBootstrapInput['prepareGitTarget']>>[0]) => {
                if (gitInput.targetBootstrap === 'use_existing') {
                  if (bootstrap.prepareGitTarget) {
                    await bootstrap.prepareGitTarget(gitInput);
                  } else {
                    await prepareExistingGitWorkspaceSyncTarget({
                      canonicalRoot: gitInput.canonicalRoot,
                      targetState: gitInput.targetState,
                    });
                  }
                  return;
                }
                const custody = await remoteMaterialize(
                  gitInput.canonicalRoot,
                  gitInput.materializationReceiptPath,
                  gitInput.targetState !== 'missing',
                  gitInput.targetFence,
                );
                await prepareExistingGitWorkspaceSyncTarget({ canonicalRoot: gitInput.canonicalRoot, targetState: 'nonempty' });
                return custody;
              } }
            : bootstrap.prepareGitTarget ? { prepareGitTarget: bootstrap.prepareGitTarget } : {}),
          ...(owner.contentPolicy.selection === 'all_files' && remoteMaterialize
            ? { materializeSeed: async ({ canonicalRoot, materializationReceiptPath, originalTargetExists, targetFence }: { canonicalRoot: string; materializationReceiptPath: string; originalTargetExists: boolean; targetFence: WorkspaceTargetMaterializationFence }) => await remoteMaterialize(canonicalRoot, materializationReceiptPath, originalTargetExists, targetFence) }
            : owner.contentPolicy.selection === 'all_files' && localMaterialize
              ? { materializeSeed: async ({ canonicalRoot, materializationReceiptPath, originalTargetExists, targetFence }: { canonicalRoot: string; materializationReceiptPath: string; originalTargetExists: boolean; targetFence: WorkspaceTargetMaterializationFence }) => await localMaterialize(canonicalRoot, materializationReceiptPath, originalTargetExists, targetFence) }
            : {}),
          createIfMissing: request.createIfMissing,
          targetBootstrap: request.targetBootstrap!,
        }, {
          ...(bootstrap.writeReadyFact ? { writeReadyFact: bootstrap.writeReadyFact } : {}),
          ...(bootstrap.rehydrateMaterializationFromReceiptPath
            ? { rehydrateMaterializationFromReceiptPath: bootstrap.rehydrateMaterializationFromReceiptPath }
            : {}),
        });
        const result = WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse({
          v: 1,
          bootstrapOperationId: request.bootstrapOperationId,
          targetWorkspaceRefId: owner.targetWorkspaceRefId,
          state: 'ready',
          created: prepared.created,
          rootFingerprint: prepared.rootFingerprint,
          policyDigest: prepared.policyDigest,
          ...(admittedCopy ? { targetWorkspace: owner.targetWorkspace } : {}),
        });
        const entry: RetainedBootstrap = {
          bootstrapOperationId: request.bootstrapOperationId,
          definition,
          result,
          handle: prepared.ownershipHandles[0]!,
          ...(prepared.materializationCustody
            ? { materializationCustody: prepared.materializationCustody }
            : {}),
          publishReady: prepared.publishReady,
          readyPublished: prepared.readyPublished,
          relationshipId: owner.relationshipId,
          operationId: owner.operationId,
          sourceWorkspaceRefId: owner.sourceWorkspaceRefId,
          sourceMachineId: owner.sourceMachineId,
          sourceRootPath: owner.sourceRootPath,
          targetWorkspaceRefId: owner.targetWorkspaceRefId,
          targetMachineId: owner.targetWorkspace.machineId.trim(),
          targetRootPath: owner.targetRootPath,
          endpointRole: owner.endpointRole,
          relationshipDefinition: owner.relationship,
          transientAuthority: request.transientRelationship !== undefined
            && !invocationSnapshot.relationships.some((candidate) => (
              candidate.relationshipId === owner.relationshipId && candidate.enabled
            )),
          createIfMissing: request.createIfMissing,
          ...(targetRouting ? { targetRouting } : {}),
          ...(sourceWriterTargetRouting ? { sourceWriterTargetRouting } : {}),
        };
        retained.set(authorityKey, entry);
        await commitPublishedMaterializationCustody(entry);
        return result;
      });
    },

    releaseBootstrapHere: async (rawRequest, signal, context) => {
      signal?.throwIfAborted();
      const request = WorkspaceSyncTargetBootstrapReleaseV1Schema.parse(rawRequest);
      const targetRouting = await readTargetRouting(context, 'release', request.bootstrapOperationId);
      const sourceWriterTargetRouting = await readSourceWriterTargetRouting(context, 'release', request.bootstrapOperationId);
      const match = [...retained.entries()].find(([, entry]) => (
        entry.bootstrapOperationId === request.bootstrapOperationId
      ));
      if (!match) return WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse({ ok: true, released: false });
      const [authorityKey] = match;
      return await exclusive(authorityKey, async () => {
        signal?.throwIfAborted();
        let entry = retained.get(authorityKey);
        if (!entry || entry.bootstrapOperationId !== request.bootstrapOperationId) {
          return WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse({ ok: true, released: false });
        }
        // A lost ACK leaves the source with its admitted logical ref, not the
        // physical row returned by preparation. Only the same retained B loan
        // may use that exact original definition; ordinary releases stay exact.
        const originalDefinition: unknown = entry.sourceWriterTargetRouting && sourceWriterTargetRouting
          ? JSON.parse(entry.definition) : null;
        const matchesOriginalRef = originalDefinition !== null && typeof originalDefinition === 'object'
          && 'targetWorkspaceRefId' in originalDefinition && originalDefinition.targetWorkspaceRefId === request.targetWorkspaceRefId;
        if (entry.targetWorkspaceRefId !== request.targetWorkspaceRefId && !matchesOriginalRef) {
          throw authorityError('bootstrap_definition_conflict', 'Workspace sync bootstrap release does not match the retained operation');
        }
        if (entry.sourceWriterTargetRouting || sourceWriterTargetRouting
          ? !isDeepStrictEqual(entry.sourceWriterTargetRouting, sourceWriterTargetRouting)
          : !isDeepStrictEqual(entry.targetRouting, targetRouting)) {
          throw authorityError('bootstrap_definition_conflict', 'Workspace sync target cleanup authority does not match the retained operation');
        }
        const durableRelationshipOwnsEndpoint = entry.relationshipId
          ? relationshipOwnsEndpoint(getSnapshot(), entry, false)
          : false;
        if (entry.relationshipId && (relationshipStillOwnsEndpoint(getSnapshot(), entry)
          || (request.reason === 'relationship_committed'
            && (durableRelationshipOwnsEndpoint || entry.transientAuthority)))) {
          if (request.reason === 'relationship_committed') {
            if (!entry.readyPublished) {
              await entry.publishReady();
              entry = { ...entry, readyPublished: true };
              retained.set(authorityKey, entry);
            }
            await commitPublishedMaterializationCustody(entry);
          }
          // The persistent relationship still owns this endpoint: its fence
          // must survive abort/copy_committed until the relationship is
          // disabled/terminated or the daemon shuts down.
          return WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse({ ok: true, released: false });
        }
        await discardRetained(authorityKey, request.reason === 'abort' ? 'abort' : 'commit');
        return WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse({ ok: true, released: true });
      });
    },

    prepareBootstrapAtTarget: async (request, context) => {
      assertStateAvailable();
      const wireRequest = WorkspaceSyncTargetBootstrapPrepareV1Schema.parse({
        v: request.v,
        bootstrapOperationId: request.bootstrapOperationId,
        owner: request.owner,
        ...(request.transientRelationship ? { transientRelationship: request.transientRelationship } : {}),
        targetWorkspaceRefId: request.targetWorkspaceRefId,
        endpointRole: request.endpointRole,
        policyDigest: request.policyDigest,
        createIfMissing: request.createIfMissing,
        ...(request.targetBootstrap ? { targetBootstrap: request.targetBootstrap } : {}),
        ...(request.targetReplacementApproval
          ? {
              targetReplacementApproval: request.targetReplacementApproval,
              targetReplacementApprovalReceiptId: request.targetReplacementApprovalReceiptId,
              targetReplacementApprovalActionInput: request.targetReplacementApprovalActionInput,
            }
          : {}),
      });
      const source = context?.workspaceSyncSourceWriterTargetRouting?.source ?? context?.workspaceSyncSourceRouting;
      if (context?.callerInputAuthorization && source) {
        assertWorkspaceSyncRequesterBootstrapSupported({ authorization: context.callerInputAuthorization,
          ownerKind: wireRequest.owner.kind });
        if (!source.sourceContext || !request.admittedTarget || source.accountServerId !== localServerId
          || source.operationId !== wireRequest.bootstrapOperationId
          || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()
          || !dependencies.callWorkspaceTargetPhase) {
          throw authorityError('workspace_sync_update_required', 'The admitted original target transport is unavailable');
        }
        assertPrepareWrites(wireRequest, source.sourceContext);
        return WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse(await dependencies.callWorkspaceTargetPhase({
          machineId: request.admittedTarget.machineId,
          method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE, request: wireRequest,
          routing: { v: 1, phase: 'prepare', operationId: wireRequest.bootstrapOperationId,
            accountServerId: localServerId, targetMachineId: request.admittedTarget.machineId,
            targetRootPath: request.admittedTarget.rootPath }, ...(request.signal ? { signal: request.signal } : {}),
        }, context));
      }
      const workspace = resolveWorkspaceRef(await readInvocationSnapshot(request.signal, context), wireRequest.targetWorkspaceRefId, localServerId);
      assertTargetMachine(workspace, request.targetMachineId);
      const admittedMachineId = request.admittedTarget?.machineId ?? workspace.machineId.trim();
      if (admittedMachineId === localMachineId) {
        const result = await authority.prepareBootstrapHere(wireRequest, request.signal, context);
        const retainedEntry = [...retained.values()].find((entry) => (
          entry.bootstrapOperationId === wireRequest.bootstrapOperationId
          && entry.targetWorkspaceRefId === wireRequest.targetWorkspaceRefId
        ));
        if (!retainedEntry) {
          throw authorityError('workspace_root_ownership_lost', 'Workspace sync target custody was not retained');
        }
        return { ...result, ownershipHandles: [retainedEntry.handle] };
      }
      if (context?.callerInputAuthorization) {
        throw authorityError('workspace_sync_update_required', 'The original requester target transport is unavailable');
      }
      return WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse(await dependencies.callMachineRpc({
        machineId: admittedMachineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE,
        request: wireRequest,
        ...(request.signal ? { signal: request.signal } : {}),
      }));
    },

    releaseBootstrapAtTarget: async (request, context) => {
      const wireRequest = WorkspaceSyncTargetBootstrapReleaseV1Schema.parse({
        v: request.v,
        bootstrapOperationId: request.bootstrapOperationId,
        targetWorkspaceRefId: request.targetWorkspaceRefId,
        reason: request.reason,
      });
      if (request.physicalEndpoint && context?.workspaceSyncSourceWriterTargetRouting) {
        const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(context.workspaceSyncSourceWriterTargetRouting);
        if (routing.target.phase !== 'release' || routing.target.operationId !== wireRequest.bootstrapOperationId
          || routing.target.accountServerId !== localServerId || routing.sourceWriter.machineId !== localMachineId
          || request.physicalEndpoint.machineId !== request.targetMachineId || context.callerInputAuthorization
          || !dependencies.callWorkspaceTargetPhase) {
          throw authorityError('workspace_sync_update_required', 'The retained target cleanup transport is unavailable');
        }
        return WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse(await dependencies.callWorkspaceTargetPhase({
          machineId: request.physicalEndpoint.machineId, method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE,
          request: wireRequest, routing: routing.target, physicalEndpoint: request.physicalEndpoint,
          ...(request.signal ? { signal: request.signal } : {}),
        }, context));
      }
      if (context?.callerInputAuthorization) {
        // Cleanup releases the exact already-retained finite receipt. It is not
        // a new Account effect and remains possible after requester retirement.
        const entry = [...retained.values()].find(candidate => candidate.bootstrapOperationId === request.bootstrapOperationId
          && candidate.targetWorkspaceRefId === request.targetWorkspaceRefId
          && candidate.targetMachineId === request.targetMachineId);
        if (entry && entry.relationshipId === null && entry.targetMachineId === localMachineId) {
          return await authority.releaseBootstrapHere(wireRequest, request.signal);
        }
        throw authorityError('workspace_sync_update_required', 'The original requester target cleanup transport is unavailable');
      }
      const workspace = resolveWorkspaceRef(getSnapshot(), wireRequest.targetWorkspaceRefId, localServerId);
      assertTargetMachine(workspace, request.targetMachineId);
      const admittedMachineId = request.admittedTarget?.machineId ?? workspace.machineId.trim();
      if (admittedMachineId === localMachineId) {
        return await authority.releaseBootstrapHere(wireRequest, request.signal);
      }
      const result: unknown = await dependencies.callMachineRpc({
        machineId: admittedMachineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE,
        request: wireRequest,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      assertResultOk(result);
      return WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse(result);
    },

    acquireWorkspaceSyncMachineIngress: async (request) => {
      assertStateAvailable();
      request.signal?.throwIfAborted();
      if (!dependencies.openRootedAgent) {
        throw authorityError('agent_unavailable', 'Verified rooted workspace sync agent is unavailable');
      }
      const openRootedAgent = dependencies.openRootedAgent;
      const facts = {
        operationId: request.operationId.trim(),
        sourceMachineId: request.sourceMachineId.trim(),
        targetMachineId: request.targetMachineId.trim(),
      };
      if (request.expiresAtMs !== undefined && request.expiresAtMs <= Date.now()) {
        throw authorityError('peer_unavailable', 'Workspace sync machine ingress authorization expired');
      }
      if (Object.values(facts).some((value) => !value)) {
        throw authorityError('peer_unavailable', 'Workspace sync machine ingress identity is incomplete');
      }
      if (facts.targetMachineId !== localMachineId) {
        throw authorityError('peer_unavailable', 'Workspace sync machine ingress targets another daemon');
      }
      return await exclusive(`machine-ingress:${facts.operationId}:${facts.sourceMachineId}:${facts.targetMachineId}`, async () => {
      let matches = [...retained.entries()].filter(([, entry]) => (
        entry.operationId === facts.operationId
        && entry.sourceMachineId === facts.sourceMachineId
        && entry.targetMachineId === facts.targetMachineId
      ));
      if (matches.length === 0) {
        await rehydrateIngressOwner(facts);
        matches = [...retained.entries()].filter(([, entry]) => (
          entry.operationId === facts.operationId
          && entry.sourceMachineId === facts.sourceMachineId
          && entry.targetMachineId === facts.targetMachineId
        ));
      }
      if (matches.length !== 1) {
        throw authorityError('peer_unavailable', 'Workspace sync machine ingress is not owned by a ready target');
      }
      const [authorityKey, entry] = matches[0]!;
      const target = resolveWorkspaceRef(getSnapshot(), entry.targetWorkspaceRefId, localServerId);
      assertLocalWorkspacePlacement(target, localServerId, localMachineId);
      const currentRoot = await assertRetainedRootIdentity({
        authorityKey,
        entry,
        rootPath: target.rootPath,
      });

      if ((activeIngresses.get(authorityKey)?.size ?? 0) > 0) {
        throw authorityError('peer_unavailable', 'Workspace sync machine ingress is already active');
      }
      if (closing) {
        throw authorityError('peer_unavailable', 'Workspace sync target authority is shutting down');
      }
      if (entry.relationshipId
        && !entry.transientAuthority
        && !relationshipStillOwnsEndpoint(getSnapshot(), entry)) {
        throw authorityError('relationship_not_ready', 'Workspace sync relationship no longer owns the target endpoint');
      }
      const agentAbort = new AbortController();
      let openerPromise: Promise<WorkspaceSyncOwnedLocalAgent> | null = null;
      let closeIngress: (() => Promise<void>) | null = null;
      let agentStopPromise: Promise<void> | null = null;
      let ingressSettlementPromise: Promise<void> | null = null;
      let activeCloser!: () => Promise<void>;
      const ingressClosers = activeIngresses.get(authorityKey) ?? new Set<() => Promise<void>>();
      const stopOpenedAgent = (agent: WorkspaceSyncOwnedLocalAgent): Promise<void> => {
        if (agentStopPromise) return agentStopPromise;
        agentStopPromise = (async () => {
          agent.stream.destroy();
          await agent.stop();
          ingressClosers.delete(activeCloser);
          if (ingressClosers.size === 0) activeIngresses.delete(authorityKey);
          notifyActivity();
        })().catch((error: unknown) => {
          agentStopPromise = null;
          throw error;
        });
        return agentStopPromise;
      };
      activeCloser = (): Promise<void> => {
        if (ingressSettlementPromise) return ingressSettlementPromise;
        ingressSettlementPromise = (async () => {
          agentAbort.abort();
          const pendingOpener = openerPromise;
          if (!pendingOpener) return;
          let openedAgent: WorkspaceSyncOwnedLocalAgent;
          try {
            openedAgent = await pendingOpener;
          } catch {
            request.signal?.removeEventListener('abort', abortFromCaller);
            ingressClosers.delete(activeCloser);
            if (ingressClosers.size === 0) activeIngresses.delete(authorityKey);
            notifyActivity();
            return;
          }
          request.signal?.removeEventListener('abort', abortFromCaller);
          if (closeIngress) await closeIngress();
          else await stopOpenedAgent(openedAgent);
        })().catch((error: unknown) => {
          ingressSettlementPromise = null;
          throw error;
        });
        return ingressSettlementPromise;
      };
      ingressClosers.add(activeCloser);
      activeIngresses.set(authorityKey, ingressClosers);
      notifyActivity();
      // Event-driven cleanup (caller abort, peer socket or rooted-agent stream
      // end) consumes its own close rejection: a rooted agent that fails to
      // stop must not surface as an unhandled rejection in the daemon process.
      // Custody stays with `close`, which resets itself on failure so
      // `activeCloser` and the returned explicit closer can retry it.
      const scheduleClose = () => { void activeCloser().catch(() => undefined); };
      const abortFromCaller = () => {
        agentAbort.abort(request.signal?.reason);
        scheduleClose();
      };
      request.signal?.addEventListener('abort', abortFromCaller, { once: true });
      openerPromise = Promise.resolve().then(() => openRootedAgent({
        operationId: facts.operationId,
        role: entry.endpointRole,
        workspaceRefId: entry.targetWorkspaceRefId,
        canonicalRoot: currentRoot,
        signal: agentAbort.signal,
      }));
      const agent = await openerPromise.catch((error) => {
        request.signal?.removeEventListener('abort', abortFromCaller);
        ingressClosers.delete(activeCloser);
        if (ingressClosers.size === 0) activeIngresses.delete(authorityKey);
        notifyActivity();
        throw error;
      });
      const closeLateAgent = async (): Promise<void> => {
        agentAbort.abort();
        request.signal?.removeEventListener('abort', abortFromCaller);
        await stopOpenedAgent(agent);
      };
      closeIngress = closeLateAgent;
      if (agentAbort.signal.aborted) {
        await activeCloser();
        throw authorityError('peer_unavailable', 'Workspace sync machine ingress ended before the rooted agent was ready');
      }
      if (closing) {
        await activeCloser();
        throw authorityError('peer_unavailable', 'Workspace sync target authority is shutting down');
      }
      if (entry.relationshipId
        && !entry.transientAuthority
        && !relationshipStillOwnsEndpoint(getSnapshot(), entry)) {
        await activeCloser();
        throw authorityError('relationship_not_ready', 'Workspace sync relationship no longer owns the target endpoint');
      }
      const server = createServer({ allowHalfOpen: true });
      const localCapability = createFirstBytesLocalCapability();
      const expectedLocalCapability = Buffer.from(localCapability, 'ascii');
      let accepted: Socket | null = null;
      const pendingCapabilitySockets = new Set<Socket>();
      let closed = false;
      let closePromise: Promise<void> | null = null;
      let attachExpiryTimer: NodeJS.Timeout | null = null;
      const close = (): Promise<void> => {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          if (!closed) {
            closed = true;
            if (attachExpiryTimer) clearTimeout(attachExpiryTimer);
            attachExpiryTimer = null;
            request.signal?.removeEventListener('abort', abortFromCaller);
            agentAbort.abort();
            for (const socket of pendingCapabilitySockets) socket.destroy();
            pendingCapabilitySockets.clear();
            accepted?.destroy();
            agent.stream.destroy();
            await closeListeningServer(server);
          }
          await stopOpenedAgent(agent);
        })().catch((error: unknown) => {
          closePromise = null;
          throw error;
        });
        return closePromise;
      };
      closeIngress = close;
      server.on('connection', (socket) => {
        if (closed || accepted || socket.remoteAddress !== '127.0.0.1') {
          socket.destroy();
          return;
        }
        pendingCapabilitySockets.add(socket);
        socket.once('close', () => pendingCapabilitySockets.delete(socket));
        void (async () => {
          let supplied: Buffer;
          try {
            supplied = await readFirstBytesLocalCapability(socket);
          } catch {
            socket.destroy();
            scheduleClose();
            return;
          }
          if (
            closed
            || accepted
            || !matchesFirstBytesLocalCapability(supplied, expectedLocalCapability)
          ) {
            socket.destroy();
            scheduleClose();
            return;
          }
          accepted = socket;
          if (attachExpiryTimer) clearTimeout(attachExpiryTimer);
          attachExpiryTimer = null;
          pendingCapabilitySockets.delete(socket);
          void closeListeningServer(server);
          socket.setNoDelay(true);
          socket.pipe(agent.stream, { end: false });
          agent.stream.pipe(socket, { end: false });
          socket.once('end', () => agent.stream.end());
          agent.stream.once('end', () => { if (!socket.destroyed) socket.end(); });
          socket.once('error', scheduleClose);
          socket.once('close', scheduleClose);
          agent.stream.once('error', scheduleClose);
          agent.stream.once('close', scheduleClose);
          socket.resume();
        })();
      });
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          server.once('error', rejectListen);
          server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
            server.off('error', rejectListen);
            resolveListen();
          });
        });
      } catch (error) {
        await close();
        throw error;
      }
      const address = server.address();
      if (!address || typeof address === 'string' || !Number.isSafeInteger(address.port) || address.port < 1) {
        await close();
        throw authorityError('agent_unavailable', 'Workspace sync loopback ingress did not bind a port');
      }
      if (request.signal?.aborted) {
        await close();
        request.signal.throwIfAborted();
      }
      if (retained.get(authorityKey) !== entry) {
        await close();
        throw authorityError('peer_unavailable', 'Workspace sync target ownership ended before ingress was ready');
      }
      if (entry.relationshipId
        && !entry.transientAuthority
        && !relationshipStillOwnsEndpoint(getSnapshot(), entry)) {
        await close();
        throw authorityError('relationship_not_ready', 'Workspace sync relationship no longer owns the target endpoint');
      }
      if (closing) {
        await close();
        throw authorityError('peer_unavailable', 'Workspace sync target authority is shutting down');
      }
      if (request.expiresAtMs !== undefined) {
        attachExpiryTimer = setTimeout(
          scheduleClose,
          Math.max(1, request.expiresAtMs - Date.now()),
        );
        attachExpiryTimer.unref();
      }
      return Object.freeze({ port: address.port, localCapability, close });
      });
    },

    reconcileRetainedBootstraps: async () => {
      const snapshot = getSnapshot();
      const rehydrateAfterReconciliation = async (
        input: Parameters<typeof rehydrateRelationshipEndpoint>[0],
      ): Promise<void> => {
        await rehydrateRelationshipEndpoint(input).catch((error: unknown) => {
          const code = (error as { code?: unknown }).code;
          if (code === 'root_changed'
            || code === 'target_bootstrap_required'
            || code === 'workspace_target_materialization_manual_recovery') return null;
          throw error;
        });
      };
      for (const [authorityKey, entry] of [...retained.entries()]) {
        if (entry.relationshipId) {
          const enabledOwner = relationshipStillOwnsEndpoint(snapshot, entry);
          const stagedOwner = entry.transientAuthority && relationshipOwnsEndpoint(snapshot, entry, false);
          if (!enabledOwner && !stagedOwner) {
            await discardRetained(authorityKey);
            continue;
          }
          if (enabledOwner && entry.transientAuthority) {
            retained.set(authorityKey, { ...entry, transientAuthority: false });
          }
          const workspace = resolveWorkspaceRefById(
            snapshot?.workspaceRefs ?? [],
            entry.targetWorkspaceRefId,
            localServerId,
          );
          if (!workspace) {
            await discardRetained(authorityKey);
            continue;
          }
          await assertRetainedRootIdentity({
            authorityKey,
            entry,
            rootPath: workspace.rootPath,
          }).catch(() => undefined);
        }
      }
      if (!snapshot || !bootstrap) return;
      for (const relationship of snapshot.relationships ?? []) {
        const hasLiveTransientAuthority = [...retained.values()].some((entry) => (
          entry.relationshipId === relationship.relationshipId && entry.transientAuthority
        ));
        if (!relationship.enabled && hasLiveTransientAuthority) continue;
        const alpha = resolveWorkspaceRefById(snapshot.workspaceRefs ?? [], relationship.alphaWorkspaceRefId, localServerId);
        const beta = resolveWorkspaceRefById(snapshot.workspaceRefs ?? [], relationship.betaWorkspaceRefId, localServerId);
        if (!alpha || !beta) continue;
        if (alpha.machineId.trim() === localMachineId) {
          await rehydrateAfterReconciliation({
            relationship,
            endpointRole: 'alpha',
            targetWorkspace: alpha,
            sourceWorkspace: beta,
            ...(!relationship.enabled ? { recoverMaterializationOnly: true } : {}),
          });
        }
        if (beta.machineId.trim() === localMachineId) {
          await rehydrateAfterReconciliation({
            relationship,
            endpointRole: 'beta',
            targetWorkspace: beta,
            sourceWorkspace: alpha,
            ...(!relationship.enabled ? { recoverMaterializationOnly: true } : {}),
          });
        }
        if (!relationship.enabled) {
          for (const [authorityKey, entry] of [...retained.entries()]) {
            if (entry.relationshipId === relationship.relationshipId) await discardRetained(authorityKey);
          }
        }
      }
    },

    releaseAllRetainedBootstraps: async () => {
      closing = true;
      notifyActivity();
      const ingressCloseFailures = new Map<string, unknown[]>();
      await Promise.all([...activeIngresses.entries()].map(async ([authorityKey, closers]) => {
        const results = await Promise.allSettled([...closers].map(async (close) => await close()));
        const rejected = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (rejected.length > 0) ingressCloseFailures.set(authorityKey, rejected);
      }));
      await Promise.all([...inFlight.values()]);
      const failures: unknown[] = [];
      for (const authorityKey of [...retained.keys()]) {
        const ingressFailures = ingressCloseFailures.get(authorityKey);
        if (ingressFailures) {
          failures.push(...ingressFailures);
          continue;
        }
        await discardRetained(authorityKey).catch((error: unknown) => { failures.push(error); });
      }
      if (sourceLoans.size > 0) {
        failures.push(authorityError('peer_unavailable', 'Workspace sync source loans remain active during shutdown'));
      }
      for (const [operationId, captured] of capturedResolutions) {
        await rm(captured.captureDirectory, { recursive: true, force: true })
          .then(() => { capturedResolutions.delete(operationId); })
          .catch((error: unknown) => { failures.push(error); });
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Workspace sync target authority shutdown failed');
      }
    },
  };
  return authority;
}
