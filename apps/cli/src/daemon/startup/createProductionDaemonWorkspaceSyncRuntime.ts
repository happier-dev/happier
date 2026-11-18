import { assertWorkspaceSyncSeedExportSucceeded } from '@/workspaces/sync/workspaceSyncSeedTransfer';
import { createDefaultWorkspaceContentPolicyV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { finished } from 'node:stream/promises';
import { readAgentIsolationMemberDirectories } from '@/daemon/agentIsolation/prepareNativeOperation';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import * as z from 'zod/mini';
import { isProjectWorkspaceSyncPreparationActionV1, isProjectWorkspaceSyncOpenActionV1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
import { isWorkspaceSyncRelationshipWriteActionId } from '@happier-dev/protocol/actions/actionIds';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { readReviewedExternalActionInput } from '@/api/externalActionExecutionAuthorization';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { requireExecutingWorkspaceActionReceipt } from './workspaceActionReceipt';
import { readWorkspaceSyncSourceAdmissionV1, deriveWorkspaceSyncRelationshipId } from '@happier-dev/protocol/workspaces/workspaceSyncAdmissionV1';
import { DaemonLocalServiceLauncherStartRequestV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { createProjectServiceDeclarationTargetIdV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { WorkspaceManifest } from '@happier-dev/protocol/workspaces/manifestSchema';
import { captureManagedWorkspaceReturnStage } from '@/workspaces/sync/managedWorkspaceReturn';
import { reconcileManagedWorkspacePostMaterialization } from '@/scm/workspace/workspacePostMaterialization';
import { inspectWorkspaceLocationWithScmWorkspace } from '@/scm/workspace/workspaceLocationInspection';
import { runWithHolderWorkspaceSource } from '@/workspaces/source/holderWorkspaceSource';
import { resolveSessionTargetWorkspaceTransfer } from '@/daemon/sessions/sessionTargetWorkspaces';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import type {
  HandoffTargetReplacementApprovalV1,
  WorkspaceContentPolicyV1,
  WorkspaceSyncRuntimeReadinessV1,
  WorkspaceSyncStatusV1,
  WorkspaceSyncRelationshipV1,
  WorkspaceSyncTargetBootstrapPrepareV1,
  WorkspaceSyncLegacyStateInspectionV1,
  WorkspaceSyncConflictResolveActionInputV1,
  WorkspaceSyncPrepareBetweenRequestV1,
  WorkspaceSyncPrepareBetweenResultV1,
  WorkspaceRefV1,
  WorkspaceAddressV1,
  WorkspaceAddressV2,
} from '@happier-dev/protocol';
import { ProjectWorkerCopyRetireInputV1Schema } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { ProjectWorkerDependencyV1Schema, type ProjectWorkerDependencyV1 } from '@happier-dev/protocol/workspaces/projectWorkerExecutionV1';
import { WorkspaceSyncConflictResolveActionInputV1Schema, WorkspaceSyncStatusV1Schema, WorkspaceSyncPrepareBetweenResultV1Schema,
  WorkspaceSyncTargetBootstrapPrepareResultV1Schema, WorkspaceSyncTargetBootstrapPrepareV1Schema,
  WorkspaceSyncTargetConflictRecoverV1Schema, WorkspaceSyncTargetConflictRecoverResultV1Schema,
  type WorkspaceSyncRelationshipCreateRpcRequestV1,
  type HandoffTargetReplacementPreflightResultV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { computeActionInputApprovalDigestV1, resolveCredentialActionAdmissionV1, resolveWorkspaceWriteActionAdmissionV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { sameHandoffTargetReplacementApproval } from '@happier-dev/protocol/sessions/control/handoff/handoffTargetReplacementApprovalV1';
import { WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema, isWorkspaceSyncSourceWriterCleanupPhaseV1, type WorkspaceSyncSourceContextV1 } from '@happier-dev/protocol/socketRpc';
import type { MachineInstallationPublicIdentityV1 } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { resolveWorkspaceSyncEndpoint, resolveWorkspaceSyncTransferRoute, resolveWorkspaceSyncExecutionMachineIdV1 } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { isManagedWorkspaceRefV2, type ManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { ManagedWorkspaceSyncTarget } from '@/machines/managed/acquire';
import { startPrivateProjectSyncChannel } from '@/workspaces/activation/privateProjectCheckoutProcess';
import type { PrivateProjectNativeSync, PrivateProjectSyncNetwork } from '@/workspaces/activation/privateProjectSyncEffect';
import type { WorkspaceNativeCopyBaselineEffect } from '@/workspaces/activation/privateProjectSyncEffect';
import { runWorkspaceEffectChannel } from '@/workspaces/activation/workspaceEffectProcess';
import { createBufferTransferPayloadSource, createFileTransferPayloadSource, readTransferPayloadChunk, resolveTransferPayloadSizeBytes, resolveTransferPayloadManifestHash } from '@/machines/transfer/transferPayloadSource';
import { resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { TransferEndpointCandidateSchema } from '@happier-dev/protocol/machines/transfer/transferStream';
import type { TransferEndpointCandidate } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { captureServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { RpcError, readRpcErrorCode, isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';
import { WorkspaceSyncCommittedCopyTargetResultV1Schema, type WorkspaceSyncCommittedCopyTargetV1, type WorkspaceSyncCommittedCopyPreviewV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncCommittedCopyV1';

import type { MachineWorkspaceSyncRpcService } from '@/api/machine/rpcHandlers.workspaceSync';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { StoredCredentials } from '@/persistence';
import { preparePrivateProjectOpenCheckout, recoverPrivateProjectSyncCheckout, retainPrivateSyncCapture, type PrivateProjectCheckoutOpenRuntime } from '@/workspaces/activation/privateProjectOpenCheckout';
import { selectHostRequesterExecutionIdentity, resolveHostRequesterAgentExecutionIdentity,
  resolveHostRequesterAgentPlacementForHost, type HostAgentIsolationLaunchContext } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { resolveMachineRpcWorkingDirectory } from '@/api/machine/resolveMachineRpcWorkingDirectory';
import { buildActionExecutorContextForRpc, projectWorkspaceSyncPhysicalContextFromActionContext, type RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import type { WorkspaceSyncRequesterAvailabilityV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { createWorkspaceSyncSourceCredentialCustody, verifyWorkspaceSyncRelationshipMachineAdmissionCurrent,
  verifyWorkspaceSyncSourceMachineAdmissionCurrent,
  type RequesterSessionMachineAdmissionBoundary } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { recoverPrivateWorkspaceSyncExecutions } from './recoverPrivateWorkspaceSyncExecutions';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { resolveWorkspaceSyncRootOwnershipDirectory } from '@/configuration/resolveWorkspaceSyncRootOwnershipDirectory';
import { configuration } from '@/configuration';
import {
  getActiveProjectAccountRowsSnapshot,
  subscribeActiveProjectAccountRowsSnapshot,
  type ActiveProjectAccountRowsSnapshot,
  type ProjectAccountSessionCustody,
  readProjectAccountRows,
  createProjectAccountSnapshotMutation,
} from '@/workspaces/projectAccountRows';
import { resolveWorkspaceSyncRelationshipEndpointRoles } from '@/workspaces/sync/workspaceSyncRelationshipEndpoints';
import { materializeWorkspaceRefForMachineRoot, materializeWorkspaceRefForManagedRoot, resolveWorkspaceRefById, resolveWorkspaceRefForMachineRoot } from '@/workspaces/workspaceRefsV1';
import { callExactMachineRpc, callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { logger } from '@/ui/logger';
import {
  createWorkspaceRootOwnershipManager,
  type WorkspaceRootOwnershipHandle,
} from '@/workspaces/sync/workspaceSyncRootOwnership';
import {
  createWorkspaceSyncTargetAuthority,
  resolvePersistedWorkerCopyCreation,
  readWorkspaceSyncChildMachineFacts,
  type AcquireWorkspaceSyncMachineIngressRequest,
  type WorkspaceSyncMachineIngress,
  type WorkspaceSyncTargetPhaseDescriptor,
} from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { prepareWorkspaceSyncGitTarget } from '@/workspaces/sync/workspaceSyncTargetBootstrap';
import { areWorkspaceSyncRelationshipDefinitionsEqual, areWorkspaceSyncWorkerCopyProvenancesEqual, getWorkspaceSyncWorkerCopyV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { prepareWorkspaceSyncBetween, resolveWorkspaceSyncRelationshipDependencyMachines } from '@/workspaces/sync/workspaceSyncPreparation';
import { createMemberWorkspaceSyncSeedExport, createWorkspaceSyncSeedExport, materializeLocalWorkspaceSyncSeed, materializeWorkspaceSyncSeedExport, resolveWorkspaceSyncSeedTransfer as resolveSeedWorkspaceTransfer } from '@/workspaces/sync/workspaceSyncSeedTransfer';
import { materializeWorkspaceExportArtifactsWithScmWorkspace } from '@/scm/workspace/workspaceExportMaterialization';
import { buildDirectPeerTransferEndpointPath } from '@/machines/transfer/directPeerTransport';
import { createWorkspaceSyncPeerIdentityValidator } from '@/workspaces/sync/transport/workspaceSyncPeerIdentity';
import { inspectRetiredWorkspaceReplicationState } from '@/workspaces/sync/workspaceSyncLegacyState';
import { sameExecutionWorkspace, type WorkspaceSyncHandoffAdapter, type WorkspaceSyncPrivateExecution, type PrepareWorkspaceSyncHandoffInput,
  type RetainedWorkspaceSyncPrivateExecution } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import type { SessionHandoffWorkspaceCaptureRequestV3, SessionHandoffWorkspaceCaptureResultV3 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { requesterWorkspaceCaptureRequired, requiresRequesterWorkspaceCapture } from '@/api/machine/machineRpcAuthorization';
import {
  createWorkspaceSyncRelationshipOwner,
  type WorkspaceSyncRelationshipOwner,
  type WorkspaceSyncRelationshipOwnerOptions,
} from '@/workspaces/sync/workspaceSyncRelationshipOwner';
import {
  createWorkspaceSyncRelationshipForProject,
  type WorkspaceSyncRelationshipCreateDependencies,
} from '@/workspaces/sync/workspaceSyncRelationshipCreate';
import { connectWorkspaceSyncMachineTunnel, type WorkspaceSyncMachineTunnelOpen } from '@/workspaces/sync/workspaceSyncMachineCarrierStream';
import { createDaemonWorkspaceSyncBroker } from './createDaemonWorkspaceSyncBroker';
import {
  createDaemonWorkspaceSyncRuntime,
  type DaemonWorkspaceSyncRuntimeDependencies,
} from './createDaemonWorkspaceSyncRuntime';
import {
  launchWorkspaceSyncLocalAgent,
  spawnWorkspaceSyncSidecar,
  stopRetainedWorkspaceSyncNativeProcesses,
} from './workspaceSyncNativeProcessLaunchers';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { ProjectServiceRelocateInputV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { isExternalActionAuthorizationBoundToEnvelope } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { readWebLatencyTracePoint, timeWebLatencyPhase, withWebLatencyTrace } from '@/daemon/externalActions/webLatencyTrace';
import { createPrivateWorkspaceSyncSourceSeedPreparation, preparePrivateWorkspaceSyncExecution } from './workspaceSyncPrivateExecution';
import { isHostRequesterUnrestrictedOwner } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { OpenProjectResultV1Schema, type OpenProjectInputV1, type OpenProjectResultV1, type ProjectOpenSyncMaterializationResultV1 } from '@happier-dev/protocol/projects/openProjectV1';

export type PrepareManagedProjectFilesSyncInput = Readonly<{
  sourceRootPath: string;
  sourceWorkspace?: WorkspaceAddressV1;
  actionContext?: RpcActionExecutorContext;
  targetRootPath: string;
  mode: 'keep_synced' | 'keep_both_in_sync';
  contentPolicy?: WorkspaceContentPolicyV1;
  targetManaged: Readonly<{ managedId: string; controller?: ManagedWorkspaceRefV2['controller'] }>;
  requesterAccountId: string;
  credentials?: StoredCredentials;
  accountRowsCustody?: ProjectAccountSessionCustody;
  retainRelationship?(relationshipId: string, managedWorkspace: ManagedWorkspaceRefV2): Promise<void>;
  /** The containing Session invokes its existing reviewed Project child. */
  openProject?(request: OpenProjectInputV1): Promise<OpenProjectResultV1>;
  /** Ownership transfers to the retained relationship, independent of its Session. */
  releaseCustody?(): Promise<void>;
  sourceExecutionIdentity?: Parameters<typeof recoverPrivateProjectSyncCheckout>[0]['requesterIdentity'];
  signal?: AbortSignal;
}>;

export type ProductionDaemonWorkspaceSyncFactories = Readonly<{
  createDaemonRuntime: typeof createDaemonWorkspaceSyncRuntime;
  createTargetAuthority: typeof createWorkspaceSyncTargetAuthority;
  createRootOwnershipManager: typeof createWorkspaceRootOwnershipManager;
  resolveRootOwnershipDirectory: typeof resolveWorkspaceSyncRootOwnershipDirectory;
  createPeerIdentityValidator: typeof createWorkspaceSyncPeerIdentityValidator;
  createBroker: typeof createDaemonWorkspaceSyncBroker;
  spawnSidecar: typeof spawnWorkspaceSyncSidecar;
  launchLocalAgent: typeof launchWorkspaceSyncLocalAgent;
  stopRetainedNativeProcesses: typeof stopRetainedWorkspaceSyncNativeProcesses;
  getProjectSnapshot: () => ActiveProjectAccountRowsSnapshot | null;
  subscribeProjectSnapshot: typeof subscribeActiveProjectAccountRowsSnapshot;
  callMachineRpc: typeof callMachineRpc;
  inspectLegacyState: typeof inspectRetiredWorkspaceReplicationState;
  prepareGitTarget: typeof prepareWorkspaceSyncGitTarget;
  createRelationshipOwner: typeof createWorkspaceSyncRelationshipOwner;
  createRelationshipForProject: typeof createWorkspaceSyncRelationshipForProject;
  refreshProjectRows: typeof readProjectAccountRows;
  prepareSourceSeedExport: typeof createWorkspaceSyncSeedExport;
  materializeSeedExport: typeof materializeWorkspaceSyncSeedExport;
  materializeLocalSeed: typeof materializeLocalWorkspaceSyncSeed;
  startManagedSyncChannel: typeof startPrivateProjectSyncChannel;
  warn(message: string, error: unknown): void;
}>;

export type ProductionDaemonWorkspaceSyncRuntime = Readonly<{
  readProcessRoots: ReturnType<typeof createDaemonWorkspaceSyncRuntime>['readProcessRoots'];
  activity: import('@/daemon/lifecycle/managedActivity').LiveWorkProducerV1;
  handoffAdapter: WorkspaceSyncHandoffAdapter;
  workspaceSync: MachineWorkspaceSyncRpcService;
  acquireWorkspaceSyncMachineIngress(request: AcquireWorkspaceSyncMachineIngressRequest): Promise<WorkspaceSyncMachineIngress>;
  prepareManagedProjectFilesSync(input: PrepareManagedProjectFilesSyncInput): Promise<Readonly<{ relationshipId: string; targetWorkspace: WorkspaceAddressV2;
    contentPolicyDigest?: WorkspaceContentPolicyV1['policyDigest'] }>>;
  prepareManagedProjectFilesSeed(input: Omit<PrepareManagedProjectFilesSyncInput, 'mode'>): Promise<Readonly<{
    targetRootPath: string; targetWorkspace: WorkspaceAddressV2; baseline?: WorkspaceManifest; contentPolicyDigest?: WorkspaceContentPolicyV1['policyDigest'];
  }>>;
  readManagedProjectFilesBaseline(input: Readonly<{
    sessionId: string;
    targetWorkspace: Extract<WorkspaceAddressV2, { kind: 'managed' }>;
    credentials?: StoredCredentials;
    contentPolicyDigest?: WorkspaceContentPolicyV1['policyDigest'];
    signal?: AbortSignal;
  }>): Promise<WorkspaceManifest | null>;
  materializeManagedProjectTarget(input: OpenProjectInputV1, context: RpcHandlerContext): Promise<OpenProjectResultV1>;
  stop(): Promise<void>;
}>;

const defaultFactories: ProductionDaemonWorkspaceSyncFactories = {
  createDaemonRuntime: createDaemonWorkspaceSyncRuntime,
  createTargetAuthority: createWorkspaceSyncTargetAuthority,
  createRootOwnershipManager: createWorkspaceRootOwnershipManager,
  resolveRootOwnershipDirectory: resolveWorkspaceSyncRootOwnershipDirectory,
  createPeerIdentityValidator: createWorkspaceSyncPeerIdentityValidator,
  createBroker: createDaemonWorkspaceSyncBroker,
  spawnSidecar: spawnWorkspaceSyncSidecar,
  launchLocalAgent: launchWorkspaceSyncLocalAgent,
  stopRetainedNativeProcesses: stopRetainedWorkspaceSyncNativeProcesses,
  getProjectSnapshot: getActiveProjectAccountRowsSnapshot,
  subscribeProjectSnapshot: subscribeActiveProjectAccountRowsSnapshot,
  callMachineRpc,
  inspectLegacyState: inspectRetiredWorkspaceReplicationState,
  prepareGitTarget: prepareWorkspaceSyncGitTarget,
  createRelationshipOwner: createWorkspaceSyncRelationshipOwner,
  createRelationshipForProject: createWorkspaceSyncRelationshipForProject,
  refreshProjectRows: readProjectAccountRows,
  prepareSourceSeedExport: createWorkspaceSyncSeedExport,
  materializeSeedExport: materializeWorkspaceSyncSeedExport,
  materializeLocalSeed: materializeLocalWorkspaceSyncSeed,
  startManagedSyncChannel: startPrivateProjectSyncChannel,
  warn: (message, error) => logger.warn(message, error),
};

function compositionError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Transport admits the actor and recipient installation; the Action runner owns
 * Ask/Allow. The receiving workspace owners retain exact domain/byte custody.
 */
export function createWorkspaceSyncConflictResolutionAuthorizer():
  (actionReceiptId: string, rawActionInput: WorkspaceSyncConflictResolveActionInputV1) => Promise<void> {
  return async (_actionReceiptId, rawActionInput) => {
    WorkspaceSyncConflictResolveActionInputV1Schema.parse(rawActionInput);
  };
}

/**
 * The exact Action families whose admitted input may choose a workspace destination.
 *
 * Membership is decided by parsing against the canonical Action input schema —
 * never by trusting an Action id carried alongside the proof. An input that
 * matches neither closed family authorizes nothing, so an unrelated Action's
 * similarly shaped approval cannot be replayed here.
 */
function isWorkspaceDestinationActionInput(actionInput: unknown): boolean {
  const createSpec = getActionSpec('workspace.sync.relationship.create');
  if (createSpec.inputSchema.safeParse(actionInput).success) {
    return true;
  }
  if (getActionSpec('workspace.sync.relationship.replace').inputSchema.safeParse(actionInput).success) return true;
  const handoffSpec = getActionSpec('session.handoff');
  return handoffSpec.inputSchema.safeParse(actionInput).success;
}

/**
 * Destination family admission only. Bootstrap owns the operation, target root,
 * fingerprint and physical custody independently of configured approval policy.
 */
export function createWorkspaceDestinationApprovalAuthorizer(): (
  actionReceiptId: string,
  actionInput: unknown,
  approval: HandoffTargetReplacementApprovalV1,
) => Promise<void> {
  return async (_actionReceiptId, actionInput) => {
    if (!isWorkspaceDestinationActionInput(actionInput)) {
      throw compositionError(
        'approval_stale',
        'Workspace destination approval does not belong to a destination-choosing Action',
      );
    }
  };
}

/** The target's domain/custody checks bind these operands after ordinary RPC admission. */
export function createWorkspaceCommittedCopyRemovalAuthorizer(input: Readonly<{
  serverId: string;
}>): (actionReceiptId: string, rawActionInput: unknown) => Promise<void> {
  return async (_actionReceiptId, rawActionInput) => {
    const parsed = ProjectWorkerCopyRetireInputV1Schema.safeParse(rawActionInput);
    if (!parsed.success || !parsed.data.removeTargetCopy || parsed.data.workspace.serverId !== input.serverId) {
      throw compositionError('approval_stale', 'Approved committed-copy removal input is required');
    }
  };
}

function controllerUnavailable(cause?: unknown): Error {
  return Object.assign(new Error('Workspace sync controller machine is unavailable', { cause }), {
    code: 'controller_unavailable',
  });
}

function parseControllerStatusResponse(value: unknown): WorkspaceSyncStatusV1 {
  readMachineActionRpcResult(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('status' in value)) {
    throw controllerUnavailable();
  }
  const status = (value as { status: unknown }).status;
  const parsed = WorkspaceSyncStatusV1Schema.safeParse(status);
  if (!parsed.success) throw controllerUnavailable(parsed.error);
  return parsed.data;
}

function resolveRelationship(
  snapshot: Pick<ActiveProjectAccountRowsSnapshot, 'relationships'> | null,
  relationshipId: string,
): WorkspaceSyncRelationshipV1 {
  const matches = (snapshot?.relationships ?? []).filter((candidate) => (
    candidate.relationshipId === relationshipId && candidate.enabled
  ));
  if (matches.length !== 1) {
    throw compositionError('relationship_not_ready', 'Workspace sync relationship is not ready');
  }
  return matches[0]!;
}

function resolveRelationshipBootstrapTarget(
  snapshot: Pick<ActiveProjectAccountRowsSnapshot, 'workspaceRefs'> | null,
  relationship: WorkspaceSyncRelationshipV1,
  serverId: string,
): Readonly<{ workspaceRefId: string; machineId: string; rootPath: string; endpointRole: 'alpha' | 'beta'; targetManaged?: Pick<ManagedWorkspaceRefV2, 'managedId' | 'controller'> }> {
  const refs = snapshot?.workspaceRefs ?? [];
  const alpha = resolveWorkspaceRefById(refs, relationship.alphaWorkspaceRefId, serverId);
  const beta = resolveWorkspaceRefById(refs, relationship.betaWorkspaceRefId, serverId);
  if (!alpha || !beta) {
    throw compositionError('peer_unavailable', 'Workspace sync relationship endpoint is unavailable');
  }
  const roles = resolveWorkspaceSyncRelationshipEndpointRoles({
    mode: relationship.mode,
    controllerMachineId: relationship.controllerMachineId,
    alphaMachineId: resolveWorkspaceSyncExecutionMachineIdV1(alpha),
    betaMachineId: resolveWorkspaceSyncExecutionMachineIdV1(beta),
  });
  if (!roles) {
    throw compositionError(
      'relationship_definition_conflict',
      relationship.mode === 'keep_both_in_sync'
        ? 'Workspace sync controller does not own a relationship endpoint'
        : 'One-way workspace sync controller must own the alpha endpoint',
    );
  }
  const target = roles.targetEndpointRole === 'alpha' ? alpha : beta;
  return { workspaceRefId: target.id, machineId: resolveWorkspaceSyncExecutionMachineIdV1(target), rootPath: target.rootPath, endpointRole: roles.targetEndpointRole,
    ...(isManagedWorkspaceRefV2(target) ? { targetManaged: { managedId: target.managedId, controller: target.controller } } : {}) };
}

function resolveBootstrapPrepareRequest(
  input: Parameters<DaemonWorkspaceSyncRuntimeDependencies['bootstrap']>[0],
  snapshot: ActiveProjectAccountRowsSnapshot | null,
  serverId: string,
): WorkspaceSyncTargetBootstrapPrepareV1 & Readonly<{ targetMachineId: string; signal?: AbortSignal }> {
  if (input.action.kind === 'none') {
    throw compositionError('workspace_sync_unavailable', 'Workspace sync bootstrap is not required for a none action');
  }
  if (input.action.kind === 'copy_once') {
    if (!input.sourceWorkspaceRefId || !input.targetWorkspaceRefId) {
      throw compositionError('workspace_ref_not_ready', 'Workspace sync copy endpoints were not materialized');
    }
    return {
      v: 1,
      bootstrapOperationId: input.operationId,
      owner: {
        kind: 'copy_once',
        operation: {
          v: 1,
          operationId: input.operationId,
          controllerMachineId: input.sourceMachineId,
          alphaWorkspaceRefId: input.sourceWorkspaceRefId,
          betaWorkspaceRefId: input.targetWorkspaceRefId,
          contentPolicy: input.action.contentPolicy,
          ...(input.action.exclusionCandidates ? { exclusionCandidates: input.action.exclusionCandidates } : {}),
        },
      },
      targetWorkspaceRefId: input.targetWorkspaceRefId,
      targetMachineId: input.targetMachineId,
      endpointRole: 'beta',
      policyDigest: input.action.contentPolicy.policyDigest,
      createIfMissing: true,
      // Outcome-only public actions do not expose bootstrap mechanics. The
      // target owner inspects the directory and requires host approval only
      // if source materialization would replace non-empty contents.
      targetBootstrap: 'materialize_from_source_workspace',
      ...(input.targetReplacementApproval
        ? {
            targetReplacementApproval: input.targetReplacementApproval,
            targetReplacementApprovalReceiptId: input.targetReplacementApprovalReceiptId,
            targetReplacementApprovalActionInput: input.targetReplacementApprovalActionInput,
          }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    };
  }

  if (input.action.kind === 'linked_workspace') {
    if (!input.sourceWorkspaceRefId || !input.targetWorkspaceRefId) {
      throw compositionError('workspace_ref_not_ready', 'Linked workspace endpoints are unavailable');
    }
    const route = resolveWorkspaceSyncTransferRoute({
      serverId,
      workspaceRefs: snapshot?.workspaceRefs ?? [],
      relationships: snapshot?.relationships ?? [],
      sourceWorkspaceRefId: input.sourceWorkspaceRefId,
      targetWorkspaceRefId: input.targetWorkspaceRefId,
    });
    if (!route.ok || route.kind === 'same_workspace') {
      throw compositionError(route.ok ? 'route_not_found' : route.code, 'Linked workspace route is unavailable');
    }
    const finalRelationship = route.relationships.at(-1)!;
    const endpointRole = finalRelationship.alphaWorkspaceRefId === input.targetWorkspaceRefId
      ? 'alpha'
      : finalRelationship.betaWorkspaceRefId === input.targetWorkspaceRefId
        ? 'beta'
        : null;
    if (!endpointRole) throw compositionError('route_not_found', 'Linked target is not on the final relationship');
    return {
      v: 1,
      bootstrapOperationId: input.operationId,
      owner: { kind: 'relationship', relationshipId: finalRelationship.relationshipId },
      targetWorkspaceRefId: input.targetWorkspaceRefId,
      targetMachineId: input.targetMachineId,
      endpointRole,
      policyDigest: finalRelationship.contentPolicy.policyDigest,
      createIfMissing: false,
      ...(input.signal ? { signal: input.signal } : {}),
    };
  }

  if (input.action.kind !== 'relationship') {
    throw compositionError('workspace_sync_unavailable', 'Workspace sync bootstrap is owned by relationship creation');
  }
  if (!input.sourceWorkspaceRefId || !input.targetWorkspaceRefId) {
    throw compositionError('workspace_ref_not_ready', 'Workspace sync relationship endpoints were not materialized');
  }
  const sourceWorkspaceRefId = input.sourceWorkspaceRefId;
  const targetWorkspaceRefId = input.targetWorkspaceRefId;

  const relationship = resolveRelationship(snapshot, input.action.relationshipId);
  const endpointRole = relationship.alphaWorkspaceRefId === targetWorkspaceRefId
    && relationship.betaWorkspaceRefId === sourceWorkspaceRefId
    ? 'alpha'
    : relationship.betaWorkspaceRefId === targetWorkspaceRefId
      && relationship.alphaWorkspaceRefId === sourceWorkspaceRefId
      ? 'beta'
      : null;
  if (!endpointRole) {
    throw compositionError('relationship_not_ready', 'Workspace sync handoff endpoints do not match the relationship');
  }
  return {
    v: 1,
    bootstrapOperationId: input.operationId,
    owner: { kind: 'relationship', relationshipId: relationship.relationshipId },
    targetWorkspaceRefId,
    targetMachineId: input.targetMachineId,
    endpointRole,
    policyDigest: relationship.contentPolicy.policyDigest,
    createIfMissing: true,
    ...(input.signal ? { signal: input.signal } : {}),
  };
}

/** A preview retains its admitted requester and the installed Machine custodian. */
export async function assertCurrentWorkspaceCopyPreview(input: Readonly<{
  request: WorkspaceSyncCommittedCopyPreviewV1;
  context?: RpcHandlerContext;
  serverId: string;
  machineId: string;
  credentials: StoredCredentials;
  requesterAccountId?: string;
  isCurrent?: () => Promise<boolean>;
}>): Promise<void> {
  if (!input.isCurrent) {
    throw new RpcError('Owned-copy preview credential lifetime is unavailable', 'workspace_copy_preview_unavailable');
  }
  const context = input.context;
  const admission = context?.machineAdmission;
  const accountId = readAccountIdFromToken(input.credentials.token);
  const refusal = !context || !admission || !accountId ? 'admission_unavailable'
    : context.signal.aborted ? 'cancelled'
    : input.request.workspace.serverId !== input.serverId ? 'home_mismatch'
    : (input.machineId !== input.request.machineId && input.machineId !== input.request.targetMachineId)
      || admission.machineId !== input.machineId ? 'machine_mismatch'
    : admission.role !== 'manage' ? 'manage_required'
    : admission.actorAccountId !== (input.requesterAccountId ?? accountId) ? 'requester_mismatch'
    : admission.custodianAccountId !== accountId ? 'custodian_mismatch'
    : !context.verifyMachineAdmissionCurrent ? 'admission_verifier_unavailable'
    : !await input.isCurrent() ? 'credential_expired'
    : !await context.verifyMachineAdmissionCurrent() ? 'admission_expired'
    : !await input.isCurrent() ? 'credential_expired'
    : context.signal.aborted ? 'cancelled' : null;
  if (refusal) {
    throw new RpcError(`Owned-copy preview admission refused: ${refusal}`, 'forbidden');
  }
}

/**
 * The production composition boundary for Lane 08. It constructs one root
 * owner, target authority, broker/manager lifecycle, controller, and handoff
 * adapter for the registered daemon machine. Predecessor files remain untouched
 * and are never part of startup or sync admission. Engine startup is best-effort: the
 * same runtime remains installed so a later command or settings update can
 * retry after an artifact or process failure.
 */
export async function createProductionDaemonWorkspaceSyncRuntime(
  input: Readonly<{
    happyHomeDir: string;
    activeServerDir: string;
    activeServerId?: string;
    /** Captured admitted Home identity; the profile remains local credential/state addressing. */
    homeTarget?: ResolvedHomeTarget;
    localMachineId: string;
    releaseChannel: PublicReleaseRingId;
    credentials: StoredCredentials;
    /** The same exact Home credential lifetime consumed by finite execution. */
    isCurrent?: () => Promise<boolean>;
    /** Exact current requester Project ports; never the installed Account's fallback. */
    resolveProjectRuntime?: (context: RpcHandlerContext) => Promise<import('@/workspaces/projectSetup/projectFiniteAction').ProjectFiniteActionRuntime | null>;
    /** Actual target-child socket, preserving the original Home-admitted requester. */
    callWorkspaceTargetPhase?: (descriptor: WorkspaceSyncTargetPhaseDescriptor, context: RpcHandlerContext) => Promise<unknown>;
    /** The installed worker forwards its original root through the incumbent signed SOURCE transport. */
    callWorkspacePrepareBetween?: (descriptor: Readonly<{ machineId: string; sourceWorkspace: WorkspaceRefV1;
      request: WorkspaceSyncPrepareBetweenRequestV1; signal?: AbortSignal }>, context: RpcHandlerContext) => Promise<unknown>;
    callWorkspaceProjectSource?(request: Readonly<{ machineId: string; operationId: string; sourceWorkspace: WorkspaceRefV1;
      request: OpenProjectInputV1; credentials: StoredCredentials }>, context: RpcHandlerContext): Promise<ProjectOpenSyncMaterializationResultV1>;
    /** Current installed physical TARGET socket, never the borrower's Parent Account transport. */
    callWorkspaceSeedExport?: (descriptor: Readonly<{ machineId: string;
      request: import('@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas').WorkspaceSyncSeedExportPrepareV1;
      signal?: AbortSignal }>, context: RpcHandlerContext) => Promise<unknown>;
    /** The actual installed target admission owner, never a count-derived projection. */
    readProjectWorkerDependencies?: (workspaceRefId: string, relationshipId?: string) => readonly ProjectWorkerDependencyV1[];
    openMachineCarrierTunnel?: WorkspaceSyncMachineTunnelOpen;
    createRequesterMachineCarrierTunnel?: (request: Readonly<{ credentials: StoredCredentials; accountId: string }>) => WorkspaceSyncMachineTunnelOpen | undefined;
    privateCheckout?: PrivateProjectCheckoutOpenRuntime;
    openManagedWorkspaceTarget?(request: Readonly<{ workspace: ManagedWorkspaceRefV2; relationshipId: string;
      requesterAccountId: string; lifetime: AbortSignal }>): Promise<ManagedWorkspaceSyncTarget>;
    agentIsolation?: HostAgentIsolationLaunchContext;
    requesterMachineAdmissionBoundary?: RequesterSessionMachineAdmissionBoundary;
    requestDirectTransferPayloadFile?: (input: Readonly<{
      transferId: string;
      endpointCandidates: readonly TransferEndpointCandidate[];
      destinationPath: string;
      expectedSizeBytes?: number;
      expectedManifestHash?: string;
      fetchFn?: typeof fetch;
      signal?: AbortSignal;
    }>) => Promise<unknown>;
    onReadinessPublished?: (readiness: WorkspaceSyncRuntimeReadinessV1) => void;
    onStatusPublished?: (status: WorkspaceSyncStatusV1) => void;
  }>,
  overrides: Partial<ProductionDaemonWorkspaceSyncFactories> = {},
): Promise<ProductionDaemonWorkspaceSyncRuntime> {
  const semanticServerId = input.homeTarget?.homeServerIdentityId ?? input.activeServerId ?? configuration.activeServerId;
  const localProfileId = input.activeServerId ?? configuration.activeServerId;
  const readServerHttpBaseUrl = captureServerHttpBaseUrl();
  const factories: ProductionDaemonWorkspaceSyncFactories = { ...defaultFactories, ...overrides };
  // Installed publication and reconciliation share the daemon's local profile
  // scope. WorkspaceRef identities inside that snapshot retain the portable Home.
  const refreshInstalledProjectRows = async (signal?: AbortSignal) => await factories.refreshProjectRows({
    credentials: input.credentials, serverId: localProfileId, publication: 'installed',
    selection: { kinds: ['workspace-ref', 'relationship-graph'] },
    ...(signal ? { signal } : {}),
  });
  const refreshPrivateRows = async (capture: WorkspaceSyncPrivateExecution, signal?: AbortSignal) => {
    const snapshot = await factories.refreshProjectRows({ credentials: capture.credentials,
      sessionCustody: capture.accountRowsCustody, serverId: semanticServerId,
      selection: { kinds: ['workspace-ref', 'relationship-graph'] }, ...(signal ? { signal } : {}) });
    await capture.replaceSnapshot?.(snapshot);
    return capture.getSnapshot?.() ?? snapshot;
  };
  const daemonDataRoot = join(input.happyHomeDir, 'daemon');
  const workspaceSyncRoot = join(daemonDataRoot, 'workspace-sync');
  const daemonRootOwnershipManager = factories.createRootOwnershipManager({
    lockDirectory: factories.resolveRootOwnershipDirectory(),
  });
  let runtime: ReturnType<typeof createDaemonWorkspaceSyncRuntime> | null = null;
  const requesterOwnsPrivateExecution = (execution: WorkspaceSyncPrivateExecution, context?: RpcHandlerContext) =>
    Boolean(context?.machineAdmission?.actorAccountId
      && execution.accountRowsCustody.accountId === context.machineAdmission.actorAccountId
      && execution.accountRowsCustody.serverId === semanticServerId);
  const readRequesterPrivateExecution = (relationshipId: string, context?: RpcHandlerContext) => {
    const retained = runtime?.handoffAdapter.resolvePrivateExecution?.({ relationshipId });
    return retained && requesterOwnsPrivateExecution(retained.execution, context) ? retained : null;
  };
  const resolveManagedTargetCapture = async (target: ManagedWorkspaceRefV2, context?: RpcHandlerContext) => {
    await privateRecovery;
    const accountId = context?.machineAdmission?.actorAccountId;
    const retained = runtime?.handoffAdapter.listPrivateExecutions?.().find(candidate => {
      const workspace = candidate.execution.managedTarget?.workspace;
      return workspace && (!accountId || candidate.execution.accountRowsCustody.accountId === accountId)
        && candidate.execution.accountRowsCustody.serverId === semanticServerId
        && resolveWorkspaceRefV1([workspace], workspaceAddressFromRefV2(target)).kind === 'resolved';
    });
    if (!retained?.execution.managedTarget) {
      throw compositionError('relationship_not_ready', 'The admitted managed Sync target is unavailable');
    }
    if (context) retained.execution.bindTargetPhaseContext?.(context);
    return retained;
  };
  const admitPrivateTransfer = async (operationId: string, signal?: AbortSignal) => {
    await privateRecovery;
    const retained = runtime?.handoffAdapter.resolvePrivateExecution?.({ operationId })
      ?? runtime?.handoffAdapter.resolvePrivateExecution?.({ relationshipId: operationId });
    // The containing Open already admitted its finite work. Committed captures
    // acquire fresh authority at the next transfer or independent reconnect.
    if (!retained || retained.phase === 'open') return;
    await retained.execution.assertTransferCurrent();
    await refreshPrivateRows(retained.execution, signal);
  };
  const privateNativeForRoot = async (rootPath: string) => {
    const managedSource = runtime?.handoffAdapter.listPrivateExecutions?.().find(capture => capture.execution.managedTarget
      && capture.input.sourceRootPath === rootPath && capture.execution.executionIdentity?.kind === 'isolated');
    if (managedSource) {
      await managedSource.execution.managedTarget!.open();
      if (!managedSource.execution.sourceNativeSync) throw compositionError('agent_isolation_unavailable', 'The captured native Sync source is unavailable');
      return managedSource.execution.sourceNativeSync;
    }
    const retained = runtime?.handoffAdapter.listPrivateExecutions?.().find(capture => (
      !capture.execution.managedTarget && (capture.execution.nativeSync || capture.execution.executionIdentity?.kind === 'isolated')
      && (capture.input.sourceMachineId === input.localMachineId && capture.input.sourceRootPath === rootPath
        || capture.input.targetMachineId === input.localMachineId && capture.input.targetRootPath === rootPath)
    ));
    if (retained && !retained.execution.nativeSync) throw compositionError('agent_isolation_unavailable', 'The captured native Sync member is unavailable');
    return retained?.execution.nativeSync;
  };
  const rootOwnershipManager: ReturnType<typeof createWorkspaceRootOwnershipManager> = {
    tryAcquire: async request => {
      const native = await privateNativeForRoot(request.canonicalRoot);
      const acquired = await (native ? native.acquireLocalRoot(request) : daemonRootOwnershipManager.tryAcquire(request));
      if ('kind' in acquired) return acquired;
      const capture = request.operation === 'handoff' ? runtime?.handoffAdapter.listPrivateExecutions?.().find(value =>
        value.input.sourceRootPath === request.canonicalRoot && value.execution.onSourceRootReleased) : undefined;
      if (!capture?.execution.onSourceRootReleased) return acquired;
      return { ...acquired, release: async () => {
        await acquired.release();
        await capture.execution.onSourceRootReleased!();
      } };
    },
  };
  const recoverPrivateExecutions = async (relationshipId?: string) => {
    if (!runtime || !input.requesterMachineAdmissionBoundary) return false;
    return recoverPrivateWorkspaceSyncExecutions({ happyHomeDir: input.happyHomeDir, localProfileId,
      serverId: semanticServerId, serverHttpBaseUrl: readServerHttpBaseUrl(),
      boundary: input.requesterMachineAdmissionBoundary, privateCheckout: input.privateCheckout,
      adapter: runtime.handoffAdapter, readProjectRows: factories.refreshProjectRows,
      ...(input.openManagedWorkspaceTarget ? { recoverManagedExecution: async recovered => {
        const retained = retainManagedExecution({ operationId: recovered.relationship.relationshipId, ...recovered });
        return retained.execution;
      } } : {}),
      ...(relationshipId ? { relationshipId } : {}) });
  };
  const carrierReadiness: WorkspaceSyncRuntimeReadinessV1['carrier'] = input.openMachineCarrierTunnel
    ? { state: 'ready' }
    : { state: 'unavailable', errorCode: 'machine_carrier_unavailable' };
  let engineReadiness: WorkspaceSyncRuntimeReadinessV1['engine'] = { state: 'starting' };
  const publishReadiness = (next: WorkspaceSyncRuntimeReadinessV1['engine']): void => {
    if (engineReadiness.state === next.state
      && (next.state !== 'unavailable'
        || (engineReadiness.state === 'unavailable' && engineReadiness.errorCode === next.errorCode))) return;
    engineReadiness = next;
    input.onReadinessPublished?.({ engine: next, carrier: carrierReadiness });
  };
  input.onReadinessPublished?.({ engine: engineReadiness, carrier: carrierReadiness });
  let relationshipOwner: WorkspaceSyncRelationshipOwner | null = null;
  const installation = readInstallationIdentityIfExistsSync();
  const installedAccountId = readAccountIdFromToken(input.credentials.token);
  const selectRequesterIdentity = (context: RpcHandlerContext) => selectHostRequesterExecutionIdentity({
      actionContext: buildActionExecutorContextForRpc(context), hostHomeServerIdentityId: semanticServerId,
      hostCustodianAccountId: installedAccountId,
      ...(installation ? { hostExecutionTarget: { machineId: input.localMachineId,
        installationId: installation.installationId } } : {}),
      ...(context.workspaceSyncSourceRouting?.sourceContext ? {
        verifiedReceivingChild: context.workspaceSyncSourceRouting.sourceContext.machineAdmission,
      } : {}),
    });
  const canUseInstalledRelationshipOwner = (context?: RpcHandlerContext) => {
    if (!context) return true;
    const identity = selectRequesterIdentity(context);
    return identity.kind !== 'unknown' && identity.requester.accountId === installedAccountId
      && isHostRequesterUnrestrictedOwner(identity);
  };
  const assertInstalledRelationshipOwner = (context?: RpcHandlerContext) => {
    if (!canUseInstalledRelationshipOwner(context)) {
      throw compositionError('agent_isolation_unavailable', 'Workspace Sync requires requester-private execution');
    }
  };
  const assertConflictResolutionAuthorized = createWorkspaceSyncConflictResolutionAuthorizer();
  const assertTargetReplacementAuthorized = createWorkspaceDestinationApprovalAuthorizer();
  const assertCommittedCopyRemovalAuthorized = createWorkspaceCommittedCopyRemovalAuthorizer({
    serverId: semanticServerId,
  });
  const targetAuthorityDependencies: Parameters<typeof createWorkspaceSyncTargetAuthority>[0] = {
    localServerId: semanticServerId,
    localMachineId: input.localMachineId,
    localAccountId: readAccountIdFromToken(input.credentials.token) ?? undefined,
    ...(input.resolveProjectRuntime ? { resolveProjectRuntime: input.resolveProjectRuntime } : {}),
    getProjectSnapshot: operationId => {
      const retained = operationId ? runtime?.handoffAdapter.resolvePrivateExecution?.({ operationId })
        ?? runtime?.handoffAdapter.resolvePrivateExecution?.({ relationshipId: operationId }) : null;
      return retained ? retained.execution.getSnapshot?.() ?? null : factories.getProjectSnapshot();
    },
    resolveNativeTargetExecution: async (target, context) => {
      const retained = await resolveManagedTargetCapture(target, context);
      return (await retained.execution.managedTarget!.open()).native;
    },
    openNativeRootedAgent: async request => {
      const retained = await resolveManagedTargetCapture(request.target);
      const { target, native, signal } = await retained.execution.managedTarget!.open();
      const stream = target.openChannel([native.agentExecutablePath, 'synchronizer', '--external', '--root', request.canonicalRoot],
        request.signal ? AbortSignal.any([signal, request.signal]) : signal);
      return { stream, stop: async () => { stream.destroy(); await finished(stream).catch(() => undefined); } };
    },
    ...(input.callWorkspaceTargetPhase ? { callWorkspaceTargetPhase: input.callWorkspaceTargetPhase } : {}),
    refreshProjectSnapshot: async (signal, context, relationshipId) => {
      const retained = relationshipId ? readRequesterPrivateExecution(relationshipId, context) : null;
      if (retained) return await refreshPrivateRows(retained.execution, signal);
      return context?.callerInputAuthorization ? await factories.refreshProjectRows({
      authorization: context.callerInputAuthorization,
      effectActionId: context.callerInputAuthorization.binding.actionId,
      serverId: semanticServerId,
      selection: { kinds: ['workspace-ref', 'relationship-graph'] },
      ...(signal ? { signal } : {}),
      }) : await refreshInstalledProjectRows(signal);
    },
    readChildMachineFacts: async (machineIds, signal, context) => await readWorkspaceSyncChildMachineFacts({
      serverId: semanticServerId,
      serverHttpBaseUrl: readServerHttpBaseUrl(), localProfileId, ...(input.homeTarget ? { homeTarget: input.homeTarget } : {}),
      credentials: input.credentials, machineIds, signal,
      ...(context?.workspaceSyncTargetRouting && context.machineAdmission && context.verifyMachineAdmissionCurrent
        && context.machineAdmission.machineId !== input.localMachineId ? { controllerOwnedChild: {
          controllerMachineId: input.localMachineId, admission: context.machineAdmission,
          verifyCurrent: context.verifyMachineAdmissionCurrent } } : {}),
    }),
    assertConflictResolutionAuthorized,
    assertTargetReplacementAuthorized,
    assertCommittedCopyRemovalAuthorized,
    readCommittedCopyDependencies: async (actionInput) => {
      if (!actionInput.removeTargetCopy || !input.readProjectWorkerDependencies) {
        throw compositionError('workspace_sync_dependencies_unavailable', 'Worker dependency owner is unavailable');
      }
      return input.readProjectWorkerDependencies(actionInput.removeTargetCopy.workspaceRefId);
    },
    prepareSourceSeedExport: async ({ operationId, sourceWorkspaceRefId, targetMachineId, contentPolicy, exclusionCandidates }) => {
      if (!runtime) {
        throw compositionError('workspace_sync_unavailable', 'Workspace sync runtime is unavailable');
      }
      return await runtime.managedWorkspaceSync.withAuthorizedSourceSeedExport({
        operationId,
        sourceWorkspaceRefId,
        targetMachineId,
        contentPolicy,
      }, async (sourcePath) => {
        // A member's own folder is read only by that member's Sync process: the daemon serves
        // the seed it built and forwards blob reads, never opening a path there itself.
        const member = await privateNativeForRoot(sourcePath);
        if (member) {
          return createMemberWorkspaceSyncSeedExport({ operationId,
            envelope: await member.prepareSourceSeedExport({ operationId, sourcePath, contentPolicy, ...(exclusionCandidates ? { exclusionCandidates } : {}) }),
            readBlob: request => member.readSourceSeedBlob({ operationId, ...request }) });
        }
        return await factories.prepareSourceSeedExport({
          operationId,
          activeServerDir: input.activeServerDir,
          sourcePath,
          workspaceTransfer: resolveSeedWorkspaceTransfer(contentPolicy, exclusionCandidates),
        });
      });
    },
    resolutionMaterialDirectory: join(input.activeServerDir, 'workspace-sync', 'resolution'),
    resolveLocalResolutionEndpoint: async (relationshipId, workspaceRefId) => await runtime?.managedWorkspaceSync.resolveLocalResolutionEndpoint(
      relationshipId, workspaceRefId,
    ) ?? null,
    requestResolutionExport: async (request) => {
      const execution = runtime?.handoffAdapter.resolvePrivateExecution?.({ relationshipId: request.relationshipId })?.execution;
      const credentials = execution?.credentials ?? input.credentials;
      const openCarrier = execution && execution.accountRowsCustody.accountId !== installedAccountId
        ? input.createRequesterMachineCarrierTunnel?.({ credentials, accountId: execution.accountRowsCustody.accountId })
        : input.openMachineCarrierTunnel;
      if (!input.requestDirectTransferPayloadFile) {
        throw compositionError('agent_unavailable', 'Reviewed workspace conflict transfer is unavailable');
      }
      if (request.sourceMachineId !== input.localMachineId && !openCarrier) {
        throw compositionError('machine_carrier_unavailable', 'Reviewed workspace conflict source Machine carrier is unavailable');
      }
      const { signal: exportSignal, ...wireRequest } = request;
      const preparedRaw = await factories.callMachineRpc({
        credentials,
        machineId: request.sourceMachineId,
        method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
        request: { t: 'workspace_sync_resolution_v1', ...wireRequest },
        timeoutMs: null,
        ...(exportSignal ? { signal: exportSignal } : {}),
      });
      if (!preparedRaw || typeof preparedRaw !== 'object' || (preparedRaw as { success?: unknown }).success !== true) {
        const code = preparedRaw && typeof preparedRaw === 'object' && 'code' in preparedRaw
          ? (preparedRaw as { code?: unknown }).code
          : null;
        throw compositionError(code === 'conflict_changed' || code === 'approval_stale' || code === 'approval_required'
          ? code : 'peer_unavailable', 'Reviewed workspace conflict source is unavailable');
      }
      const prepared = preparedRaw as Readonly<Record<string, unknown>>;
      if (prepared.transferId !== request.operationId
        || typeof prepared.sizeBytes !== 'number' || !Number.isSafeInteger(prepared.sizeBytes) || prepared.sizeBytes < 0
        || typeof prepared.manifestHash !== 'string' || !Array.isArray(prepared.endpointCandidates)) {
        throw compositionError('peer_unavailable', 'Reviewed workspace conflict export is invalid');
      }
      const sourceCandidates = prepared.endpointCandidates.map((candidate) => TransferEndpointCandidateSchema.parse(candidate));
      const sourceCandidate = sourceCandidates[0];
      if (!sourceCandidate) throw compositionError('peer_unavailable', 'Reviewed workspace conflict export has no finite transfer endpoint');
      return {
        requestPayload: async ({ transferId, destinationPath, expectedSizeBytes, expectedManifestHash }) => {
          const tunnel = request.sourceMachineId === input.localMachineId
            ? null
            : await openCarrier!({
              sourceMachineId: input.localMachineId,
              targetMachineId: request.sourceMachineId,
              flow: 'file_transfer',
              ...(exportSignal ? { signal: exportSignal } : {}),
            });
          try {
            const url = new URL(sourceCandidate.url);
            url.protocol = 'http:';
            url.hostname = '127.0.0.1';
            if (tunnel) url.port = String(tunnel.localPort);
            url.pathname = buildDirectPeerTransferEndpointPath(transferId);
            await input.requestDirectTransferPayloadFile!({
              transferId,
              endpointCandidates: [{ ...sourceCandidate, kind: 'http' as const, url: url.toString() }],
              destinationPath,
              ...(transferId === request.operationId
                ? { expectedSizeBytes: prepared.sizeBytes as number, expectedManifestHash: prepared.manifestHash as string }
                : {
                  ...(expectedSizeBytes === undefined ? {} : { expectedSizeBytes }),
                  ...(expectedManifestHash === undefined ? {} : { expectedManifestHash }),
                }),
              ...(exportSignal ? { signal: exportSignal } : {}),
            });
          } finally {
            await tunnel?.close();
          }
        },
        release: async () => {
          await factories.callMachineRpc({
            credentials,
            machineId: request.sourceMachineId,
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE,
            timeoutMs: null,
            request: { transferId: request.operationId },
          });
        },
      };
    },
    bootstrap: {
      materializationDirectory: join(input.activeServerDir, 'workspace-sync', 'materialization'),
      rootOwnershipManager,
      prepareGitTarget: factories.prepareGitTarget,
      materializeLocalSeed: async ({ operationId, sourcePath, canonicalRoot, contentPolicy, exclusionCandidates, materializationReceiptPath, originalTargetExists, targetFence }) => await factories.materializeLocalSeed({
        operationId,
        activeServerDir: input.activeServerDir,
        sourcePath,
        targetPath: canonicalRoot,
        materializationReceiptPath,
        originalTargetExists,
        targetFence,
        workspaceTransfer: resolveSeedWorkspaceTransfer(contentPolicy, exclusionCandidates),
      }),
      ...(input.openMachineCarrierTunnel && input.requestDirectTransferPayloadFile
        ? { materializeRemoteSeed: async (request) => {
            const seedRequest = {
              t: 'workspace_sync_seed_v1' as const,
              operationId: request.operationId,
              sourceWorkspaceRefId: request.sourceWorkspaceRefId,
              targetMachineId: input.localMachineId,
              contentPolicy: request.contentPolicy,
              ...(request.exclusionCandidates ? { exclusionCandidates: request.exclusionCandidates } : {}),
            };
            const seedActionId = request.context?.callerInputAuthorization?.binding.actionId;
            const seedContext = (seedActionId === 'projects.open' || isWorkspaceSyncRelationshipWriteActionId(seedActionId ?? ''))
              && request.context?.workspaceSyncSourceWriterTargetRouting !== undefined ? request.context : undefined;
            const prepare = seedContext
              ? input.callWorkspaceSeedExport
                ? input.callWorkspaceSeedExport({ machineId: request.sourceMachineId, request: seedRequest,
                    ...(request.signal ? { signal: request.signal } : {}) }, seedContext)
                : Promise.reject(compositionError('workspace_sync_update_required', 'The installed SOURCE seed transport is unavailable'))
              : factories.callMachineRpc({
                credentials: input.credentials,
                machineId: request.sourceMachineId,
                method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
                request: seedRequest,
                timeoutMs: null,
                ...(request.signal ? { signal: request.signal } : {}),
              });
            const preparedRaw = await prepare;
            assertWorkspaceSyncSeedExportSucceeded(preparedRaw);
            if (!preparedRaw || typeof preparedRaw !== 'object' || (preparedRaw as { success?: unknown }).success !== true) {
              throw compositionError('target_bootstrap_offline', 'Workspace sync source seed is unavailable');
            }
            const prepared = preparedRaw as Readonly<Record<string, unknown>>;
            if (typeof prepared.transferId !== 'string' || prepared.transferId !== request.operationId
              || typeof prepared.sizeBytes !== 'number' || !Number.isSafeInteger(prepared.sizeBytes) || prepared.sizeBytes < 1
              || typeof prepared.manifestHash !== 'string' || !Array.isArray(prepared.endpointCandidates)) {
              throw compositionError('target_bootstrap_offline', 'Workspace sync source seed response is invalid');
            }
            const sourceCandidates = prepared.endpointCandidates.map((candidate) => TransferEndpointCandidateSchema.parse(candidate));
            const sourceCandidate = sourceCandidates[0];
            if (!sourceCandidate) {
              throw compositionError('target_bootstrap_offline', 'Workspace sync source seed has no finite transfer endpoint');
            }
            return await factories.materializeSeedExport({
              operationId: request.operationId,
              targetPath: request.canonicalRoot,
              ...(request.signal ? { signal: request.signal } : {}),
              materializationReceiptPath: request.materializationReceiptPath,
              originalTargetExists: request.originalTargetExists,
              targetFence: request.targetFence,
              requestPayload: async ({ transferId, destinationPath, expectedSizeBytes, expectedManifestHash }) => {
                const sizeBytes = transferId === request.operationId ? prepared.sizeBytes as number : expectedSizeBytes;
                const manifestHash = transferId === request.operationId ? prepared.manifestHash as string : expectedManifestHash;
                if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !manifestHash) {
                  throw compositionError('target_bootstrap_offline', 'Workspace sync seed payload commitment is invalid');
                }
                const tunnel = await input.openMachineCarrierTunnel!({
                  sourceMachineId: input.localMachineId,
                  targetMachineId: request.sourceMachineId,
                  flow: 'file_transfer',
                  ...(request.signal ? { signal: request.signal } : {}),
                });
                try {
                  const url = new URL(sourceCandidate.url);
                  url.protocol = 'http:';
                  url.hostname = '127.0.0.1';
                  url.port = String(tunnel.localPort);
                  url.pathname = buildDirectPeerTransferEndpointPath(transferId);
                  const endpointCandidates: readonly TransferEndpointCandidate[] = [{
                    ...sourceCandidate,
                    kind: 'http' as const,
                    url: url.toString(),
                  }];
                  await input.requestDirectTransferPayloadFile!({
                    transferId,
                    endpointCandidates,
                    destinationPath,
                    expectedSizeBytes: sizeBytes,
                    expectedManifestHash: manifestHash,
                    ...(request.signal ? { signal: request.signal } : {}),
                  });
                } finally {
                  await tunnel.close();
                }
              },
              materializeWorkspaceExportArtifacts: materializeWorkspaceExportArtifactsWithScmWorkspace,
            });
          },
        }
        : {}),
    },
    openRootedAgent: async (request) => {
      if (!runtime) {
        throw compositionError('agent_unavailable', 'Workspace sync runtime is not ready to launch a rooted agent');
      }
      return await runtime.openRootedAgent(request);
    },
    callMachineRpc: async (request) => await factories.callMachineRpc({
      credentials: input.credentials,
      machineId: request.machineId,
      method: request.method,
      request: request.request,
      ...(request.operationContext ? { operationContext: request.operationContext } : {}),
      // Target phases follow Workspace Sync custody and caller cancellation.
      timeoutMs: null,
      ...(request.signal ? { signal: request.signal } : {}),
    }),
  };
  const targetAuthority = factories.createTargetAuthority(targetAuthorityDependencies);

  const managedExecution = (relationshipId: string, workspaceRefId: string) => {
    const execution = runtime?.handoffAdapter.resolvePrivateExecution?.({ relationshipId })?.execution;
    return execution?.managedTarget?.workspace.id === workspaceRefId ? execution : null;
  };
  const managedNative = async (relationshipId: string, workspaceRefId: string) => {
    const retained = runtime?.handoffAdapter.resolvePrivateExecution?.({ relationshipId });
    const execution = retained?.execution;
    if (!execution?.managedTarget) return null;
    if (execution.managedTarget.workspace.id === workspaceRefId) return (await execution.managedTarget.open()).native;
    if (retained.input.sourceWorkspaceRefId === workspaceRefId && execution.executionIdentity?.kind === 'isolated') {
      await execution.managedTarget.open();
      if (!execution.sourceNativeSync) throw compositionError('agent_isolation_unavailable', 'The captured native Sync source is unavailable');
      return execution.sourceNativeSync;
    }
    return null;
  };
  const retainManagedExecution = (request: Readonly<{
    operationId: string; source: WorkspaceRefV1; target: ManagedWorkspaceRefV2;
    snapshot: ActiveProjectAccountRowsSnapshot; credentials: StoredCredentials; custody: ProjectAccountSessionCustody;
    retainRelationship?: PrepareManagedProjectFilesSyncInput['retainRelationship'];
    releaseCustody?: PrepareManagedProjectFilesSyncInput['releaseCustody'];
    sourceExecutionIdentity?: PrepareManagedProjectFilesSyncInput['sourceExecutionIdentity'];
    assertTransferCurrent?(): Promise<void>;
    phase?: 'open' | 'relationship';
    action?: PrepareWorkspaceSyncHandoffInput['action'];
  }>) => {
    if (!runtime || !input.openManagedWorkspaceTarget) throw compositionError('workspace_sync_unavailable', 'Managed Workspace Sync transport is unavailable');
    let snapshot = request.snapshot;
    let targetPhaseContext: RpcHandlerContext | undefined;
    let native: PrivateProjectNativeSync | undefined;
    let sourceNative: Awaited<ReturnType<typeof recoverPrivateProjectSyncCheckout>> | undefined;
    let opening: Promise<Readonly<{ target: ManagedWorkspaceSyncTarget; native: PrivateProjectNativeSync; signal: AbortSignal }>> | undefined;
    let lifetime = new AbortController();
    let retired = false;
    let custodyReleased = false;
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      if (!native) lifetime.abort();
      try {
        try {
          await targetAuthority.releaseNativeTargetExecution({ target: request.target });
        } finally {
          if (native) await native.dispose();
          else await opening?.then(value => value.native.dispose(), () => undefined);
        }
      } finally {
        try { await sourceNative?.release(); } finally {
          lifetime.abort();
          native = undefined;
          sourceNative = undefined;
          opening = undefined;
          lifetime = new AbortController();
        }
      }
    })().finally(() => { closing = undefined; });
    const executionInput = { operationId: request.operationId, accountServerId: semanticServerId,
      action: request.action ?? { kind: 'relationship' as const, relationshipId: request.operationId, flushBeforeCommit: false },
      sourceMachineId: resolveWorkspaceSyncExecutionMachineIdV1(request.source), sourceWorkspaceRefId: request.source.id,
      sourceRootPath: request.source.rootPath, targetMachineId: request.target.controller.machineId,
      targetWorkspaceRefId: request.target.id, targetRootPath: request.target.rootPath };
    const capture: WorkspaceSyncPrivateExecution = {
      credentials: request.credentials, accountRowsCustody: request.custody,
      get nativeSync() { return native; },
      get sourceNativeSync() { return sourceNative?.native; },
      ...(request.sourceExecutionIdentity ? { executionIdentity: request.sourceExecutionIdentity } : {}),
      getSnapshot: () => snapshot,
      bindTargetPhaseContext: context => { targetPhaseContext = context; },
      replaceSnapshot: async next => { snapshot = next; await Promise.all([native?.replaceSnapshot(next), sourceNative?.native.replaceSnapshot(next)]); },
      assertTransferCurrent: async () => {
        if (retired) throw compositionError('relationship_not_ready', 'The managed Sync execution is retired');
        lifetime.signal.throwIfAborted();
        await request.assertTransferCurrent?.();
        if (!await request.custody.isCurrent()) throw compositionError('project_requester_authority_unavailable', 'Requester Sync custody is unavailable');
      },
      ...(request.retainRelationship ? { retainRelationship: (relationshipId: string) => request.retainRelationship!(relationshipId, request.target) } : {}),
      managedTarget: { workspace: request.target, close, open: () => opening ??= (async () => {
        await capture.assertTransferCurrent();
        const target = await input.openManagedWorkspaceTarget!({ workspace: request.target,
          relationshipId: request.operationId, requesterAccountId: request.custody.accountId, lifetime: lifetime.signal });
        const installed = await target.ensureWorkspaceRuntime();
        const root = dirname(request.target.rootPath);
        // The managed guest platform owner supports POSIX guests; argv operands
        // keep paths out of shell source, including spaces and quote characters.
        const channel = target.openChannel(['sh', '-c', 'mkdir -p -- "$1" && cd "$1" && exec "$2" workspace-effect', 'workspace-sync', root, installed.binaryPath], lifetime.signal);
        const nativeScmTarget = () => {
          if (typeof target.holderPath !== 'string' || typeof target.helperPath !== 'string') {
            throw compositionError('workspace_sync_unavailable', 'Native SCM target transport is unavailable');
          }
          return { ...target, holderPath: target.holderPath, helperPath: target.helperPath };
        };
        const network: PrivateProjectSyncNetwork = {
          inspectNativeWorkspaceLocation: async ({ signal }) =>
            runWithHolderWorkspaceSource({ target: nativeScmTarget(), rootPath: request.target.rootPath, signal: signal ?? lifetime.signal }, () =>
              inspectWorkspaceLocationWithScmWorkspace({ candidatePath: request.target.rootPath, signal: signal ?? lifetime.signal })),
          reconcileNativeWorkspaceIntegration: async ({ workspaceIntegrationMetadata, signal }) => {
            if (!workspaceIntegrationMetadata) return;
            await reconcileManagedWorkspacePostMaterialization({ target: nativeScmTarget(), targetPath: request.target.rootPath,
              workspaceIntegrationMetadata, signal: signal ?? lifetime.signal });
          },
          refreshProjectSnapshot: async signal => {
            const next = await refreshPrivateRows(capture, signal);
            return next;
          },
          callMachineRpc: async call => factories.callMachineRpc({ ...call, credentials: request.credentials, timeoutMs: null }),
          assertConflictResolutionAuthorized,
          assertTargetReplacementAuthorized,
          requestNativeResolutionExport: async resolution => {
            const exported = await targetAuthorityDependencies.requestResolutionExport!(resolution);
            const directory = await mkdtemp(join(tmpdir(), 'happier-sync-resolution-')).catch(async error => { await exported.release(); throw error; });
            let index = 0;
            return { resolvePayloadSource: async ({ transferId }) => {
              const destinationPath = join(directory, String(index++));
              await exported.requestPayload({ transferId, destinationPath });
              const source = createFileTransferPayloadSource({ filePath: destinationPath });
              return { sizeBytes: await resolveTransferPayloadSizeBytes(source), manifestHash: await resolveTransferPayloadManifestHash(source),
                readChunk: async range => readTransferPayloadChunk({ source, ...range }) };
            }, release: async () => { try { await exported.release(); } finally { await rm(directory, { recursive: true, force: true }); } } };
          },
          prepareSourceSeed: async seed => {
            const openCarrier = request.custody.accountId === installedAccountId ? input.openMachineCarrierTunnel
              : input.createRequesterMachineCarrierTunnel?.({ credentials: request.credentials, accountId: request.custody.accountId });
            if (!input.requestDirectTransferPayloadFile) throw compositionError('target_bootstrap_offline', 'Managed source transfer is unavailable');
            const prepared = await createPrivateWorkspaceSyncSourceSeedPreparation({ targetMachineId: request.target.controller.machineId,
              credentials: request.credentials, getTargetPhaseContext: () => targetPhaseContext }, {
              callMachineRpc: factories.callMachineRpc,
              ...(openCarrier ? { openMachineCarrierTunnel: openCarrier } : {}),
              ...(input.callWorkspaceSeedExport ? { callWorkspaceSeedExport: input.callWorkspaceSeedExport } : {}),
            })(seed);
            const directory = await mkdtemp(join(tmpdir(), 'happier-sync-seed-')).catch(async error => { await prepared.dispose(); throw error; });
            let index = 0;
            return { ...prepared, resolvePayloadSource: async ({ transferId }: Readonly<{ transferId: string }>) => {
              const destinationPath = join(directory, String(index++));
              const payload = await prepared.openPayload({ transferId, ...(seed.signal ? { signal: seed.signal } : {}) });
              try {
                await input.requestDirectTransferPayloadFile!({ transferId, destinationPath, endpointCandidates: payload.endpointCandidates,
                  ...(transferId === prepared.transferId ? { expectedSizeBytes: prepared.sizeBytes, expectedManifestHash: prepared.manifestHash } : {}),
                  ...(seed.signal ? { signal: seed.signal } : {}) });
              } finally { await payload.dispose(); }
              const source = createFileTransferPayloadSource({ filePath: destinationPath });
              return { sizeBytes: await resolveTransferPayloadSizeBytes(source), manifestHash: await resolveTransferPayloadManifestHash(source),
                readChunk: async (range: Readonly<{ offset: number; length: number }>) => readTransferPayloadChunk({ source, ...range }) };
            }, dispose: async () => { try { await prepared.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } } };
          },
        };
        if (request.sourceExecutionIdentity?.kind === 'isolated') {
          if (!input.privateCheckout) throw compositionError('agent_isolation_unavailable', 'Requester Sync source execution is unavailable');
          const relationshipId = runtime!.handoffAdapter.resolvePrivateExecution?.({ operationId: request.operationId })?.relationshipId ?? request.operationId;
          const prepared = await preparePrivateProjectOpenCheckout({ runtime: input.privateCheckout,
            requesterIdentity: request.sourceExecutionIdentity, workspaceRefs: snapshot.workspaceRefs,
            existingWorkspaceRefId: request.source.id, materializationKey: relationshipId, signal: lifetime.signal,
            request: { serverId: semanticServerId, machineId: input.localMachineId,
              source: { kind: 'workspace', workspaceId: request.target.id },
              materialization: { kind: 'sync', targetPath: request.source.rootPath,
                workspaceAction: request.action?.kind === 'copy_once' ? request.action
                  : { kind: 'relationship', relationshipId, flushBeforeCommit: false } } }, onEffectsIssued() {} });
          try {
            sourceNative = { native: await prepared.startSync({ serverId: semanticServerId,
              machineId: input.localMachineId, accountId: request.custody.accountId,
              snapshot, agent: await runtime!.resolveNativeAgent() }, network), release: prepared.release };
          } catch (error) { await prepared.release(); throw error; }
        }
        native = await factories.startManagedSyncChannel({ channel, signal: lifetime.signal, memberHome: target.home,
          effect: { request: { serverId: semanticServerId, machineId: input.localMachineId, source: { kind: 'workspace', workspaceId: request.source.id },
            materialization: { kind: 'sync', targetPath: request.target.rootPath,
              workspaceAction: { kind: 'relationship', relationshipId: request.operationId, flushBeforeCommit: false } } },
            workspaceRefId: request.target.id, workspaceRoot: root, existingRootPath: request.target.rootPath,
            generation: 0, plugins: [], contributions: {} },
          configuration: { serverId: semanticServerId, machineId: input.localMachineId, accountId: request.custody.accountId,
            snapshot, localManagedTarget: { managedId: request.target.managedId, controller: request.target.controller },
            agent: { releaseChannel: input.releaseChannel } }, network, onEffectsIssued() {} });
        return { target, native, signal: lifetime.signal };
      })().catch(async error => {
        lifetime.abort();
        try { await sourceNative?.release(); } finally {
          sourceNative = undefined; native = undefined; opening = undefined; lifetime = new AbortController();
        }
        throw error;
      }) },
      release: async () => {
        retired = true;
        try { await close(); } finally {
          lifetime.abort();
          if (!custodyReleased) { custodyReleased = true; await request.releaseCustody?.(); }
        }
      },
    };
    runtime.handoffAdapter.retainPrivateExecution?.({ input: executionInput, execution: capture, phase: request.phase ?? 'relationship' });
    return runtime.handoffAdapter.resolvePrivateExecution!({ operationId: request.operationId })!;
  };
  const recoverManagedRelationships = async (snapshot: ActiveProjectAccountRowsSnapshot) => {
    if (!input.openManagedWorkspaceTarget || !installedAccountId || !runtime) return;
    for (const retained of runtime.handoffAdapter.listPrivateExecutions?.() ?? []) {
      if (!retained.execution.managedTarget || retained.phase !== 'relationship'
        || retained.execution.accountRowsCustody.accountId !== installedAccountId) continue;
      const relationship = snapshot.relationships.find(value => value.relationshipId === retained.relationshipId);
      if (!relationship?.enabled) {
        await runtime.managedWorkspaceSync.terminate(retained.relationshipId ?? retained.input.operationId);
        if (!relationship) await runtime.handoffAdapter.releasePrivateExecution?.(retained.input.operationId);
        else { await retained.execution.replaceSnapshot?.(snapshot); await retained.execution.managedTarget.close(); }
      } else await retained.execution.replaceSnapshot?.(snapshot);
    }
    for (const relationship of snapshot.relationships) {
      if (!relationship.enabled
        || runtime.handoffAdapter.resolvePrivateExecution?.({ relationshipId: relationship.relationshipId })) continue;
      const alpha = resolveWorkspaceRefById(snapshot.workspaceRefs, relationship.alphaWorkspaceRefId, semanticServerId);
      const beta = resolveWorkspaceRefById(snapshot.workspaceRefs, relationship.betaWorkspaceRefId, semanticServerId);
      if (!alpha || !beta) continue;
      const roles = resolveWorkspaceSyncRelationshipEndpointRoles({ mode: relationship.mode,
        controllerMachineId: relationship.controllerMachineId, alphaMachineId: resolveWorkspaceSyncExecutionMachineIdV1(alpha),
        betaMachineId: resolveWorkspaceSyncExecutionMachineIdV1(beta) });
      if (!roles) continue;
      const target = roles.targetEndpointRole === 'alpha' ? alpha : beta;
      const source = roles.targetEndpointRole === 'alpha' ? beta : alpha;
      if (!isManagedWorkspaceRefV2(target) || target.controller.machineId !== input.localMachineId || isManagedWorkspaceRefV2(source)) continue;
      const retained = retainManagedExecution({ operationId: relationship.relationshipId, source, target, snapshot,
        credentials: input.credentials, custody: { serverId: semanticServerId, accountId: installedAccountId,
          serverHttpBaseUrl: readServerHttpBaseUrl(), isCurrent: input.isCurrent ?? (async () => true) } });
      await runtime.handoffAdapter.bindPrivateExecutionRelationship?.(retained.input.operationId, relationship.relationshipId);
    }
  };

  const readHandoffProjectSnapshot = async (signal?: AbortSignal, context?: RpcHandlerContext) => {
    const authorization = context?.callerInputAuthorization;
    if (authorization && (authorization.binding.accountId !== context?.machineAdmission?.actorAccountId
      || !authorization.binding.workspaceSyncAdmission
        && (!context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()))) {
      throw compositionError('project_requester_authority_unavailable', 'The admitted requester is no longer current');
    }
    const requester = readRequesterAccountActionContext(authorization);
    const privatePreparation = context?.workspaceSyncSourceRouting && authorization && isProjectPreparation(context);
    if (privatePreparation && !requester) {
      throw compositionError('project_requester_authority_unavailable', 'The admitted requester is no longer current');
    }
    const snapshot = privatePreparation && requester ? await factories.refreshProjectRows({ credentials: requester.credentials,
      sessionCustody: { serverId: semanticServerId, accountId: authorization.binding.accountId,
        serverHttpBaseUrl: requester.serverHttpBaseUrl, isCurrent: requester.isCurrent },
      serverId: semanticServerId, signal, selection: { kinds: ['workspace-ref', 'relationship-graph'] } })
      : authorization ? await factories.refreshProjectRows({ authorization,
      effectActionId: authorization.binding.actionId, serverId: semanticServerId, signal,
      selection: { kinds: ['workspace-ref', 'relationship-graph'] } }) : factories.getProjectSnapshot();
    if (!snapshot) throw compositionError('workspace_sync_settings_unavailable', 'Workspace sync settings are unavailable');
    return snapshot;
  };
  const readHandoffChildMachines = async (machineIds: readonly string[], signal?: AbortSignal, context?: RpcHandlerContext,
    physicalSourceAuthority?: WorkspaceSyncSourceContextV1) => {
    const authorization = context?.callerInputAuthorization;
    if (authorization && (isProjectWorkspaceSyncOpenActionV1(authorization.binding.actionId) || isProjectPreparation(context))
      && !authorization.binding.workspaceSyncAdmission) {
      throw compositionError('workspace_sync_source_admission_unavailable', 'The admitted Sync source facts are unavailable');
    }
    const requester = context?.workspaceSyncSourceRouting && isProjectPreparation(context)
      ? readRequesterAccountActionContext(authorization) : null;
    return await readWorkspaceSyncChildMachineFacts({ serverId: semanticServerId,
      ...(authorization?.binding.workspaceSyncAdmission ? { authorization, effectActionId: authorization.binding.actionId,
        purpose: 'admitted_mapping' as const, relationshipId: authorization.binding.workspaceSyncAdmission.relationshipId }
        : physicalSourceAuthority && context?.verifyMachineAdmissionCurrent ? { credentials: input.credentials,
        controllerOwnedChild: { controllerMachineId: input.localMachineId, admission: physicalSourceAuthority.machineAdmission,
          verifyCurrent: context.verifyMachineAdmissionCurrent } }
        : authorization ? { authorization, effectActionId: authorization.binding.actionId,
        purpose: 'admitted_mapping' as const,
        relationshipId: authorization.binding.workspaceSyncAdmission?.relationshipId,
        ...(context?.requesterSessionBootstrap ? { credentials: context.requesterSessionBootstrap.credentials } : {}) }
        : { credentials: input.credentials }),
      ...(requester ? { credentials: requester.credentials, purpose: 'physical_sync' as const } : {}),
      serverHttpBaseUrl: requester?.serverHttpBaseUrl ?? authorization?.requesterHttpProjection?.serverHttpBaseUrl ?? readServerHttpBaseUrl(),
      localProfileId, ...(input.homeTarget ? { homeTarget: input.homeTarget } : {}), machineIds, signal });
  };
  const currentRouteSnapshot = async (request: WorkspaceSyncPrepareBetweenRequestV1, signal?: AbortSignal, context?: RpcHandlerContext) => {
    await privateRecovery;
    const snapshot = await timeWebLatencyPhase('workspaceSync.route.projectRows', () => readHandoffProjectSnapshot(signal, context));
    if (isProjectPreparation(context)) await timeWebLatencyPhase('workspaceSync.route.originalInput',
      () => assertProjectPreparationInput(request, snapshot, context!));
    const serverId = semanticServerId;
    const workspaceRefs = snapshot.workspaceRefs.filter(ref => ref.serverId === serverId);
    const endpoints = workspaceRefs.filter(ref => ref.id === request.sourceWorkspaceRefId || ref.id === request.targetWorkspaceRefId);
    const childMachines = await timeWebLatencyPhase('workspaceSync.route.endpointMachines',
      () => readHandoffChildMachines(endpoints.map(ref => ref.machineId), signal, context));
    return {
      serverId,
      workspaceRefs,
      relationships: snapshot.relationships,
      childMachines,
    };
  };
  const routeFailure = (route: Extract<ReturnType<typeof resolveWorkspaceSyncTransferRoute>, { ok: false }>): WorkspaceSyncPrepareBetweenResultV1 => ({
    ok: false,
    errorCode: route.code,
    completed: [],
    ...('relationshipId' in route ? { blockedRelationshipId: route.relationshipId } : {}),
  });
  function isProjectPreparation(context?: RpcHandlerContext): boolean {
    const actionId = context?.callerInputAuthorization?.binding.actionId;
    return isProjectWorkspaceSyncPreparationActionV1(actionId);
  }
  const assertProjectPreparationInput = async (request: WorkspaceSyncPrepareBetweenRequestV1,
    snapshot: ActiveProjectAccountRowsSnapshot, context: RpcHandlerContext) => {
    const authorization = context.callerInputAuthorization;
    const binding = authorization?.binding;
    const envelope = context.workspaceSyncSourceRouting?.originalActionEnvelope ?? context.originalActionEnvelope;
    const requester = readRequesterAccountActionContext(authorization);
    if (!authorization || !binding || !requester || !envelope
      || !isProjectWorkspaceSyncPreparationActionV1(binding.actionId)
      || binding.serverIdentityId !== semanticServerId
      || !isExternalActionAuthorizationBoundToEnvelope(binding, { actionId: binding.actionId, machineId: binding.machineId, envelope })) {
      throw compositionError('project_requester_authority_unavailable', 'The original Project requester is unavailable');
    }
    let originalInput: unknown = envelope.v === 1 ? envelope.input : undefined;
    if (envelope.v === 2) {
      const encryption = await requester.resolveEncryption(context.signal);
      if (encryption?.serverIdentityId === semanticServerId) {
        originalInput = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, material: encryption.material, binding: {
          serverIdentityId: binding.serverIdentityId, accountId: binding.accountId, actionId: binding.actionId,
          requestId: binding.requestId, target: binding.target,
          ...('authentication' in binding ? { authentication: { kind: binding.authentication.kind,
            tokenEpoch: binding.authentication.tokenEpoch } } : { credentialId: binding.credentialId }),
        } })?.input;
      }
    }
    const source = resolveWorkspaceRefById(snapshot.workspaceRefs, request.sourceWorkspaceRefId, semanticServerId);
    const target = resolveWorkspaceRefById(snapshot.workspaceRefs, request.targetWorkspaceRefId, semanticServerId);
    const original = binding.actionId === 'projects.service.relocate'
      ? ProjectServiceRelocateInputV1Schema.safeParse(originalInput)
      : binding.actionId === 'localServices.launcher.start'
        ? DaemonLocalServiceLauncherStartRequestV1Schema.safeParse(originalInput)
      : PROJECT_ACTION_INPUT_SCHEMAS_V1[binding.actionId].safeParse(originalInput);
    const matchesWorkspace = original.success && source && target && original.data.workspace && original.data.workspace.serverId === semanticServerId
      && ('selectedTarget' in original.data
        ? original.data.workspace.refId === source.id && original.data.selectedTarget.machineId === target.machineId
        : original.data.workspace.workspaceId === source.id && original.data.workspace.machineId === source.machineId
          && original.data.workspace.rootPath === source.rootPath && target.machineId === binding.machineId);
    const matchesService = binding.actionId !== 'localServices.launcher.start' || original.success && source && target
      && 'targetId' in original.data && original.data.machineId === binding.machineId
      && original.data.declaration?.workspaceRefId === source.id
      && original.data.targetId === createProjectServiceDeclarationTargetIdV1(source, original.data.declaration.selection)
      && (original.data.choice === undefined || original.data.choice.kind === 'workers'
        && (original.data.choice.destination.kind !== 'machine' || original.data.choice.destination.machineId === target.machineId));
    if (!matchesWorkspace || !matchesService || !source
      || context.workspaceSyncSourceRouting && (context.workspaceSyncSourceRouting.sourceMachineId !== source.machineId
        || context.workspaceSyncSourceRouting.sourceRootPath !== source.rootPath)) {
      throw compositionError('project_workspace_changed', 'The original Project workspace no longer matches preparation');
    }
  };
  const prepareBetweenAtController = async (
    request: WorkspaceSyncPrepareBetweenRequestV1,
    signal?: AbortSignal,
    context?: RpcHandlerContext,
    admittedRoute?: Awaited<ReturnType<typeof currentRouteSnapshot>>,
  ): Promise<WorkspaceSyncPrepareBetweenResultV1> => withWebLatencyTrace(
    readWebLatencyTracePoint()?.requestId ?? context?.callerInputAuthorization?.binding.requestId ?? context?.transportRequestId,
    () => timeWebLatencyPhase('workspaceSync.prepareBetweenAtController', async () => {
    if (!runtime) throw controllerUnavailable();
    const initial = admittedRoute ?? await currentRouteSnapshot(request, signal, context);
    const route = resolveWorkspaceSyncTransferRoute({ ...initial, ...request });
    if (!route.ok) return routeFailure(route);
    if (route.kind !== 'same_workspace' && route.controllerMachineId !== input.localMachineId) {
      throw compositionError('workspace_sync_controller_mismatch', 'Linked workspace route belongs to another controller');
    }
    if (isProjectPreparation(context) && route.relationships.some(relationship =>
      !runtime!.handoffAdapter.resolvePrivateExecution?.({ relationshipId: relationship.relationshipId }))) {
      assertInstalledRelationshipOwner(context);
    }
    return await prepareWorkspaceSyncBetween({
      ...request,
      serverId: semanticServerId,
      initial,
      readCurrent: async () => initial,
      flush: async (relationshipId, flushSignal, admitted) =>
        await runtime!.managedWorkspaceSync.flush(relationshipId, flushSignal, admitted),
      ...(signal ? { signal } : {}),
    });
  }));
  const handoffPrepareBetween = async (
    request: WorkspaceSyncPrepareBetweenRequestV1,
    signal?: AbortSignal,
    context?: RpcHandlerContext,
  ): Promise<WorkspaceSyncPrepareBetweenResultV1> => withWebLatencyTrace(
    readWebLatencyTracePoint()?.requestId ?? context?.callerInputAuthorization?.binding.requestId ?? context?.transportRequestId,
    () => timeWebLatencyPhase('workspaceSync.handoffPrepareBetween', async () => {
    const snapshot = await currentRouteSnapshot(request, signal, context);
    const route = resolveWorkspaceSyncTransferRoute({ ...snapshot, ...request });
    if (!route.ok) return routeFailure(route);
    if (route.kind === 'same_workspace' || route.controllerMachineId === input.localMachineId) {
      return await prepareBetweenAtController(request, signal, context, snapshot);
    }
    try {
      if (isProjectPreparation(context)) {
        if (!context || !input.callWorkspacePrepareBetween) throw compositionError('workspace_sync_update_required', 'Signed controller preparation is unavailable');
        const sourceWorkspace = resolveWorkspaceRefById(snapshot.workspaceRefs, request.sourceWorkspaceRefId, semanticServerId);
        if (!sourceWorkspace) throw compositionError('workspace_ref_not_ready', 'The admitted source Workspace is unavailable');
        return WorkspaceSyncPrepareBetweenResultV1Schema.parse(await input.callWorkspacePrepareBetween({
          machineId: route.controllerMachineId, sourceWorkspace, request, ...(signal ? { signal } : {}),
        }, context));
      }
      const result = await factories.callMachineRpc({
        credentials: input.credentials,
        machineId: route.controllerMachineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN,
        request,
        timeoutMs: null,
        ...(signal ? { signal } : {}),
      });
      return WorkspaceSyncPrepareBetweenResultV1Schema.parse(result);
    } catch (error) {
      if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
        return { ok: false, errorCode: 'workspace_sync_update_required', completed: [] };
      }
      throw error;
    }
  }));

  const readHandoffExecutionBasis = async (request: Parameters<DaemonWorkspaceSyncRuntimeDependencies['bootstrap']>[0], context?: RpcHandlerContext,
    physicalSourceAuthority?: WorkspaceSyncSourceContextV1) => {
    await privateRecovery;
    const serverId = semanticServerId;
    if (physicalSourceAuthority) {
      // SOURCE ingress has already retained the original logical carrier. This
      // daemon owns only its native-bound source root, not the Actor's Project
      // rows or independently chosen target namespace.
      const candidate = context?.callerInputAuthorization?.binding;
      const binding = candidate && (isProjectWorkspaceSyncOpenActionV1(candidate.actionId)
        || isProjectWorkspaceSyncPreparationActionV1(candidate.actionId)) ? candidate : undefined;
      const routing = context?.workspaceSyncSourceRouting;
      const logicalSource = routing ? { machineId: routing.sourceMachineId, rootPath: routing.sourceRootPath }
        : { machineId: request.sourceMachineId, rootPath: request.sourceRootPath };
      const relationshipId = request.action.kind === 'relationship' ? request.action.relationshipId
        : isProjectPreparation(context) ? binding?.workspaceSyncAdmission?.relationshipId
          : deriveWorkspaceSyncRelationshipId(request.operationId);
      const admitted = binding && relationshipId ? readWorkspaceSyncSourceAdmissionV1(binding,
        { serverId, relationshipId, machineId: logicalSource.machineId,
          ...(request.sourceMachineId === logicalSource.machineId && request.sourceWorkspaceRefId
            ? { workspaceRefId: request.sourceWorkspaceRefId } : {}) }) : null;
      if (binding && !admitted) {
        throw compositionError('workspace_sync_source_admission_unavailable', 'The admitted Sync source facts are unavailable');
      }
      if (admitted ? !isDeepStrictEqual(admitted.source, physicalSourceAuthority.machineAdmission)
        : !context?.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()) {
        throw compositionError('workspace_sync_child_unavailable', 'Physical source admission is no longer current');
      }
      const snapshot = await readHandoffProjectSnapshot(request.signal);
      const childMachines = await readHandoffChildMachines([logicalSource.machineId], request.signal, context, physicalSourceAuthority);
      const child = childMachines.find(child => child.machineId === logicalSource.machineId && child.serverId === serverId);
      if (!admitted && (!child || child.projection.observation.storage.kind !== 'bind'
        || child.controller.machineId !== input.localMachineId
        || (routing ? child.installationId : child.controller.installationId)
          !== physicalSourceAuthority.machineAdmission.installationId)) {
        throw compositionError('workspace_sync_child_unavailable', 'The admitted child does not resolve to this physical source');
      }
      const logicalRef = resolveWorkspaceRefV1(snapshot.workspaceRefs, { serverId, ...logicalSource });
      const endpointInput = { workspaceRefs: snapshot.workspaceRefs, childMachines,
        ...(admitted ? { purpose: 'admitted_mapping' as const } : {}) };
      const resolved = logicalRef.kind === 'resolved' ? resolveWorkspaceSyncEndpoint({ ...endpointInput, workspace: logicalRef.ref })
        : resolveWorkspaceSyncEndpoint({ ...endpointInput, namespace: { serverId, ...logicalSource } });
      if (!resolved.ok || resolved.endpoint.machineId !== input.localMachineId
        || !(request.sourceMachineId === logicalSource.machineId && request.sourceRootPath === logicalSource.rootPath
          || request.sourceMachineId === resolved.endpoint.machineId && request.sourceRootPath === resolved.endpoint.rootPath)) {
        throw compositionError('workspace_sync_child_unavailable', 'The physical source Workspace is unavailable');
      }
      return { snapshot, childMachines, input: { ...request, sourceWorkspaceRefId: resolved.endpoint.id,
        sourceMachineId: resolved.endpoint.machineId, sourceRootPath: resolved.endpoint.rootPath } };
    }
    const authorization = context?.callerInputAuthorization;
    const snapshot = runtime?.handoffAdapter.resolvePrivateExecution?.({ operationId: request.operationId })
      ?.execution.getSnapshot?.() ?? await readHandoffProjectSnapshot(request.signal, context);
    if (authorization) {
      for (const endpoint of [
        { workspaceId: request.sourceWorkspaceRefId, machineId: request.sourceMachineId, rootPath: request.sourceRootPath, managed: undefined },
        { workspaceId: request.targetWorkspaceRefId, machineId: request.targetMachineId, rootPath: request.targetRootPath,
          managed: request.targetManaged },
      ]) {
        if (endpoint.workspaceId && resolveWorkspaceRefV1(snapshot.workspaceRefs, endpoint.managed
          ? { v: 2, kind: 'managed', serverId, workspaceId: endpoint.workspaceId, rootPath: endpoint.rootPath, ...endpoint.managed }
          : { serverId, ...endpoint }).kind !== 'resolved') {
          throw compositionError('workspace_ref_not_ready', 'The admitted requester endpoint is no longer current');
        }
      }
    }
    const childMachines = await readHandoffChildMachines([request.sourceMachineId, request.targetMachineId], request.signal, context);
    if (childMachines.length === 0) return { input: request, childMachines, snapshot };
    const childEndpoint = (machineId: string, rootPath: string, workspaceId?: string) => {
      if (!childMachines.some(child => child.machineId === machineId)) return null;
      const workspace = resolveWorkspaceRefV1(snapshot.workspaceRefs, { serverId, machineId, rootPath,
        ...(workspaceId ? { workspaceId } : {}) });
      if (workspace.kind !== 'resolved') throw compositionError('workspace_sync_child_unavailable', 'Admitted child endpoint is unavailable');
      const resolved = resolveWorkspaceSyncEndpoint({ workspace: workspace.ref, workspaceRefs: snapshot.workspaceRefs, childMachines,
        ...(authorization ? { purpose: 'admitted_mapping' as const } : {}) });
      if (!resolved.ok) throw compositionError('workspace_sync_child_unavailable', 'Child Sync endpoint is unavailable');
      return resolved.endpoint;
    };
    const sourceEndpoint = childEndpoint(request.sourceMachineId, request.sourceRootPath, request.sourceWorkspaceRefId);
    const targetEndpoint = request.targetManaged ? null : childEndpoint(request.targetMachineId, request.targetRootPath, request.targetWorkspaceRefId);
    if (request.action.kind === 'create_relationship'
      && (sourceEndpoint?.id ?? request.sourceWorkspaceRefId) !== undefined
      && (sourceEndpoint?.id ?? request.sourceWorkspaceRefId) === (targetEndpoint?.id ?? request.targetWorkspaceRefId)) {
      throw compositionError('workspace_sync_child_unavailable', 'A bind alias cannot create a second relationship');
    }
    return { childMachines, snapshot, input: { ...request,
      ...(sourceEndpoint ? { sourceWorkspaceRefId: sourceEndpoint.id, sourceMachineId: sourceEndpoint.machineId,
        sourceRootPath: sourceEndpoint.rootPath } : {}),
      ...(targetEndpoint ? { targetWorkspaceRefId: targetEndpoint.id, targetMachineId: targetEndpoint.machineId,
        targetRootPath: targetEndpoint.rootPath } : {}) } };
  };
  const assertOriginalTargetAuthority = (
    request: Parameters<DaemonWorkspaceSyncRuntimeDependencies['bootstrap']>[0],
    execution: Parameters<DaemonWorkspaceSyncRuntimeDependencies['bootstrap']>[0],
    authority?: WorkspaceSyncSourceContextV1,
    context?: RpcHandlerContext,
  ) => {
    // Native placement proves storage custody, not permission on an independently
    // chosen target. A delegated source cannot borrow this daemon's Account for it.
    if (authority && (request.action.kind === 'copy_once' || request.action.kind === 'create_relationship')
      && !(execution.sourceMachineId === execution.targetMachineId
        && execution.sourceRootPath === execution.targetRootPath)
      // A Home-verified original Root must use the independently admitted D
      // purpose. It cannot fall through to ambient custodian transport; the
      // target owner refuses until that exact requester path is available.
      && !(context?.callerInputAuthorization && context.workspaceSyncSourceRouting)
      && (authority.callerAuthority !== 'present_user'
        || authority.machineAdmission.actorAccountId !== readAccountIdFromToken(input.credentials.token))) {
      throw compositionError('workspace_sync_update_required', 'The original target requester transport is unavailable');
    }
  };
  const createInstalledTargetCleanupContext = (
    source: NonNullable<RpcHandlerContext['workspaceSyncSourceRouting']>,
    sourceWriter: Readonly<{ machineId: string; installationId: string }> | undefined,
    target: WorkspaceSyncTargetPhaseDescriptor['routing'],
  ): RpcHandlerContext => {
    const accountId = readAccountIdFromToken(input.credentials.token);
    if (!source.sourceContext || !sourceWriter || sourceWriter.machineId !== input.localMachineId || !accountId
      || source.sourceContext.machineAdmission.custodianAccountId !== accountId) {
      throw compositionError('workspace_sync_child_unavailable', 'The installed source cleanup identity is unavailable');
    }
    // Release uses current installed custody and the target's retained loan,
    // never the historical requester's HTTP or Action authority.
    return {
      signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { ...source.sourceContext.machineAdmission,
        actorAccountId: accountId, custodianAccountId: accountId, machineId: sourceWriter.machineId,
        installationId: sourceWriter.installationId, role: 'manage' },
      workspaceSyncSourceWriterTargetRouting: WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({
        v: 1, sourceWriter: { machineId: sourceWriter.machineId, installationId: sourceWriter.installationId },
        source, target,
      }),
    };
  };
  const resolveHandoffExecutionInput: NonNullable<DaemonWorkspaceSyncRuntimeDependencies['resolveHandoffExecutionInput']> = async (request, authority, context) => {
    const accepted = await readHandoffExecutionBasis(request, context, authority);
    const requester = readRequesterAccountActionContext(context?.callerInputAuthorization);
    if (!runtime?.handoffAdapter.resolvePrivateExecution?.({ operationId: request.operationId })
      && request.action.kind !== 'copy_once' && request.action.kind !== 'none'
      && context?.workspaceSyncSourceRouting && context.callerInputAuthorization?.binding.actionId === 'projects.open'
      && (!canUseInstalledRelationshipOwner(context)
        || requester?.retainCustody && input.requesterMachineAdmissionBoundary && context.machineAdmission)) {
      if (!requester) throw compositionError('project_requester_authority_unavailable', 'Requester Sync custody is unavailable');
      const boundary = input.requesterMachineAdmissionBoundary;
      const admission = context.machineAdmission;
      if (!requester.retainCustody || !boundary || !admission) throw compositionError('project_requester_authority_unavailable', 'Retained requester Sync custody is unavailable');
      const custody = requester.retainCustody();
      const attribution = { serverId: localProfileId, accountId: context.callerInputAuthorization.binding.accountId,
        machineId: admission.machineId, installationId: admission.installationId };
      let relationshipId: string | undefined;
      let snapshot = accepted.snapshot;
      let preparedTargetEndpoint: MachineInstallationPublicIdentityV1 | undefined;
      runtime?.handoffAdapter.retainPrivateExecution?.({ input: request, execution: {
        credentials: requester.credentials,
        accountRowsCustody: { serverId: semanticServerId, accountId: context.callerInputAuthorization.binding.accountId,
          serverHttpBaseUrl: requester.serverHttpBaseUrl, isCurrent: custody.isCurrent },
        getSnapshot: () => snapshot,
        replaceSnapshot: async next => { snapshot = next; },
        ...(input.callWorkspaceTargetPhase ? { callTargetPhase: async descriptor => {
          if (isWorkspaceSyncSourceWriterCleanupPhaseV1(descriptor.routing.phase) && preparedTargetEndpoint) {
            const source = context.workspaceSyncSourceRouting!;
            const sourceWriter = accepted.childMachines.find(child => child.machineId === source.sourceMachineId)?.controller
              ?? context.callerInputAuthorization?.binding.workspaceSyncAdmission?.source;
            return await input.callWorkspaceTargetPhase!({ ...descriptor, physicalEndpoint: preparedTargetEndpoint },
              { ...createInstalledTargetCleanupContext(source, sourceWriter, descriptor.routing),
                ...(descriptor.operationContext ? { localActionContext: descriptor.operationContext } : {}),
                ...(descriptor.callerInputAuthorization ? { callerInputAuthorization: descriptor.callerInputAuthorization } : {}) });
          }
          const result = await input.callWorkspaceTargetPhase!(descriptor, { ...context,
            ...(descriptor.operationContext ? { localActionContext: descriptor.operationContext } : {}) });
          if (descriptor.routing.phase === 'prepare') {
            preparedTargetEndpoint = WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse(result).physicalEndpoint;
          }
          return result;
        } } : {}),
        assertTransferCurrent: async () => {
          if (!relationshipId || !await custody.isCurrent() || !await verifyWorkspaceSyncSourceMachineAdmissionCurrent({
            credentials: requester.credentials, sessionId: relationshipId, attribution,
            serverHttpBaseUrl: requester.serverHttpBaseUrl, boundary })) {
            throw compositionError('project_requester_authority_unavailable', 'Requester Sync custody is unavailable');
          }
        },
        retainRelationship: async id => {
          await createWorkspaceSyncSourceCredentialCustody({ happyHomeDir: input.happyHomeDir,
            relationshipId: id, attribution, credentials: requester.credentials, homeServerIdentityId: semanticServerId,
            machineAdmission: { custodianAccountId: admission.custodianAccountId, role: admission.role } });
          relationshipId = id;
        },
        release: custody.release,
      } });
      if (request.action.kind === 'relationship') await runtime?.handoffAdapter.bindPrivateExecutionRelationship?.(request.operationId, request.action.relationshipId);
    }
    assertOriginalTargetAuthority(request, accepted.input, authority, context);
    let targetPreflight: HandoffTargetReplacementPreflightResultV1 | undefined;
    let executionInput = accepted.input;
    if (authority && request.action.kind === 'copy_once' && !request.targetWorkspaceRefId
      && context?.callerInputAuthorization?.binding.actionId === 'projects.open'
      && context.workspaceSyncSourceRouting && context.workspaceSyncSourceExecution) {
      // A Project Root names D's namespace, not a Workspace row in P1's Account.
      // Only the reached target owner can qualify its existing physical row.
      targetPreflight = await targetAuthority.preflightHandoffTargetReplacementAtTarget({
        v: 1, operationId: request.operationId, serverId: semanticServerId,
        machineId: request.targetMachineId, targetPath: request.targetRootPath,
        ...(request.targetManaged ? { targetManaged: request.targetManaged } : {}),
        destinationIntent: 'materialize_from_source_workspace', ...(request.signal ? { signal: request.signal } : {}),
      }, context);
      const target = targetPreflight.targetWorkspace;
      if (!target || !targetPreflight.physicalEndpoint || target.serverId !== semanticServerId
        || resolveWorkspaceSyncExecutionMachineIdV1(target) !== targetPreflight.physicalEndpoint.machineId) {
        throw compositionError('workspace_sync_update_required', 'The qualified target Workspace is unavailable');
      }
      executionInput = { ...accepted.input, targetWorkspaceRefId: target.id,
        targetMachineId: resolveWorkspaceSyncExecutionMachineIdV1(target), targetRootPath: target.rootPath };
    }
    const sourceChild = accepted.childMachines.find(child => child.machineId === request.sourceMachineId);
    const sourceControllerAccess = sourceChild?.managedMachine?.controllerAccess;
    const sourcePhysicalEndpoint = sourceChild && sourceControllerAccess && executionInput.sourceMachineId !== request.sourceMachineId
      ? { machineId: sourceChild.controller.machineId, installationId: sourceChild.controller.installationId,
        installationPublicKey: sourceControllerAccess.installationPublicKey } : undefined;
    return { input: executionInput, ...(sourcePhysicalEndpoint ? { sourcePhysicalEndpoint } : {}),
      ...(targetPreflight ? { targetPreflight } : {}) };
  };

  const callRetainedCopyPhase = async (relationship: WorkspaceSyncRelationshipV1,
    phase: 'inspect' | 'remove' | 'dependencies', request: unknown, signal?: AbortSignal,
    retirementContext?: RpcHandlerContext) => {
    const retained = runtime?.handoffAdapter.resolvePrivateExecution?.({ relationshipId: relationship.relationshipId });
    if (!retained?.execution.callTargetPhase) return null;
    const target = resolveRelationshipBootstrapTarget(retained.execution.getSnapshot?.() ?? null, relationship, semanticServerId);
    const workspace = resolveWorkspaceRefById(retained.execution.getSnapshot?.()?.workspaceRefs ?? [], target.workspaceRefId, semanticServerId);
    if (!workspace) throw compositionError('workspace_unavailable', 'The retained copy target is unavailable');
    return { result: await retained.execution.callTargetPhase({ machineId: target.machineId,
      method: phase === 'dependencies' ? RPC_METHODS.DAEMON_PROJECT_WORKER_DEPENDENCIES
        : phase === 'inspect' ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT : RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_REMOVE,
      // Forward the current approved proof, not its in-process Account executor.
      // Native cleanup keeps the installed SOURCE's separate transport authority.
      request, ...(retirementContext?.callerInputAuthorization ? {
        callerInputAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse(retirementContext.callerInputAuthorization),
      } : {}),
      ...(retirementContext?.localActionContext ? { operationContext: retirementContext.localActionContext } : {}),
      routing: { v: 1, phase, operationId: retained.input.operationId, accountServerId: semanticServerId,
        targetMachineId: target.machineId, targetRootPath: workspace.rootPath,
        ...(target.targetManaged ? { targetManaged: target.targetManaged } : {}) }, ...(signal ? { signal } : {}) }) };
  };
  const committedCopyPhase = async (relationship: WorkspaceSyncRelationshipV1, phase: 'inspect' | 'remove',
    approval: WorkspaceSyncCommittedCopyTargetV1 | undefined, signal?: AbortSignal, retirementContext?: RpcHandlerContext) => {
    if (!approval) throw compositionError('approval_required', 'Committed-copy removal approval is required');
    const retained = await callRetainedCopyPhase(relationship, phase, approval, signal, retirementContext);
    if (!retained) {
      await (phase === 'inspect' ? targetAuthority.inspectCommittedCopyAtTarget : targetAuthority.removeCommittedCopyAtTarget)({
        ...approval, ...(signal ? { signal } : {}) }, retirementContext);
      return;
    }
    readMachineActionRpcResult(retained.result);
    const result = WorkspaceSyncCommittedCopyTargetResultV1Schema.parse(retained.result);
    if (!result.ok) throw Object.assign(compositionError(result.errorCode, 'Workspace copy has dependent work'), { dependencies: result.dependencies });
  };
  const relationshipDependencyReader = (credentials: StoredCredentials): NonNullable<WorkspaceSyncRelationshipOwnerOptions['readRelationshipDependencies']> =>
    async (relationship, snapshot, removal) => {
      const serverId = semanticServerId;
      // Definition retirement preserves remote bytes. Only byte removal needs
      // component-wide observations; an offline peer cannot veto retirement.
      const machineIds = removal
        ? resolveWorkspaceSyncRelationshipDependencyMachines({ ...snapshot, serverId,
          relationshipId: relationship.relationshipId }) : [input.localMachineId];
      const dependencies = await Promise.all(machineIds.flatMap(machineId =>
        [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId].map(async workspaceRefId => {
          if (machineId === input.localMachineId) {
            if (!input.readProjectWorkerDependencies) throw compositionError('workspace_sync_dependencies_unavailable', 'Worker dependency owner is unavailable');
            return input.readProjectWorkerDependencies(workspaceRefId, relationship.relationshipId);
          }
          try {
            const request = { serverId, machineId, workspaceRefId, relationshipId: relationship.relationshipId };
            const capture = runtime?.handoffAdapter.resolvePrivateExecution?.({ relationshipId: relationship.relationshipId });
            const target = capture ? resolveRelationshipBootstrapTarget(capture.execution.getSnapshot?.() ?? null, relationship, serverId) : null;
            // A retained target loan admits only that physical target, never other Machines in the component.
            const retained = target?.machineId === machineId ? await callRetainedCopyPhase(relationship, 'dependencies', request) : null;
            const result = retained ? retained.result : await factories.callMachineRpc({ credentials, machineId,
              method: RPC_METHODS.DAEMON_PROJECT_WORKER_DEPENDENCIES, request });
            readMachineActionRpcResult(result);
            return z.array(ProjectWorkerDependencyV1Schema).parse(result);
          } catch {
            throw compositionError('workspace_sync_dependencies_unavailable', 'Worker dependency observation is unavailable');
          }
        })));
      return [...new Map(dependencies.flat().map(dependency => [dependency.operationId, dependency])).values()];
    };
  const requesterRelationshipOwner = (retained: NonNullable<ReturnType<NonNullable<WorkspaceSyncHandoffAdapter['resolvePrivateExecution']>>>,
    retirementContext?: RpcHandlerContext): WorkspaceSyncRelationshipOwner => {
      const capture = retained.execution;
      const readSnapshot = async (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        const snapshot = capture.getSnapshot?.();
        if (!snapshot) throw compositionError('project_requester_authority_unavailable', 'Requester Sync projection is unavailable');
        return snapshot;
      };
      const mutateSnapshot = createProjectAccountSnapshotMutation({ credentials: capture.credentials,
        sessionCustody: capture.accountRowsCustody, serverId: semanticServerId });
      const releaseTarget = async (relationship: WorkspaceSyncRelationshipV1, reason: 'abort' | 'relationship_committed') => {
        const target = resolveRelationshipBootstrapTarget(capture.getSnapshot?.() ?? null, relationship, semanticServerId);
        const wire = { v: 1 as const, bootstrapOperationId: relationship.relationshipId,
          targetWorkspaceRefId: target.workspaceRefId, reason };
        if (capture.managedTarget) {
          await targetAuthority.releaseBootstrapHere(wire);
          return;
        }
        if (!capture.callTargetPhase && target.machineId === input.localMachineId && capture.nativeSync) {
          await capture.nativeSync.releaseBootstrapHere(wire);
          return;
        }
        if (!capture.callTargetPhase) throw compositionError('workspace_sync_update_required', 'Private Sync target transport is unavailable');
        await capture.callTargetPhase({ machineId: target.machineId,
          method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE, request: wire,
          routing: { v: 1, phase: 'release', operationId: retained.input.operationId, accountServerId: semanticServerId,
            targetMachineId: retained.input.targetMachineId, targetRootPath: retained.input.targetRootPath,
            ...(target.targetManaged ? { targetManaged: target.targetManaged } : {}) } });
      };
      return factories.createRelationshipOwner({ localMachineId: input.localMachineId,
        mutateProjectSnapshot: async (request, signal) => {
          const result = await mutateSnapshot(request, signal);
          if (result.status === 'applied' || result.status === 'unchanged') {
            await capture.replaceSnapshot?.({ ...await readSnapshot(), ...result.snapshot, graphRevision: result.version });
          }
          return result;
        },
        readProjectSnapshot: readSnapshot,
        readRelationshipDependencies: relationshipDependencyReader(capture.credentials),
        inspectCommittedRelationshipTarget: async (relationship, _removal, signal, approval) => committedCopyPhase(relationship, 'inspect', approval, signal, retirementContext),
        removeCommittedRelationshipTarget: async (relationship, _removal, signal, approval) => committedCopyPhase(relationship, 'remove', approval, signal, retirementContext),
        ensureRelationship: async (relationship, signal, preparation) => {
          await runtime!.handoffAdapter.bindPrivateExecutionRelationship?.(retained.input.operationId, relationship.relationshipId);
          await readSnapshot(signal);
          return runtime!.managedWorkspaceSync.ensure(relationship, signal, preparation);
        },
        flushRelationship: async (relationshipId, signal) => runtime!.managedWorkspaceSync.flush(relationshipId, signal),
        commitRelationshipTarget: async relationship => releaseTarget(relationship, 'relationship_committed'),
        terminateRelationshipRuntime: async relationship => {
          await runtime!.managedWorkspaceSync.terminate(relationship.relationshipId);
          await releaseTarget(relationship, 'abort');
          if (capture.managedTarget) await runtime!.handoffAdapter.releasePrivateExecution?.(retained.input.operationId);
        },
        waitForProjectReconciliation: async (_revision, signal) => {
          await readSnapshot(signal);
          const currentCapture = runtime!.handoffAdapter.resolvePrivateExecution?.({ operationId: retained.input.operationId });
          // The disabled preparation row precedes native relationship admission.
          // Only a bound relationship has runtime state to reconcile.
          if (currentCapture?.relationshipId) await runtime!.reconcilePrivateRelationships();
          if (capture.managedTarget && currentCapture?.phase === 'relationship') {
            const relationshipId = currentCapture.relationshipId;
            const current = capture.getSnapshot?.()?.relationships.find(value => value.relationshipId === relationshipId);
            if (!current?.enabled) await capture.managedTarget.close();
          }
        },
      });
  };

  const prepareRelationshipTarget: NonNullable<DaemonWorkspaceSyncRuntimeDependencies['prepareRelationshipTarget']> = async (relationship, signal, preparation, admitted) => {
    const retained = runtime?.handoffAdapter.resolvePrivateExecution?.({ relationshipId: relationship.relationshipId });
    const target = resolveRelationshipBootstrapTarget(admitted ?? retained?.execution.getSnapshot?.() ?? factories.getProjectSnapshot(), relationship, semanticServerId);
    const prepare = {
      v: 1,
      bootstrapOperationId: relationship.relationshipId,
      owner: { kind: 'relationship', relationshipId: relationship.relationshipId },
      ...(preparation?.transient || retained || admitted
        ? { transientRelationship: relationship } : {}),
      targetWorkspaceRefId: target.workspaceRefId,
      targetMachineId: target.machineId,
      ...(admitted && !retained ? { admittedTarget: { machineId: target.machineId, rootPath: target.rootPath, ...(target.targetManaged ? { targetManaged: target.targetManaged } : {}) } } : {}),
      endpointRole: target.endpointRole,
      policyDigest: relationship.contentPolicy.policyDigest,
      createIfMissing: true,
      ...(preparation ? { targetBootstrap: preparation.targetBootstrap } : {}),
      ...(preparation?.targetReplacementApproval
        ? {
            targetReplacementApproval: preparation.targetReplacementApproval,
            targetReplacementApprovalReceiptId: preparation.targetReplacementApprovalReceiptId,
            targetReplacementApprovalActionInput: preparation.targetReplacementApprovalActionInput,
          }
        : {}),
      ...(signal ? { signal } : {}),
    } satisfies Parameters<typeof targetAuthority.prepareBootstrapAtTarget>[0];
    if (retained) {
      if (retained.execution.managedTarget) {
        const prepared = await targetAuthority.prepareBootstrapAtTarget({ ...prepare, transientRelationship: relationship });
        return prepared.ownershipHandles ? { ownershipHandles: prepared.ownershipHandles } : undefined;
      }
      const { targetMachineId: _targetMachineId, signal: _signal, ...wire } = prepare;
      // Project Open already owns its local member controller. Captures with a
      // signed TARGET transport still traverse that transport, including locally.
      if (!retained.execution.callTargetPhase && target.machineId === input.localMachineId && retained.execution.nativeSync) {
        const prepared = await retained.execution.nativeSync.prepareBootstrapAtTarget(prepare);
        return prepared.ownershipHandles ? { ownershipHandles: prepared.ownershipHandles } : undefined;
      }
      if (!retained.execution.callTargetPhase) throw compositionError('workspace_sync_update_required', 'Private Sync target transport is unavailable');
      await retained.execution.callTargetPhase({ machineId: target.machineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE, request: wire,
        routing: { v: 1, phase: 'prepare', operationId: retained.input.operationId, accountServerId: semanticServerId,
          targetMachineId: retained.input.targetMachineId, targetRootPath: retained.input.targetRootPath,
          ...(target.targetManaged ? { targetManaged: target.targetManaged } : {}) },
        ...(signal ? { signal } : {}) });
      if (target.machineId === input.localMachineId) {
        const owner = retained.execution.nativeSync ?? targetAuthority;
        return { ownershipHandles: [await owner.getPreparedBootstrapOwnership(wire)] };
      }
      return;
    }
    const prepared = await targetAuthority.prepareBootstrapAtTarget(prepare);
    return prepared.ownershipHandles ? { ownershipHandles: prepared.ownershipHandles } : undefined;
  };

  runtime = factories.createDaemonRuntime({
    resolveHandoffRelationshipOwner: async (request, context) => {
      const retained = runtime?.handoffAdapter.resolvePrivateExecution?.({ operationId: request.operationId });
      if (!retained) {
        assertInstalledRelationshipOwner(context);
        if (!relationshipOwner) throw controllerUnavailable();
        return relationshipOwner;
      }
      return requesterRelationshipOwner(retained);
    },
    preparePrivateExecution: async request => {
      const openMachineCarrierTunnel = input.createRequesterMachineCarrierTunnel?.({ credentials: request.credentials,
        accountId: request.accountRowsCustody.accountId });
      const execution = await preparePrivateWorkspaceSyncExecution({ ...request, assertTransferCurrent: async () => {
        await request.assertTransferCurrent();
        const identity = request.executionIdentity;
        const boundary = input.requesterMachineAdmissionBoundary;
        if (identity?.kind === 'isolated' && (!boundary || !await verifyWorkspaceSyncRelationshipMachineAdmissionCurrent({
          credentials: request.credentials, sessionId: request.input.operationId, attribution: identity.requester,
          serverHttpBaseUrl: request.accountRowsCustody.serverHttpBaseUrl, boundary }))) {
          throw compositionError('project_requester_authority_unavailable', 'Requester Sync custody is unavailable');
        }
      } }, {
        resolveNativeAgent: async () => {
          if (!runtime) throw controllerUnavailable();
          return runtime.resolveNativeAgent();
        },
        refreshProjectRows: factories.refreshProjectRows,
        callMachineRpc: factories.callMachineRpc,
        ...(input.callWorkspaceSeedExport ? { callWorkspaceSeedExport: input.callWorkspaceSeedExport } : {}),
        ...(openMachineCarrierTunnel ? { openMachineCarrierTunnel } : {}),
        readChildMachineFacts: async (machineIds, signal) => readWorkspaceSyncChildMachineFacts({
          credentials: request.credentials, serverId: semanticServerId,
          serverHttpBaseUrl: request.accountRowsCustody.serverHttpBaseUrl,
          localProfileId, ...(input.homeTarget ? { homeTarget: input.homeTarget } : {}), machineIds, signal }),
      });
      return { ...execution, ...(request.onSourceRootReleased ? { onSourceRootReleased: request.onSourceRootReleased } : {}),
        recoverConflictResolutionHere: async (recover, signal) => {
        if (!execution.nativeSync) throw compositionError('agent_isolation_unavailable', 'The captured native Sync member is unavailable');
        await refreshPrivateRows(execution, signal);
        return execution.nativeSync.recoverConflictResolutionHere(recover, signal);
      } } satisfies WorkspaceSyncPrivateExecution;
    },
    daemonDataRoot,
    localServerId: semanticServerId,
    localMachineId: input.localMachineId,
    releaseChannel: input.releaseChannel,
    resolveWorkspaceRef: async (workspaceRefId, copyOperationId) => {
      const privateResolution = runtime?.handoffAdapter.resolvePrivateWorkspaceRef?.(workspaceRefId, semanticServerId);
      const ref = (copyOperationId ? runtime?.handoffAdapter.resolvePreparedCopyTarget?.(copyOperationId, workspaceRefId) : null)
        ?? (privateResolution && privateResolution.kind !== 'unowned'
          ? privateResolution.kind === 'resolved' ? privateResolution.workspace : null : resolveWorkspaceRefById(
        factories.getProjectSnapshot()?.workspaceRefs ?? [],
        workspaceRefId,
        semanticServerId,
      ));
      return ref ? isManagedWorkspaceRefV2(ref) ? ref : { serverId: ref.serverId, machineId: ref.machineId, rootPath: ref.rootPath } : null;
    },
    rootOwnershipManager,
    borrowLinkedSourceRoot: async (operationId, workspaceRefId) => {
      const current = runtime?.handoffAdapter.resolvePrivateExecution?.({ operationId });
      if (!current) return targetAuthority.borrowSourceRootForCopy({ operationId, workspaceRefId });
      if (current.execution.managedTarget) {
        const native = await managedNative(current.relationshipId ?? operationId, workspaceRefId);
        return native ? native.borrowSourceRootForCopy({ operationId, workspaceRefId }) : null;
      }
      const owner = runtime?.handoffAdapter.listPrivateExecutions?.().find(capture =>
        capture.input.targetWorkspaceRefId === workspaceRefId
        && capture.execution.accountRowsCustody.accountId === current.execution.accountRowsCustody.accountId
        && capture.execution.accountRowsCustody.serverId === current.execution.accountRowsCustody.serverId
        && (capture.execution.nativeSync || capture.execution.executionIdentity?.kind === 'isolated')) ?? current;
      if (!owner.execution.nativeSync) {
        if (!owner.execution.executionIdentity) return null;
        throw compositionError('agent_isolation_unavailable', 'The captured native Sync source is unavailable');
      }
      return owner.execution.nativeSync.borrowSourceRootForCopy({ operationId, workspaceRefId });
    },
    resolvePrivateWorkspaceRoot: async rootPath => await (await privateNativeForRoot(rootPath))?.resolveLocalRoot(rootPath) ?? null,
    admitRelationshipTransfer: admitPrivateTransfer,
    openPrivateLocalWorkspaceAgentStream: async (request, transferAdmission) => {
      const retained = runtime?.handoffAdapter.resolvePrivateExecution?.({ operationId: request.operationId })
        ?? runtime?.handoffAdapter.resolvePrivateExecution?.({ relationshipId: request.operationId });
      if (retained?.execution.managedTarget) {
        if (retained.input.sourceWorkspaceRefId !== request.workspaceRefId || retained.execution.executionIdentity?.kind !== 'isolated') return null;
        if (transferAdmission) await transferAdmission;
        else await admitPrivateTransfer(request.operationId, request.signal);
        await retained.execution.managedTarget.open();
        const native = retained.execution.sourceNativeSync;
        if (!native) throw compositionError('agent_isolation_unavailable', 'The captured native Sync source is unavailable');
        const ingress = await native.openLocalWorkspaceAgentIngress(request);
        return connectWorkspaceSyncMachineTunnel({ localPort: ingress.port, localCapability: ingress.localCapability,
          observedPath: 'direct', close: ingress.close }, request.signal);
      }
      if (!retained || !retained.execution.nativeSync && !retained.execution.executionIdentity) return null;
      if (transferAdmission) await transferAdmission;
      else await admitPrivateTransfer(request.operationId, request.signal);
      const native = retained.execution.nativeSync;
      if (!native) throw compositionError('agent_isolation_unavailable', 'The captured native Sync member is unavailable');
      const ingress = await native.openLocalWorkspaceAgentIngress(request);
      return connectWorkspaceSyncMachineTunnel({ localPort: ingress.port, localCapability: ingress.localCapability,
        observedPath: 'direct', close: ingress.close }, request.signal);
    },
    openManagedWorkspaceAgentStream: async (request, endpoint, transferAdmission) => {
      const execution = managedExecution(request.operationId, endpoint.id);
      if (!execution?.managedTarget) throw compositionError('relationship_not_ready', 'The managed Sync relationship is unavailable');
      if (transferAdmission) await transferAdmission;
      else await admitPrivateTransfer(request.operationId, request.signal);
      const { target, native, signal } = await execution.managedTarget.open();
      const stream = target.openChannel([native.agentExecutablePath, 'synchronizer', '--external', '--root', request.canonicalRoot],
        request.signal ? AbortSignal.any([signal, request.signal]) : signal);
      return { stream, stop: async () => { stream.destroy(); await finished(stream).catch(() => undefined); } };
    },
    prepareRelationshipTarget,
    recoverCopyOnceTarget: async (operation) => {
      const target = resolveWorkspaceRefById(
        factories.getProjectSnapshot()?.workspaceRefs ?? [],
        operation.betaWorkspaceRefId,
        semanticServerId,
      );
      if (!target) throw compositionError('peer_unavailable', 'Workspace sync copy target endpoint is unavailable');
      await targetAuthority.prepareBootstrapAtTarget({
        v: 1,
        bootstrapOperationId: operation.operationId,
        owner: { kind: 'copy_once', operation },
        targetWorkspaceRefId: operation.betaWorkspaceRefId,
        targetMachineId: target.machineId,
        endpointRole: 'beta',
        policyDigest: operation.contentPolicy.policyDigest,
        createIfMissing: false,
      });
      let released = false;
      return {
        release: async (reason) => {
          if (released) return;
          await targetAuthority.releaseBootstrapAtTarget({
            v: 1,
            bootstrapOperationId: operation.operationId,
            targetWorkspaceRefId: operation.betaWorkspaceRefId,
            targetMachineId: target.machineId,
            reason: reason === 'commit' ? 'copy_committed' : 'abort',
          });
          released = true;
        },
      };
    },
    relationshipOwner: {
      materializeEndpoints: async (request) => {
        if (!relationshipOwner) throw compositionError('workspace_sync_unavailable', 'Workspace relationship owner is unavailable');
        return await relationshipOwner.materializeEndpoints(request);
      },
      prepareCreate: async (request) => {
        if (!relationshipOwner) throw compositionError('workspace_sync_unavailable', 'Workspace relationship owner is unavailable');
        return await relationshipOwner.prepareCreate(request);
      },
    },
    handoffRelationshipController: {
      flush: async (relationshipId, signal) => {
        const relationship = resolveRelationship(factories.getProjectSnapshot(), relationshipId);
        if (relationship.controllerMachineId === input.localMachineId) {
          if (!runtime) throw controllerUnavailable();
          return await runtime.managedWorkspaceSync.flush(relationshipId, signal);
        }
        try {
          const response = await factories.callMachineRpc({
            credentials: input.credentials,
            machineId: relationship.controllerMachineId,
            method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_FLUSH,
            request: { relationshipId },
            timeoutMs: null,
            ...(signal ? { signal } : {}),
          });
          return parseControllerStatusResponse(response);
        } catch (error) {
          if (signal?.aborted) throw error;
          if (readRpcErrorCode(error) || error && typeof error === 'object' && 'code' in error) throw error;
          throw controllerUnavailable(error);
        }
      },
    },
    handoffPrepareBetween,
    resolveHandoffExecutionInput,
    bootstrap: async (bootstrapInput, admittedInput, authority, context, targetPreflight) => {
      const basis = await readHandoffExecutionBasis(authority && admittedInput
        ? { ...admittedInput, signal: bootstrapInput.signal } : bootstrapInput, context, authority);
      bootstrapInput = basis.input;
      if (targetPreflight) {
        const target = targetPreflight.targetWorkspace;
        if (!target || !targetPreflight.physicalEndpoint || target.serverId !== semanticServerId
          || resolveWorkspaceSyncExecutionMachineIdV1(target) !== targetPreflight.physicalEndpoint.machineId) {
          throw compositionError('workspace_sync_child_unavailable', 'The qualified target Workspace changed before preparation');
        }
        bootstrapInput = { ...bootstrapInput, targetWorkspaceRefId: target.id,
          targetMachineId: resolveWorkspaceSyncExecutionMachineIdV1(target), targetRootPath: target.rootPath };
      }
      if (sameExecutionWorkspace(bootstrapInput)) {
        return { release: async () => undefined };
      }
      const prepareRequest = resolveBootstrapPrepareRequest(
        bootstrapInput,
        basis.snapshot,
        semanticServerId,
      );
      let sourceOwnership: WorkspaceRootOwnershipHandle | null = null;
      let releaseSourceOwnership: (() => Promise<void>) | null = null;
      let copySourceWorkspaceRefId: string | null = null;
      let copyTargetWorkspaceRefId: string | null = null;
      if (bootstrapInput.action.kind === 'copy_once') {
        const sourceWorkspaceRefId = bootstrapInput.sourceWorkspaceRefId;
        const targetWorkspaceRefId = bootstrapInput.targetWorkspaceRefId;
        if (!sourceWorkspaceRefId || !targetWorkspaceRefId) {
          throw compositionError('workspace_ref_not_ready', 'Workspace sync copy endpoints were not materialized');
        }
        copySourceWorkspaceRefId = sourceWorkspaceRefId;
        copyTargetWorkspaceRefId = targetWorkspaceRefId;
        const sourceRef = resolveWorkspaceRefById(
          basis.snapshot.workspaceRefs,
          sourceWorkspaceRefId,
          semanticServerId,
        );
        if (!sourceRef || isManagedWorkspaceRefV2(sourceRef) || sourceRef.machineId !== input.localMachineId) {
          throw compositionError('peer_unavailable', 'Workspace sync source endpoint is unavailable on this daemon');
        }
        const loan = await runtime?.managedWorkspaceSync.borrowSourceRootForCopy(
          bootstrapInput.operationId, sourceWorkspaceRefId,
        ) ?? null;
        if (loan) {
          sourceOwnership = loan.handle;
          releaseSourceOwnership = loan.release;
        } else {
          const acquired = await rootOwnershipManager.tryAcquire({
            ownerId: bootstrapInput.operationId,
            canonicalRoot: sourceRef.rootPath,
            operation: 'handoff',
          });
          if ('kind' in acquired) {
            throw compositionError('workspace_root_in_use', 'Workspace sync source root overlaps an active operation');
          }
          sourceOwnership = acquired;
          releaseSourceOwnership = async () => await acquired.release();
        }
      }
      let targetOwnershipHandles: readonly WorkspaceRootOwnershipHandle[] = [];
      const admittedTarget = authority && admittedInput ? {
        machineId: admittedInput.targetMachineId, rootPath: admittedInput.targetRootPath,
        ...(admittedInput.targetManaged ? { targetManaged: admittedInput.targetManaged } : {}),
      } : undefined;
      let physicalTargetEndpoint: MachineInstallationPublicIdentityV1 | undefined;
      let sourceSeedTargetWorkspace: WorkspaceRefV1 | undefined;
      let acceptedTargetWorkspace: WorkspaceRefV1 | undefined;
      let copyOnceBaseline: WorkspaceManifest | undefined;
      let copyOnceExcludedPaths: readonly string[] | undefined;
      let retainedTargetCleanupContext: RpcHandlerContext | undefined;
      const privateTarget = runtime?.handoffAdapter.resolvePrivateExecution?.({ operationId: bootstrapInput.operationId });
      const nativeTarget = privateTarget?.execution.nativeSync;
      if (privateTarget?.execution.executionIdentity?.kind === 'isolated'
        && bootstrapInput.targetMachineId === input.localMachineId && !nativeTarget) {
        throw compositionError('agent_isolation_unavailable', 'The captured native Sync target is unavailable');
      }
      const releaseTarget = async (reason: 'abort' | 'copy_committed' | 'relationship_committed') => {
        const cleanupSignal = new AbortController().signal;
        if (nativeTarget && bootstrapInput.targetMachineId === input.localMachineId) {
          await nativeTarget.releaseBootstrapHere({ v: 1, bootstrapOperationId: prepareRequest.bootstrapOperationId,
            targetWorkspaceRefId: prepareRequest.targetWorkspaceRefId, reason }, cleanupSignal);
          return;
        }
        await targetAuthority.releaseBootstrapAtTarget({
          v: 1,
          bootstrapOperationId: prepareRequest.bootstrapOperationId,
          // The original logical locator is known even when the prepare ACK is
          // lost. The recipient binds it to its same retained definition.
          targetWorkspaceRefId: prepareRequest.targetWorkspaceRefId,
          targetMachineId: physicalTargetEndpoint?.machineId ?? bootstrapInput.targetMachineId,
          ...(physicalTargetEndpoint ? { physicalEndpoint: physicalTargetEndpoint }
            : admittedTarget ? { admittedTarget } : {}),
          reason, signal: cleanupSignal,
        }, retainedTargetCleanupContext
          ? { ...retainedTargetCleanupContext, signal: cleanupSignal }
          : context ? { ...context, signal: cleanupSignal } : undefined);
      };
      try {
        const sourceRouting = context?.workspaceSyncSourceWriterTargetRouting?.source ?? context?.workspaceSyncSourceRouting;
        if (context?.callerInputAuthorization && sourceRouting && admittedTarget) {
          const preflight = targetPreflight ?? await targetAuthority.preflightHandoffTargetReplacementAtTarget({
            v: 1, serverId: semanticServerId, operationId: prepareRequest.bootstrapOperationId,
            machineId: admittedTarget.machineId, targetPath: admittedTarget.rootPath,
            ...(admittedTarget.targetManaged ? { targetManaged: admittedTarget.targetManaged } : {}),
            destinationIntent: prepareRequest.targetBootstrap,
            ...(bootstrapInput.signal ? { signal: bootstrapInput.signal } : {}),
          }, context);
          if (!preflight.physicalEndpoint || !sourceRouting.sourceContext) {
            throw compositionError('workspace_sync_update_required', 'The installed target cleanup endpoint is unavailable');
          }
          const sourceWriter = context.workspaceSyncSourceWriterTargetRouting?.sourceWriter
            ?? basis.childMachines.find(child => child.machineId === sourceRouting.sourceMachineId)?.controller
            ?? context.callerInputAuthorization.binding.workspaceSyncAdmission?.source;
          retainedTargetCleanupContext = createInstalledTargetCleanupContext(sourceRouting, sourceWriter,
            { v: 1, phase: 'release', operationId: prepareRequest.bootstrapOperationId,
              accountServerId: semanticServerId, targetMachineId: admittedTarget.machineId,
              targetRootPath: admittedTarget.rootPath,
              ...(admittedTarget.targetManaged ? { targetManaged: admittedTarget.targetManaged } : {}) });
          physicalTargetEndpoint = preflight.physicalEndpoint;
          if (preflight.targetWorkspace) {
            const target = preflight.targetWorkspace;
            if ((!bootstrapInput.targetManaged && bootstrapInput.action.kind !== 'copy_once') || target.serverId !== semanticServerId
              || target.id !== prepareRequest.targetWorkspaceRefId || resolveWorkspaceSyncExecutionMachineIdV1(target) !== physicalTargetEndpoint.machineId
              || resolveWorkspaceSyncExecutionMachineIdV1(target) !== bootstrapInput.targetMachineId || target.rootPath !== bootstrapInput.targetRootPath) {
              throw compositionError('workspace_sync_child_unavailable', 'The qualified seed target changed before preparation');
            }
            sourceSeedTargetWorkspace = target;
          }
        }
        const prepareTarget = async () => {
          if (nativeTarget && bootstrapInput.targetMachineId === input.localMachineId) {
            return nativeTarget.prepareBootstrapAtTarget(prepareRequest);
          }
          return targetAuthority.prepareBootstrapAtTarget({
            ...prepareRequest, ...(admittedTarget ? { admittedTarget } : {}),
          }, context);
        };
        const preparedTarget = sourceOwnership && copySourceWorkspaceRefId && copyTargetWorkspaceRefId
          && bootstrapInput.action.kind === 'copy_once' && runtime
          ? await runtime.managedWorkspaceSync.withSourceSeedAuthorization({
              v: 1,
              operationId: bootstrapInput.operationId,
              controllerMachineId: bootstrapInput.sourceMachineId,
              alphaWorkspaceRefId: copySourceWorkspaceRefId,
              betaWorkspaceRefId: copyTargetWorkspaceRefId,
              contentPolicy: bootstrapInput.action.contentPolicy,
            }, [sourceOwnership], prepareTarget, sourceSeedTargetWorkspace)
          : await prepareTarget();
        copyOnceBaseline = preparedTarget.copyOnceBaseline;
        copyOnceExcludedPaths = preparedTarget.copyOnceExcludedPaths;
        if (physicalTargetEndpoint && !isDeepStrictEqual(preparedTarget.physicalEndpoint, physicalTargetEndpoint)) {
          throw compositionError('workspace_sync_child_unavailable', 'The installed target changed during preparation');
        }
        if (targetPreflight?.targetWorkspace && !isDeepStrictEqual(preparedTarget.targetWorkspace, targetPreflight.targetWorkspace)) {
          throw compositionError('workspace_sync_child_unavailable', 'The qualified target Workspace changed during preparation');
        }
        if (physicalTargetEndpoint && bootstrapInput.action.kind === 'copy_once') {
          const target = preparedTarget.targetWorkspace;
          if (!target || preparedTarget.bootstrapOperationId !== prepareRequest.bootstrapOperationId
            || target.id !== preparedTarget.targetWorkspaceRefId || target.serverId !== semanticServerId
            || resolveWorkspaceSyncExecutionMachineIdV1(target) !== physicalTargetEndpoint.machineId) {
            throw compositionError('workspace_sync_child_unavailable', 'The accepted physical target Workspace is unavailable');
          }
          acceptedTargetWorkspace = target;
        }
        targetOwnershipHandles = preparedTarget.ownershipHandles ?? [];
      } catch (error) {
        // The remote owner may have finished preparing before its acknowledgement
        // was lost. Release the known operation even without receiving a receipt;
        // an unknown operation is already an idempotent no-op at that owner.
        try {
          await releaseTarget('abort');
        } catch (cleanupError) {
          factories.warn('Failed to release possible workspace sync target preparation', cleanupError);
        } finally {
          try {
            await releaseSourceOwnership?.();
          } catch (cleanupError) {
            factories.warn('Failed to release workspace sync source custody after preparation failure', cleanupError);
          }
        }
        throw error;
      }
      let released = false;
      let sourceReleased = false;
      return {
        ...(acceptedTargetWorkspace ? { targetWorkspace: acceptedTargetWorkspace } : {}),
        ...(copyOnceBaseline ? { copyOnceBaseline } : {}),
        ...(copyOnceExcludedPaths ? { copyOnceExcludedPaths } : {}),
        ...((sourceOwnership || targetOwnershipHandles.length > 0)
          ? { ownershipHandles: [...(sourceOwnership ? [sourceOwnership] : []), ...targetOwnershipHandles] }
          : {}),
        release: async (reason) => {
          if (released) return;
          try {
            if (reason === 'abort' || bootstrapInput.action.kind === 'copy_once' || bootstrapInput.action.kind === 'create_relationship') {
              await releaseTarget(reason === 'commit'
                  ? bootstrapInput.action.kind === 'copy_once'
                    ? 'copy_committed'
                    : 'relationship_committed'
                  : 'abort');
            }
          } finally {
            if (!sourceReleased) {
              await releaseSourceOwnership?.();
              sourceReleased = true;
            }
          }
          released = true;
        },
      };
    },
    createBroker: async (brokerInput) => await factories.createBroker({
      ...brokerInput,
      peerIdentityValidator: factories.createPeerIdentityValidator(),
    }),
    spawnSidecar: factories.spawnSidecar,
    launchLocalAgent: factories.launchLocalAgent,
    stopRetainedNativeProcesses: factories.stopRetainedNativeProcesses,
    ...(input.openMachineCarrierTunnel || input.createRequesterMachineCarrierTunnel
      ? { openMachineCarrierTunnel: async (request, transferAdmission) => {
          const retained = runtime?.handoffAdapter.resolvePrivateExecution?.({ relationshipId: request.operationId });
          if (retained) {
            if (transferAdmission) await transferAdmission;
            else await admitPrivateTransfer(request.operationId, request.signal);
            const snapshot = retained.execution.getSnapshot?.();
            const relationship = snapshot?.relationships.find(candidate => candidate.relationshipId === request.operationId);
            // Native reconnect outlives the target daemon. Re-enter its existing
            // signed SOURCE preparation to restore exact READY custody first.
            if (relationship?.enabled) {
              await prepareRelationshipTarget(relationship, request.signal, undefined,
                snapshot ? { relationship, workspaceRefs: snapshot.workspaceRefs } : undefined);
            }
            const open = input.createRequesterMachineCarrierTunnel?.({ credentials: retained.execution.credentials,
              accountId: retained.execution.accountRowsCustody.accountId });
            if (!open) throw compositionError('machine_carrier_unavailable', 'Requester Workspace Sync carrier is unavailable');
            return open(request);
          }
          if (!input.openMachineCarrierTunnel) throw compositionError('machine_carrier_unavailable', 'Workspace Sync carrier is unavailable');
          return input.openMachineCarrierTunnel(request);
        } }
      : {}),
    stageConflictResolutionAtTarget: async request => {
      const native = await managedNative(request.relationshipId, request.targetWorkspaceRefId);
      const { signal, ...wire } = request;
      return native ? native.stageConflictResolutionHere(wire, signal) : targetAuthority.stageConflictResolutionAtTarget(request);
    },
    applyStagedConflictResolutionAtTarget: async request => {
      const native = await managedNative(request.relationshipId, request.targetWorkspaceRefId);
      const { signal, ...wire } = request;
      return native ? native.applyStagedConflictResolutionHere(wire, signal) : targetAuthority.applyStagedConflictResolutionAtTarget(request);
    },
    discardStagedConflictResolutionAtTarget: async request => {
      const native = await managedNative(request.relationshipId, request.targetWorkspaceRefId);
      const { signal, ...wire } = request;
      return native ? native.discardStagedConflictResolutionHere(wire, signal) : targetAuthority.discardStagedConflictResolutionAtTarget(request);
    },
    releaseConflictResolutionCaptureAtSource: async request => {
      const relationshipId = request.actionInput.relationshipIds.find(id => {
        const retained = runtime?.handoffAdapter.resolvePrivateExecution?.({ relationshipId: id });
        return retained?.execution.managedTarget && (retained.execution.managedTarget.workspace.id === request.sourceWorkspaceRefId
          || retained.input.sourceWorkspaceRefId === request.sourceWorkspaceRefId && retained.execution.executionIdentity?.kind === 'isolated');
      });
      const native = relationshipId ? await managedNative(relationshipId, request.sourceWorkspaceRefId) : null;
      return native ? native.releaseConflictResolutionCaptureHere(request) : targetAuthority.releaseConflictResolutionCaptureAtSource(request);
    },
    recoverConflictResolutionAtTarget: async request => {
      const retained = runtime?.handoffAdapter.resolvePrivateExecution?.({ relationshipId: request.relationshipId });
      if (retained?.execution.managedTarget) {
        const native = await managedNative(request.relationshipId, request.targetWorkspaceRefId);
        if (native) {
          const { signal, ...wire } = request;
          return native.recoverConflictResolutionHere(wire, signal);
        }
      }
      if (retained?.execution.nativeSync && !retained.execution.managedTarget && request.targetMachineId === input.localMachineId) {
        const localResolutionEndpoint = await runtime!.managedWorkspaceSync.resolveLocalResolutionEndpoint(
          request.relationshipId, request.targetWorkspaceRefId,
        );
        return retained.execution.nativeSync.recoverConflictResolutionHere({
          relationshipId: request.relationshipId, targetMachineId: request.targetMachineId,
          targetWorkspaceRefId: request.targetWorkspaceRefId,
        }, request.signal, { localResolutionEndpoint });
      }
      if (retained?.execution.executionIdentity?.kind === 'isolated' && request.targetMachineId === input.localMachineId) {
        throw compositionError('agent_isolation_unavailable', 'The captured native Sync member is unavailable');
      }
      if (retained) {
        const wireRequest = WorkspaceSyncTargetConflictRecoverV1Schema.parse({
          relationshipId: request.relationshipId, targetMachineId: request.targetMachineId,
          targetWorkspaceRefId: request.targetWorkspaceRefId,
        });
        if (request.targetMachineId === input.localMachineId) {
          const localResolutionEndpoint = await runtime!.managedWorkspaceSync.resolveLocalResolutionEndpoint(
            request.relationshipId, request.targetWorkspaceRefId,
          );
          if (!localResolutionEndpoint || !retained.execution.getSnapshot) {
            throw compositionError('relationship_not_ready', 'The captured Sync source root is unavailable');
          }
          return targetAuthority.recoverConflictResolutionHere(wireRequest, request.signal, {
            localResolutionEndpoint, getProjectSnapshot: retained.execution.getSnapshot,
          });
        }
        logger.debug('[Workspace Sync] Recovery dispatch', {
          workspaceSyncRecoverySender: retained.execution.recoverConflictResolutionAtTarget ? 'retained_preparation' : 'restored_source',
        });
        if (retained.execution.recoverConflictResolutionAtTarget) {
          return retained.execution.recoverConflictResolutionAtTarget(wireRequest, request.signal);
        }
        return WorkspaceSyncTargetConflictRecoverResultV1Schema.parse(readMachineActionRpcResult(await callExactMachineRpc({
          credentials: retained.execution.credentials, serverUrl: retained.execution.accountRowsCustody.serverHttpBaseUrl,
          machineId: request.targetMachineId, method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_RECOVER,
          request: wireRequest, timeoutMs: null, ...(request.signal ? { signal: request.signal } : {}),
        })));
      }
      logger.debug('[Workspace Sync] Recovery dispatch', { workspaceSyncRecoverySender: 'target_authority' });
      return targetAuthority.recoverConflictResolutionAtTarget(request);
    },
    readFileAtTarget: async request => {
      const native = await managedNative(request.relationshipId, request.targetWorkspaceRefId);
      return native ? native.readFileHere({ relationshipId: request.relationshipId, workspaceRefId: request.targetWorkspaceRefId,
        path: request.path, maxBytes: request.maxBytes, ...(request.expectedDigest === undefined ? {} : { expectedDigest: request.expectedDigest }) }, request.signal) : targetAuthority.readFileAtTarget(request);
    },
    observeEntryAtTarget: async request => {
      const native = await managedNative(request.relationshipId, request.targetWorkspaceRefId);
      return native ? native.observeEntryHere({ relationshipId: request.relationshipId, workspaceRefId: request.targetWorkspaceRefId,
        path: request.path }, request.signal) : targetAuthority.observeEntryAtTarget(request);
    },
    assertConflictResolutionAuthorized,
    getProjectSnapshot: factories.getProjectSnapshot,
    onEngineReadinessPublished: publishReadiness,
    ...(input.onStatusPublished ? { onStatusPublished: input.onStatusPublished } : {}),
  });

  const createInstalledRelationshipOwner = (retirementContext?: RpcHandlerContext) => factories.createRelationshipOwner({
    localMachineId: input.localMachineId,
    observeRelationshipTarget: async (relationship, target) => {
      const result = await targetAuthority.previewCommittedCopyAtTarget({ kind: 'preview',
        workspace: { serverId: semanticServerId, refId: relationship.alphaWorkspaceRefId },
        machineId: relationship.controllerMachineId, expectedRelationship: relationship,
        targetMachineId: resolveWorkspaceSyncExecutionMachineIdV1(target), targetWorkspaceRefId: target.id });
      return result.ok ? 'present' : 'absent';
    },
    mutateProjectSnapshot: createProjectAccountSnapshotMutation({ credentials: input.credentials, serverId: localProfileId }),
    readProjectSnapshot: refreshInstalledProjectRows,
    ensureRelationship: async (relationship, signal, preparation) => {
      if (!runtime) throw controllerUnavailable();
      return await runtime.managedWorkspaceSync.ensure(relationship, signal, preparation);
    },
    flushRelationship: async (relationshipId, signal) => {
      if (!runtime) throw controllerUnavailable();
      return await runtime.managedWorkspaceSync.flush(relationshipId, signal);
    },
    commitRelationshipTarget: async (relationship) => {
      const target = resolveRelationshipBootstrapTarget(factories.getProjectSnapshot(), relationship, semanticServerId);
      await targetAuthority.releaseBootstrapAtTarget({
        v: 1,
        bootstrapOperationId: relationship.relationshipId,
        targetWorkspaceRefId: target.workspaceRefId,
        targetMachineId: target.machineId,
        reason: 'relationship_committed',
      });
    },
    terminateRelationshipRuntime: async (relationship) => {
      if (!runtime) throw controllerUnavailable();
      await runtime.managedWorkspaceSync.terminate(relationship.relationshipId);
      const target = resolveRelationshipBootstrapTarget(factories.getProjectSnapshot(), relationship, semanticServerId);
      await targetAuthority.releaseBootstrapAtTarget({
        v: 1,
        bootstrapOperationId: relationship.relationshipId,
        targetWorkspaceRefId: target.workspaceRefId,
        targetMachineId: target.machineId,
        reason: 'abort',
      });
    },
    waitForProjectReconciliation: async (graphRevision, signal) => {
      if (!runtime) throw controllerUnavailable();
      signal?.throwIfAborted();
      const snapshot = factories.getProjectSnapshot();
      await runtime.whenProjectsSettled({
        graphRevision: graphRevision < 0 ? 'absent' : graphRevision,
        ...(snapshot?.scopeKey ? { scopeKey: snapshot.scopeKey } : {}),
        ...(signal ? { signal } : {}),
      });
    },
    readRelationshipDependencies: relationshipDependencyReader(input.credentials),
    inspectCommittedRelationshipTarget: async (relationship, _removal, signal, approval) => committedCopyPhase(relationship, 'inspect', approval, signal, retirementContext),
    removeCommittedRelationshipTarget: async (relationship, _removal, signal, approval) => committedCopyPhase(relationship, 'remove', approval, signal, retirementContext),
  });
  relationshipOwner = createInstalledRelationshipOwner();

  let authorityTail = Promise.resolve();
  const privateRecovery = recoverPrivateExecutions().catch(() => {
    factories.warn('[DAEMON RUN] Private Workspace Sync recovery is unavailable', { code: 'workspace_sync_unavailable' });
  });
  const reconcileAuthority = (): void => {
    authorityTail = authorityTail
      .catch(() => undefined)
      .then(async () => {
        // Durable requester identity is recovered before the installed Account
        // graph supplies ordinary lazy native captures for those same links.
        await privateRecovery;
        const snapshot = factories.getProjectSnapshot();
        if (snapshot) await recoverManagedRelationships(snapshot);
        await targetAuthority.reconcileRetainedBootstraps();
      });
    void authorityTail.catch((error) => {
      factories.warn('[DAEMON RUN] Failed to reconcile workspace sync target bootstrap ownership', error);
    });
  };
  const unsubscribe = factories.subscribeProjectSnapshot(() => reconcileAuthority());
  reconcileAuthority();
  const startup = privateRecovery.then(async () => {
    await runtime.start().catch((error) => {
      publishReadiness({ state: 'unavailable', errorCode: 'engine_unavailable' });
      factories.warn(
        '[DAEMON RUN] Workspace sync engine is initially unavailable; commands and settings changes may retry it',
        error,
      );
    });
  });

  const committedRelationshipOwner = relationshipOwner;
  const installedRelationshipLifecycleOwner = (relationshipId: string) => {
    const retained = runtime.handoffAdapter.resolvePrivateExecution?.({ relationshipId });
    // An installed Account can create through requester custody too. Its
    // lifecycle must update that retained projection as well as the Account
    // rows, just like the retained handoff owner does.
    return retained
      && retained.execution.accountRowsCustody.accountId === readAccountIdFromToken(input.credentials.token)
      && retained.execution.accountRowsCustody.serverId === semanticServerId
      ? requesterRelationshipOwner(retained) : committedRelationshipOwner;
  };
  const relationshipCreateDependencies: WorkspaceSyncRelationshipCreateDependencies = {
    localServerId: semanticServerId,
    localMachineId: input.localMachineId,
    resolveWorkspaceRef: (workspaceRefId) => {
      return resolveWorkspaceRefById(
        factories.getProjectSnapshot()?.workspaceRefs ?? [],
        workspaceRefId,
        semanticServerId,
      );
    },
    relationshipOwner: committedRelationshipOwner,
  };

  const requesterAvailability = async (context?: RpcHandlerContext): Promise<WorkspaceSyncRequesterAvailabilityV1> => {
    if (!context || context.signal.aborted) return { kind: 'unavailable', reason: 'requester_authority_unavailable' };
    const identity = selectRequesterIdentity(context);
    if (identity.kind === 'unknown') return { kind: 'unavailable', reason: 'requester_authority_unavailable' };
    const memberRequester = resolveHostRequesterAgentExecutionIdentity(identity);
    if (context.machineAdmission && requiresRequesterWorkspaceCapture(context.machineAdmission)) {
      if (memberRequester.kind !== 'isolated' || !input.agentIsolation?.readMember || resolveHostRequesterAgentPlacementForHost({
        identity: memberRequester, snapshot: input.agentIsolation.read() }) !== 'member') return { kind: 'unavailable', reason: 'agent_isolation_unavailable' };
      try {
        const member = await readAgentIsolationMemberDirectories(input.agentIsolation, { requesterIdentity: { ...memberRequester,
          homeServerIdentityId: semanticServerId }, rpcContext: context, signal: context.signal });
        return { kind: 'available', homeDir: member.home, workspaceRoot: member.workspaceRoot,
          ...(member.preparation ? { preparation: member.preparation } : {}) };
      } catch { return { kind: 'unavailable', reason: 'agent_isolation_unavailable' }; }
    }
    if (!isHostRequesterUnrestrictedOwner(identity)) return { kind: 'unavailable', reason: 'agent_isolation_unavailable' };
    return { kind: 'available', homeDir: resolveMachineRpcWorkingDirectory(), workspaceRoot: null };
  };
  const createRequesterRelationship = async (request: WorkspaceSyncRelationshipCreateRpcRequestV1,
    context: RpcHandlerContext, signal = context.signal, admittedSnapshot?: ActiveProjectAccountRowsSnapshot | null) => {
    const requester = readRequesterAccountActionContext(context.callerInputAuthorization);
    const admission = context.machineAdmission;
    if (!requester?.retainCustody || !admission) {
      throw compositionError('project_requester_authority_unavailable', 'Requester Sync custody is unavailable');
    }
    const existingCapture = runtime!.handoffAdapter.resolvePrivateExecution?.({ operationId: request.operationId });
    if (existingCapture) {
      if (existingCapture.execution.accountRowsCustody.accountId !== admission.actorAccountId
        || existingCapture.execution.accountRowsCustody.serverId !== semanticServerId) {
        throw compositionError('relationship_not_owned', 'The Sync operation belongs to another requester');
      }
      return await createWorkspaceSyncRelationshipForProject({ localServerId: semanticServerId, localMachineId: input.localMachineId,
        resolveWorkspaceRef: id => resolveWorkspaceRefById(existingCapture.execution.getSnapshot?.()?.workspaceRefs ?? [], id, semanticServerId),
        relationshipOwner: requesterRelationshipOwner(existingCapture),
        ...(existingCapture.input.targetWorkspaceRefId ? { targetWorkspaceRefId: existingCapture.input.targetWorkspaceRefId } : {}) }, request, signal);
    }
    const selected = selectRequesterIdentity(context);
    const executionIdentity = resolveHostRequesterAgentExecutionIdentity(selected);
    if (executionIdentity.kind !== 'isolated') {
      throw compositionError('agent_isolation_unavailable', 'Requester native Sync execution is unavailable');
    }
    // The shared capture decider, not Agent placement: the custodian and Manage keep native placement.
    const member = requiresRequesterWorkspaceCapture(admission);
    if (member && (!input.privateCheckout || resolveHostRequesterAgentPlacementForHost({ identity: executionIdentity,
      snapshot: input.agentIsolation?.read() }) !== 'member')) {
      throw compositionError('agent_isolation_unavailable', 'Requester native Sync execution is unavailable');
    }
    const custody = requester.retainCustody();
    const accountRowsCustody = { serverId: semanticServerId, accountId: admission.actorAccountId,
      serverHttpBaseUrl: requester.serverHttpBaseUrl, isCurrent: custody.isCurrent };
    let checkout: Awaited<ReturnType<typeof preparePrivateProjectOpenCheckout>> | undefined;
    let retained = false;
    let captured = false;
    try {
      let snapshot = admittedSnapshot ?? await factories.refreshProjectRows({ credentials: requester.credentials, sessionCustody: accountRowsCustody,
        serverId: semanticServerId, selection: { kinds: ['workspace-ref', 'relationship-graph'] }, signal });
      const source = resolveWorkspaceRefById(snapshot.workspaceRefs, request.actionInput.sourceWorkspaceRefId, semanticServerId);
      if (!source || isManagedWorkspaceRefV2(source) || source.machineId !== input.localMachineId) {
        throw compositionError('workspace_ref_not_ready', 'The requester source Workspace is unavailable');
      }
      const action = { kind: 'create_relationship' as const, mode: request.actionInput.mode,
        contentPolicy: request.actionInput.contentPolicy, flushBeforeCommit: true as const };
      const localTarget = request.actionInput.targetMachineId === input.localMachineId;
      let targetPhaseContext = context;
      {
        const authorization = context.callerInputAuthorization;
        const binding = authorization?.binding;
        const envelope = context.originalActionEnvelope ?? (binding ? { v: 1 as const,
          requestId: binding.requestId, target: binding.target, input: request.actionInput } : undefined);
        if (!authorization || !binding || !envelope || !isWorkspaceSyncRelationshipWriteActionId(binding.actionId)
          || !isExternalActionAuthorizationBoundToEnvelope(binding, {
            actionId: binding.actionId, machineId: input.localMachineId, envelope })) {
          throw compositionError('project_requester_authority_unavailable', 'The original Sync requester is unavailable');
        }
        let originalInput: unknown = envelope.v === 1 ? envelope.input : undefined;
        if (envelope.v === 2) {
          const encryption = await requester.resolveEncryption(signal);
          if (encryption?.serverIdentityId === semanticServerId) originalInput = openExternalActionRequestV2({
            projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, material: encryption.material,
            binding: { serverIdentityId: binding.serverIdentityId, accountId: binding.accountId, actionId: binding.actionId,
              requestId: binding.requestId, target: binding.target,
              ...('authentication' in binding ? { authentication: { kind: binding.authentication.kind,
                tokenEpoch: binding.authentication.tokenEpoch } } : { credentialId: binding.credentialId }) } })?.input;
        }
        const originalActionInput = getActionSpec(binding.actionId).inputSchema.safeParse(originalInput);
        if (!originalActionInput.success || !sameStrictJsonValue(originalActionInput.data, request.actionInput, { omitUndefinedObjectMembers: true })) {
          throw compositionError('project_requester_authority_unavailable', 'The original Sync input is unavailable');
        }
        const requestedTargetReplacementApproval = request.targetReplacementApproval;
        if (requestedTargetReplacementApproval) {
          const privateContext = context.localActionContext;
          const nativeApproval = privateContext?.presentUserApproval;
          const nativeTargetApproval = privateContext?.handoffTargetReplacementApproval;
          const nativeAdmitted = nativeApproval?.actionId === binding.actionId
            && nativeApproval.requestId === request.operationId
            && nativeApproval.decidingAccountId === admission.actorAccountId
            && nativeApproval.inputDigest === computeActionInputApprovalDigestV1(binding.actionId, request.actionInput)
            && nativeTargetApproval != null
            && sameHandoffTargetReplacementApproval(nativeTargetApproval, requestedTargetReplacementApproval);
          if (!nativeAdmitted && !request.targetReplacementApprovalReceiptId) {
            throw compositionError('approval_stale', 'Workspace target replacement approval has no admitted Action');
          }
          // The admitted requester owns the persisted receipt. TARGET receives
          // this decision through the existing signed SOURCE invocation.
          if (!nativeAdmitted && request.targetReplacementApprovalReceiptId) {
            const approvals = createCliApprovalsArtifactStore({ credentials: requester.credentials,
              serverId: localProfileId, serverHttpBaseUrl: requester.serverHttpBaseUrl,
              operationContext: requester.savedSecretOperationContext,
              getAccountEncryptionMode: async () => requester.accountEncryptionCurrentness.mode });
            await requireExecutingWorkspaceActionReceipt({ approvalsGet: approvals.approvalsGet,
              expectedExecutionAccountId: admission.actorAccountId,
              serverId: localProfileId, actionReceiptId: request.targetReplacementApprovalReceiptId,
              actionId: binding.actionId, actionInput: request.actionInput,
              expectedExecutionMachineId: source.machineId, expectedExecutionRequestId: request.operationId,
              expectedTargetReplacementApproval: requestedTargetReplacementApproval });
          }
        }
        if (input.callWorkspaceTargetPhase) targetPhaseContext = { ...context, workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1Schema.parse({
          v: 1, phase: 'prepare', operationId: request.operationId, accountServerId: semanticServerId,
          sourceMachineId: source.machineId, sourceRootPath: source.rootPath, originalActionEnvelope: envelope,
          sourceContext: projectWorkspaceSyncPhysicalContextFromActionContext(buildActionExecutorContextForRpc(context)) }) };
      }
      const localRoot = localTarget ? request.actionInput.targetPath : source.rootPath;
      const existing = resolveWorkspaceRefForMachineRoot(snapshot.workspaceRefs,
        { serverId: semanticServerId, machineId: input.localMachineId, rootPath: localRoot });
      if (member) checkout = await preparePrivateProjectOpenCheckout({ runtime: input.privateCheckout!, requesterAccount: requester,
        retainedRequesterCustody: custody, ingress: context, requesterIdentity: executionIdentity,
        request: { serverId: semanticServerId, machineId: input.localMachineId,
          source: { kind: 'workspace', workspaceId: source.id },
          materialization: { kind: 'sync', targetPath: localRoot, workspaceAction: action } },
        workspaceRefs: snapshot.workspaceRefs, ...(existing ? { existingWorkspaceRefId: existing.id } : {}),
        materializationKey: request.operationId, signal, onEffectsIssued: () => {} });
      const native = checkout;
      const targetWorkspaceRefId = localTarget ? native?.prepared.workspaceRefId ?? existing?.id : undefined;
      const relationshipId = deriveWorkspaceSyncRelationshipId(request.operationId);
      if (factories.getProjectSnapshot()?.relationships.some(value => value.relationshipId === relationshipId)
        || runtime!.handoffAdapter.listPrivateExecutions?.().some(value => value.relationshipId === relationshipId
          && value.execution.accountRowsCustody.accountId !== admission.actorAccountId)) {
        throw compositionError('relationship_not_owned', 'The Sync relationship identity is already owned');
      }
      const captureInput = { operationId: request.operationId,
        accountServerId: semanticServerId, sourceMachineId: source.machineId, sourceWorkspaceRefId: source.id,
        sourceRootPath: source.rootPath, targetMachineId: request.actionInput.targetMachineId,
        targetRootPath: request.actionInput.targetPath, ...(targetWorkspaceRefId ? { targetWorkspaceRefId } : {}), action, signal };
      let preparedTarget: Readonly<{ endpoint?: MachineInstallationPublicIdentityV1;
        operationId: string; machineId: string; workspaceRefId: string }> | undefined;
      const bindRetainedRelationship = (id: string) => {
        // The create Action's request lifetime ends here. Later signed
        // preparation belongs to the retained relationship's SOURCE custody.
        const boundary = input.requesterMachineAdmissionBoundary;
        targetPhaseContext = { ...targetPhaseContext, verifyMachineAdmissionCurrent: async () => {
          if (!boundary) return false;
          const verifyCurrent = native ? verifyWorkspaceSyncRelationshipMachineAdmissionCurrent : verifyWorkspaceSyncSourceMachineAdmissionCurrent;
          return await verifyCurrent({ credentials: requester.credentials,
            sessionId: id, attribution: executionIdentity.requester, serverHttpBaseUrl: requester.serverHttpBaseUrl,
            boundary });
        } };
        retained = true;
      };
      const execution: WorkspaceSyncPrivateExecution = {
        credentials: requester.credentials, accountRowsCustody,
        getSnapshot: () => snapshot,
        replaceSnapshot: async next => { snapshot = next; },
        ...(input.callWorkspaceTargetPhase ? { callTargetPhase: async descriptor => {
          if (isWorkspaceSyncSourceWriterCleanupPhaseV1(descriptor.routing.phase) && preparedTarget?.endpoint && targetPhaseContext.workspaceSyncSourceRouting) {
            return input.callWorkspaceTargetPhase!({ ...descriptor, physicalEndpoint: preparedTarget.endpoint },
              { ...createInstalledTargetCleanupContext(targetPhaseContext.workspaceSyncSourceRouting,
                { machineId: input.localMachineId, installationId: admission.installationId }, descriptor.routing),
                ...(descriptor.operationContext ? { localActionContext: descriptor.operationContext } : {}),
                ...(descriptor.callerInputAuthorization ? { callerInputAuthorization: descriptor.callerInputAuthorization } : {}) });
          }
          if (descriptor.method !== RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE) {
            return input.callWorkspaceTargetPhase!(descriptor, { ...targetPhaseContext,
              ...(descriptor.operationContext ? { localActionContext: descriptor.operationContext } : {}) });
          }
          const prepare = WorkspaceSyncTargetBootstrapPrepareV1Schema.parse(descriptor.request);
          const relationship = prepare.transientRelationship;
          const currentSnapshot = runtime!.handoffAdapter.resolvePrivateExecution?.({ operationId: request.operationId })
            ?.execution.getSnapshot?.();
          const persisted = currentSnapshot?.relationships.find(candidate => candidate.relationshipId === prepare.bootstrapOperationId);
          if (!relationship || !persisted || !areWorkspaceSyncRelationshipDefinitionsEqual(persisted, relationship)
            || !areWorkspaceSyncWorkerCopyProvenancesEqual(persisted, relationship)) {
            throw compositionError('relationship_not_ready', 'The requester relationship has not been staged');
          }
          // Preserve the SOURCE's acknowledged worker-copy provenance in the
          // signed transient body; TARGET has no access to this Account graph.
          if (getWorkspaceSyncWorkerCopyV1(relationship)
            && (!currentSnapshot || !resolvePersistedWorkerCopyCreation(currentSnapshot, relationship, source.id,
              prepare.targetWorkspaceRefId, semanticServerId))) {
            throw compositionError('relationship_not_ready', 'The requester worker-copy creation is unavailable');
          }
          const result = await input.callWorkspaceTargetPhase!({ ...descriptor,
            request: { ...prepare, transientRelationship: { ...persisted, enabled: relationship.enabled } } }, targetPhaseContext);
          const ready = WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse(result);
          if (ready.bootstrapOperationId !== prepare.bootstrapOperationId) {
            throw compositionError('relationship_not_ready', 'The prepared Sync target operation changed');
          }
          preparedTarget = { operationId: ready.bootstrapOperationId, machineId: descriptor.machineId,
            workspaceRefId: ready.targetWorkspaceRefId, ...(ready.physicalEndpoint ? { endpoint: ready.physicalEndpoint } : {}) };
          return result;
        } } : {}),
        recoverConflictResolutionAtTarget: async (recover, recoverySignal) => {
          recoverySignal?.throwIfAborted();
          if (!preparedTarget || preparedTarget.operationId !== recover.relationshipId
            || preparedTarget.machineId !== recover.targetMachineId || preparedTarget.workspaceRefId !== recover.targetWorkspaceRefId) {
            throw compositionError('relationship_not_ready', 'The admitted Sync target has not acknowledged recovery');
          }
          return { status: 'settled' };
        },
        assertTransferCurrent: async () => {
          if (!await custody.isCurrent()) throw compositionError('project_requester_authority_unavailable', 'Requester Sync custody is unavailable');
        },
        retainRelationship: async id => {
          // A member capture retains through the shared capture owner below.
          await createWorkspaceSyncSourceCredentialCustody({ happyHomeDir: input.happyHomeDir, relationshipId: id,
            attribution: { ...executionIdentity.requester, serverId: localProfileId }, credentials: requester.credentials,
            homeServerIdentityId: semanticServerId,
            machineAdmission: { custodianAccountId: admission.custodianAccountId, role: admission.role } });
          bindRetainedRelationship(id);
        },
        release: async () => { try { await native?.release(); } finally { await custody.release(); } },
      };
      if (native) await retainPrivateSyncCapture({ adapter: runtime!.handoffAdapter, checkout: native, syncInput: captureInput,
        context, snapshot, credentials: requester.credentials, executionIdentity, accountRowsCustody,
        relationshipCustody: { happyHomeDir: input.happyHomeDir, homeServerIdentityId: semanticServerId,
          machineAdmission: { custodianAccountId: admission.custodianAccountId, role: admission.role } },
        execution: { getSnapshot: execution.getSnapshot, replaceSnapshot: execution.replaceSnapshot,
          ...(execution.callTargetPhase ? { callTargetPhase: execution.callTargetPhase } : {}),
          recoverConflictResolutionAtTarget: execution.recoverConflictResolutionAtTarget },
        assertTransferCurrent: execution.assertTransferCurrent,
        onRelationshipRetained: bindRetainedRelationship, release: execution.release });
      else runtime!.handoffAdapter.retainPrivateExecution!({ input: captureInput, execution });
      captured = true;
      const capture = runtime!.handoffAdapter.resolvePrivateExecution?.({ operationId: request.operationId });
      if (!capture) throw compositionError('project_requester_authority_unavailable', 'Requester Sync capture is unavailable');
      return await createWorkspaceSyncRelationshipForProject({ localServerId: semanticServerId, localMachineId: input.localMachineId,
        resolveWorkspaceRef: id => resolveWorkspaceRefById(capture.execution.getSnapshot?.()?.workspaceRefs ?? [], id, semanticServerId),
        relationshipOwner: requesterRelationshipOwner(capture), ...(targetWorkspaceRefId ? { targetWorkspaceRefId } : {}) }, request, signal);
    } finally {
      if (!retained) {
        if (captured) await runtime!.handoffAdapter.releasePrivateExecution?.(request.operationId);
        else { try { await checkout?.dispose(); } finally { await custody.release(); } }
      }
    }
  };
  const readRequesterProjectSnapshot = async (context?: RpcHandlerContext) => {
    const requester = readRequesterAccountActionContext(context?.callerInputAuthorization);
    const accountId = context?.machineAdmission?.actorAccountId;
    if (!requester || !accountId) return null;
    if (context?.callerInputAuthorization?.binding.accountId !== accountId) {
      throw compositionError('project_requester_authority_unavailable', 'Requester Account admission changed');
    }
    return factories.refreshProjectRows({ credentials: requester.credentials,
      sessionCustody: { serverId: semanticServerId, accountId, serverHttpBaseUrl: requester.serverHttpBaseUrl,
        isCurrent: requester.isCustodyCurrent ?? requester.isCurrent },
      serverId: semanticServerId, selection: { kinds: ['workspace-ref', 'relationship-graph'] }, signal: context?.signal });
  };
  /** Handoff TARGET capture for a requester without Manage (owner ruling 2026-11-15). The
   * capture is the Project Open/requester-create capture owner, keyed by the handoff's
   * workspace operation. The SOURCE's terminal call releases it; a newer capture of
   * the same Session from the same person replaces an abandoned one; a daemon
   * restart drops it with the rest of the in-memory captures. */
  const captureHandoffWorkspace = async (request: SessionHandoffWorkspaceCaptureRequestV3,
    context: RpcHandlerContext): Promise<SessionHandoffWorkspaceCaptureResultV3> => {
    const admission = context.machineAdmission;
    const refused = (errorCode: string, error: string) => ({ ok: false as const, errorCode, error });
    if (!admission || request.targetMachineId !== input.localMachineId) return refused('target_unavailable', 'The handoff target is unavailable');
    const owned = (capture: RetainedWorkspaceSyncPrivateExecution) =>
      capture.execution.accountRowsCustody.accountId === admission.actorAccountId;
    // A Sync link the handoff created takes the capture's native lifetime, as in Project Open.
    const linked = (capture: RetainedWorkspaceSyncPrivateExecution) =>
      capture.input.action.kind === 'create_relationship' && capture.relationshipId !== undefined;
    if (request.release) {
      const capture = runtime!.handoffAdapter.resolvePrivateExecution?.({ operationId: request.operationId });
      if (capture && owned(capture)) {
        if (linked(capture)) await capture.bindRelationship?.(capture.relationshipId!, 'relationship');
        else await runtime!.handoffAdapter.releasePrivateExecution?.(request.operationId);
      }
      return { ok: true, capture: 'released' };
    }
    if (!requiresRequesterWorkspaceCapture(admission)) return { ok: true, capture: 'not_required' };
    const required = () => { const refusal = requesterWorkspaceCaptureRequired(); return refused(refusal.errorCode!, refusal.error); };
    const requester = readRequesterAccountActionContext(context.callerInputAuthorization);
    const bootstrap = context.requesterSessionBootstrap;
    if (!bootstrap || !requester?.retainCustody || request.accountServerId !== semanticServerId) {
      return refused('project_requester_authority_unavailable', 'Requester Sync custody is unavailable');
    }
    const executionIdentity = resolveHostRequesterAgentExecutionIdentity(selectRequesterIdentity(context));
    if (executionIdentity.kind !== 'isolated' || !input.privateCheckout
      || resolveHostRequesterAgentPlacementForHost({ identity: executionIdentity, snapshot: input.agentIsolation?.read() }) !== 'member') {
      return required();
    }
    for (const abandoned of runtime!.handoffAdapter.listPrivateExecutions?.() ?? []) {
      if (owned(abandoned) && !linked(abandoned) && abandoned.input.sourceSessionId === request.sessionId
        && abandoned.input.targetMachineId === input.localMachineId) {
        await runtime!.handoffAdapter.releasePrivateExecution?.(abandoned.input.operationId);
      }
    }
    if (runtime!.handoffAdapter.resolvePrivateExecution?.({ operationId: request.operationId })) {
      return refused('workspace_sync_operation_conflict', 'Workspace sync operation identity is already in use');
    }
    const custody = requester.retainCustody();
    const accountRowsCustody = { serverId: semanticServerId, accountId: admission.actorAccountId,
      serverHttpBaseUrl: requester.serverHttpBaseUrl, isCurrent: custody.isCurrent };
    // The capture outlives this call; the request signal only cancels its preparation.
    const lifetime = new AbortController();
    const cancel = () => lifetime.abort(context.signal.reason);
    context.signal.addEventListener('abort', cancel, { once: true });
    let checkout: Awaited<ReturnType<typeof preparePrivateProjectOpenCheckout>> | undefined;
    let captured = false;
    try {
      let snapshot = await factories.refreshProjectRows({ credentials: requester.credentials, sessionCustody: accountRowsCustody,
        serverId: semanticServerId, selection: { kinds: ['workspace-ref', 'relationship-graph'] }, signal: lifetime.signal });
      // Both endpoint rows are persisted below with the requester's own
      // credentials, after the capture reserved the member target.
      const sourceRefs = materializeWorkspaceRefForMachineRoot(snapshot.workspaceRefs, { serverId: semanticServerId,
        machineId: request.sourceMachineId, rootPath: request.sourceRootPath, nowMs: Date.now(), createId: randomUUID });
      const source = sourceRefs.workspaceRef;
      const existing = resolveWorkspaceRefForMachineRoot(snapshot.workspaceRefs,
        { serverId: semanticServerId, machineId: input.localMachineId, rootPath: request.targetPath });
      // The checkout owner refuses any path outside the member's own folder with its one typed code.
      checkout = await preparePrivateProjectOpenCheckout({ runtime: input.privateCheckout, requesterAccount: requester,
          retainedRequesterCustody: custody, ingress: context, requesterIdentity: executionIdentity,
          request: { serverId: semanticServerId, machineId: input.localMachineId,
            source: { kind: 'workspace', workspaceId: source.id },
            materialization: { kind: 'sync', targetPath: request.targetPath, workspaceAction: request.workspaceAction } },
          workspaceRefs: sourceRefs.workspaceRefs, ...(existing ? { existingWorkspaceRefId: existing.id } : {}),
          materializationKey: request.operationId, signal: lifetime.signal, onEffectsIssued: () => {} });
      const native = checkout;
      snapshot = { ...snapshot, workspaceRefs: materializeWorkspaceRefForMachineRoot(sourceRefs.workspaceRefs, { serverId: semanticServerId,
        machineId: input.localMachineId, rootPath: native.prepared.rootPath, nowMs: Date.now(),
        createId: () => native.prepared.workspaceRefId }).workspaceRefs };
      await retainPrivateSyncCapture({ adapter: runtime!.handoffAdapter, checkout: native,
        syncInput: { operationId: request.operationId, accountServerId: semanticServerId, sourceSessionId: request.sessionId,
          action: request.workspaceAction, sourceMachineId: source.machineId, sourceWorkspaceRefId: source.id,
          sourceRootPath: source.rootPath, targetMachineId: input.localMachineId,
          targetWorkspaceRefId: native.prepared.workspaceRefId, targetRootPath: native.prepared.rootPath },
        context, snapshot, credentials: requester.credentials, executionIdentity, accountRowsCustody,
        relationshipCustody: { happyHomeDir: input.happyHomeDir, homeServerIdentityId: semanticServerId,
          machineAdmission: { custodianAccountId: admission.custodianAccountId, role: admission.role } },
        execution: { getSnapshot: () => snapshot, replaceSnapshot: async next => { snapshot = next; } },
        assertTransferCurrent: async () => {
          if (!await custody.isCurrent()) throw compositionError('project_requester_authority_unavailable', 'Requester Sync custody is unavailable');
        },
        release: async () => {
          try { await native.release(); } finally {
            lifetime.abort();
            try { await custody.release(); } finally { await bootstrap.dispose(); }
          }
        } });
      captured = true;
      const capture = runtime!.handoffAdapter.resolvePrivateExecution?.({ operationId: request.operationId });
      if (!capture) return refused('project_requester_authority_unavailable', 'Requester Sync capture is unavailable');
      try {
        await requesterRelationshipOwner(capture).materializeEndpoints({ serverId: semanticServerId,
          sourceMachineId: source.machineId, sourceRootPath: source.rootPath, sourceWorkspaceRefId: source.id,
          targetMachineId: input.localMachineId, targetRootPath: native.prepared.rootPath,
          targetWorkspaceRefId: native.prepared.workspaceRefId, signal: lifetime.signal });
      } catch (error) {
        await runtime!.handoffAdapter.releasePrivateExecution?.(request.operationId);
        throw error;
      }
      return { ok: true, capture: 'member', sourceWorkspaceRefId: source.id,
        targetRootPath: native.prepared.rootPath, targetWorkspaceRefId: native.prepared.workspaceRefId };
    } finally {
      context.signal.removeEventListener('abort', cancel);
      if (!captured) {
        lifetime.abort();
        try { await checkout?.dispose(); } finally { await custody.release(); }
      }
    }
  };
  const materializeManagedProjectTarget = async (request: OpenProjectInputV1, context: RpcHandlerContext): Promise<OpenProjectResultV1> => {
    const materialization = request.materialization;
    if (materialization.kind !== 'sync' || !materialization.targetManaged || !input.callWorkspaceProjectSource) {
      return { kind: 'refused', code: 'workspace_sync_unavailable' };
    }
    const destination = materialization.targetManaged;
    const retained = runtime!.handoffAdapter.listPrivateExecutions?.().find(candidate => {
      const target = candidate.execution.managedTarget?.workspace;
      return target && requesterOwnsPrivateExecution(candidate.execution, context)
        && target.managedId === destination.managedId && isDeepStrictEqual(target.controller, destination.controller)
        && target.rootPath === materialization.targetPath;
    });
    const target = retained?.execution.managedTarget;
    const selected = request.source.kind === 'workspace' ? request.source : undefined;
    const source = selected && retained?.execution.getSnapshot?.()?.workspaceRefs.find(ref => ref.id === selected.workspaceId);
    if (!retained || !target || !selected?.checkout || !source || isManagedWorkspaceRefV2(source)
      || source.id !== retained.input.sourceWorkspaceRefId || source.serverId !== request.serverId
      || source.machineId !== selected.checkout.machineId || source.rootPath !== selected.checkout.rootPath) {
      return { kind: 'refused', code: 'project_requester_authority_unavailable' };
    }
    const operationId = context.callerInputAuthorization?.binding.requestId;
    if (!operationId) return { kind: 'refused', code: 'project_requester_authority_unavailable' };
    const action = materialization.workspaceAction;
    if (action.kind === 'create_relationship' || action.kind === 'relationship') {
      await runtime!.handoffAdapter.bindPrivateExecutionRelationship?.(retained.input.operationId,
        action.kind === 'relationship' ? action.relationshipId : deriveWorkspaceSyncRelationshipId(operationId));
    }
    retained.execution.bindTargetPhaseContext?.(context);
    const result = await input.callWorkspaceProjectSource({ machineId: source.machineId, operationId,
      sourceWorkspace: source, credentials: retained.execution.credentials, request }, context);
    if (result.kind !== 'materialized') return result;
    const { native } = await target.open();
    const checkout = await native.inspectCheckout(request.subdir);
    const workspace = target.workspace;
    return OpenProjectResultV1Schema.parse({ kind: 'opened', workspace: {
      v: 2, kind: 'managed', serverId: workspace.serverId, workspaceId: workspace.id,
      managedId: workspace.managedId, controller: workspace.controller, rootPath: checkout.rootPath,
    }, directory: checkout.directory, setup: 'notRequired',
    ...(result.copyOnceBaseline ? { copyOnceBaseline: result.copyOnceBaseline } : {}),
    ...(result.copyOnceExcludedPaths ? { copyOnceExcludedPaths: result.copyOnceExcludedPaths } : {}) });
  };
  const captureSessionWorkspaceReturn: NonNullable<MachineWorkspaceSyncRpcService['captureSessionWorkspaceReturn']> = async (request, context) => {
    if (!resolveSessionTargetWorkspaceTransfer(request.sessionId)) {
      throw compositionError('workspace_source_operation_unavailable', 'The Session target is unavailable');
    }
    const requester = readRequesterAccountActionContext(context?.callerInputAuthorization);
    const admission = context?.machineAdmission;
    const operationId = context?.callerInputAuthorization?.binding.requestId;
    if (!context || !requester?.retainCustody || !admission || !operationId) {
      throw compositionError('project_requester_authority_unavailable', 'Requester return custody is unavailable');
    }
    const availability = await requesterAvailability(context);
    if (availability.kind !== 'available') throw compositionError(availability.reason, 'Requester return workspace is unavailable');
    for (const abandoned of runtime!.handoffAdapter.listPrivateExecutions?.() ?? []) {
      if (abandoned.execution.onSourceRootReleased && abandoned.input.sourceSessionId === request.sessionId
        && requesterOwnsPrivateExecution(abandoned.execution, context)) {
        await runtime!.handoffAdapter.releasePrivateExecution?.(abandoned.input.operationId);
      }
    }
    const custody = requester.retainCustody();
    const accountRowsCustody = { serverId: semanticServerId, accountId: admission.actorAccountId,
      serverHttpBaseUrl: requester.serverHttpBaseUrl, isCurrent: custody.isCurrent };
    const mutate = createProjectAccountSnapshotMutation({ credentials: requester.credentials, sessionCustody: accountRowsCustody, serverId: semanticServerId });
    const lifetime = new AbortController();
    const cancel = () => lifetime.abort(context.signal.reason);
    context.signal.addEventListener('abort', cancel, { once: true });
    if (context.signal.aborted) cancel();
    let checkout: Awaited<ReturnType<typeof preparePrivateProjectOpenCheckout>> | undefined;
    let captured: Awaited<ReturnType<typeof captureManagedWorkspaceReturnStage>> | undefined;
    let published = false;
    let retained = false;
    const workspaceId = randomUUID();
    const stageRoot = join(availability.workspaceRoot ?? join(configuration.activeServerDir, 'workspace-return'), workspaceId);
    const release = async () => {
      try {
        if (published) {
          const removed = await mutate(snapshot => ({ ...snapshot,
            workspaceRefs: snapshot.workspaceRefs.filter(ref => ref.id !== workspaceId) }));
          if (removed.status !== 'applied' && removed.status !== 'unchanged') {
            throw compositionError('workspace_ref_not_ready', 'The return source could not be released');
          }
          published = false;
        }
      } finally {
        try { await captured?.dispose(); }
        finally { try { await checkout?.release(); } finally { lifetime.abort(); await custody.release(); } }
      }
    };
    try {
      let snapshot = await factories.refreshProjectRows({ credentials: requester.credentials, sessionCustody: accountRowsCustody,
        serverId: semanticServerId, selection: { kinds: ['workspace-ref', 'relationship-graph'] }, signal: lifetime.signal });
      const materialized = materializeWorkspaceRefForMachineRoot(snapshot.workspaceRefs, { serverId: semanticServerId,
        machineId: input.localMachineId, rootPath: stageRoot, nowMs: Date.now(), createId: () => workspaceId });
      const workspace = materialized.workspaceRef;
      snapshot = { ...snapshot, workspaceRefs: materialized.workspaceRefs };
      const policy = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [], contentOnly: true as const };
      const action = { kind: 'copy_once' as const, contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) } };
      const syncInput: PrepareWorkspaceSyncHandoffInput = { operationId, accountServerId: semanticServerId,
        sourceSessionId: request.sessionId, sourceMachineId: input.localMachineId, targetMachineId: input.localMachineId,
        sourceWorkspaceRefId: workspace.id, targetWorkspaceRefId: workspace.id, sourceRootPath: stageRoot,
        targetRootPath: stageRoot, action, signal: lifetime.signal };
      const continuations = { onSourceRootReleased: async () => { await runtime!.handoffAdapter.releasePrivateExecution?.(operationId); },
        assertTransferCurrent: async () => { if (!await custody.isCurrent()) throw compositionError('project_requester_authority_unavailable', 'Requester return custody is unavailable'); },
        release };
      let native: PrivateProjectNativeSync | undefined;
      if (availability.workspaceRoot) {
        const identity = resolveHostRequesterAgentExecutionIdentity(selectRequesterIdentity(context));
        if (!input.privateCheckout || identity.kind !== 'isolated') throw compositionError('agent_isolation_unavailable', 'Requester return workspace is unavailable');
        checkout = await preparePrivateProjectOpenCheckout({ runtime: input.privateCheckout, requesterAccount: requester,
          retainedRequesterCustody: custody, ingress: context, requesterIdentity: identity,
          request: { serverId: semanticServerId, machineId: input.localMachineId,
            source: { kind: 'workspace', workspaceId: workspace.id },
            materialization: { kind: 'sync', targetPath: stageRoot, workspaceAction: action } },
          workspaceRefs: snapshot.workspaceRefs, existingWorkspaceRefId: workspace.id,
          materializationKey: operationId, signal: lifetime.signal, onEffectsIssued: () => {} });
        const prepared = checkout;
        const execution = await runtime!.handoffAdapter.preparePrivateExecution!({ ...continuations, input: syncInput,
          context, snapshot, credentials: requester.credentials, executionIdentity: identity, accountRowsCustody,
          createNativeSync: ({ configuration, network }) => prepared.startSync(configuration, network) });
        native = execution.nativeSync;
        retained = true;
      } else {
        runtime!.handoffAdapter.retainPrivateExecution!({ input: syncInput, execution: { ...continuations,
          credentials: requester.credentials, accountRowsCustody, getSnapshot: () => snapshot,
          replaceSnapshot: async next => { snapshot = next; } } });
        retained = true;
      }
      const member = native;
      captured = await captureManagedWorkspaceReturnStage({ sessionId: request.sessionId, stageRoot,
        activeServerDir: configuration.activeServerDir, signal: lifetime.signal,
        ...(member ? { materializeStage: ({ operationId: transferId, exported }) => member.materializeCapturedSeed({ operationId: transferId,
          resolvePayloadSource: async ({ transferId: id }) => {
            const source = id === transferId ? exported.payloadSource
              : await exported.onDemandScope.resolvePayloadSourceOnOpen({ transferId: id, requestBody: {} });
            return { sizeBytes: await resolveTransferPayloadSizeBytes(source), manifestHash: await resolveTransferPayloadManifestHash(source),
              readChunk: async chunk => new Uint8Array(await readTransferPayloadChunk({ source, ...chunk })),
              dispose: async () => { await source.dispose?.(); } };
          } }) } : {}) });
      const publication = await mutate(rows => ({ ...rows, workspaceRefs: [...rows.workspaceRefs, workspace] }), lifetime.signal);
      if (publication.status !== 'applied' && publication.status !== 'unchanged') {
        throw compositionError('workspace_ref_not_ready', 'The return source could not be published');
      }
      published = true;
      checkout?.retainForRelationship();
      return { workspace: { serverId: workspace.serverId, machineId: workspace.machineId,
        workspaceId: workspace.id, rootPath: workspace.rootPath }, ...(captured.baseline ? { baseline: captured.baseline } : {}),
        ...(captured.excludedPaths ? { excludedPaths: captured.excludedPaths } : {}) };
    } catch (error) {
      try {
        if (retained) await runtime!.handoffAdapter.releasePrivateExecution?.(operationId);
        else await release();
      } catch (cleanupError) { factories.warn('Failed to release Session workspace return capture', cleanupError); }
      throw error;
    } finally { context.signal.removeEventListener('abort', cancel); }
  };
  const workspaceSync: MachineWorkspaceSyncRpcService = {
    captureSessionWorkspaceReturn,
    materializeManagedProjectTarget,
    captureHandoffWorkspace,
    readRequesterWorkspaceScope: requesterAvailability,
    forRequester: async (context, options) => {
      const availability = options?.includeAvailability ? { requesterAvailability: await requesterAvailability(context) } : {};
      if (!isWorkspaceSyncRelationshipWriteActionId(context?.callerInputAuthorization?.binding.actionId ?? '')
        && canUseInstalledRelationshipOwner(context)) return {
        ...availability,
        controller: runtime.managedWorkspaceSync, relationshipOwner: {
          ...workspaceSync.relationshipOwner,
          stop: async (id, signal, retirement) => {
            const retained = runtime.handoffAdapter.resolvePrivateExecution?.({ relationshipId: id });
            return retained && requesterOwnsPrivateExecution(retained.execution, context)
              ? requesterRelationshipOwner(retained, context).stop(id, signal, retirement)
              : createInstalledRelationshipOwner(context).stop(id, signal, retirement);
          },
        },
      };
      const accountId = context?.machineAdmission?.actorAccountId;
      if (!accountId) throw new RpcError('Requester Account admission is unavailable', 'project_requester_authority_unavailable');
      const retained = runtime.handoffAdapter.listPrivateExecutions?.() ?? [];
      const owned = retained.filter(value => requesterOwnsPrivateExecution(value.execution, context));
      // Read the requester projection once at ingress. No controller method may
      // fall back to the installed Account when this requester has no capture.
      const snapshot = owned[0] ? await refreshPrivateRows(owned[0].execution, context?.signal)
        : await readRequesterProjectSnapshot(context);
      const installedIds = new Set(accountId === readAccountIdFromToken(input.credentials.token) ? []
        : factories.getProjectSnapshot()?.relationships.map(value => value.relationshipId) ?? []);
      const definitions = snapshot?.relationships.filter(relationship => !installedIds.has(relationship.relationshipId)
        && !retained.some(value => value.relationshipId === relationship.relationshipId
          && value.execution.accountRowsCustody.accountId !== accountId)) ?? null;
      const ids = new Set(definitions?.map(value => value.relationshipId) ?? []);
      const requireOwned = (relationshipId: string) => {
        const capture = owned.find(value => value.relationshipId === relationshipId);
        if (!ids.has(relationshipId) || !capture) throw new RpcError('The requester does not own this Sync relationship', 'relationship_not_owned');
        return capture;
      };
      const controller = runtime.managedWorkspaceSync;
      return {
        ...availability,
        controller: {
          get: async (id, signal) => { requireOwned(id); return controller.get(id, signal); },
          list: async signal => (await controller.list(signal)).filter(value => ids.has(value.relationshipId)),
          watchStatuses: async (request, signal) => {
            const result = await controller.watchStatuses(request, signal);
            return result.changed ? { ...result, snapshot: { ...result.snapshot,
              statuses: result.snapshot.statuses.filter(value => ids.has(value.relationshipId)) } } : result;
          },
          flush: async (id, signal) => { requireOwned(id); return controller.flush(id, signal); },
          pause: async (id, signal) => { requireOwned(id); return controller.pause(id, signal); },
          resume: async (id, signal) => { requireOwned(id); return controller.resume(id, signal); },
          terminate: async (id, signal) => { requireOwned(id); return controller.terminate(id, signal); },
          listConflicts: async (request, signal) => { requireOwned(request.relationshipId); return controller.listConflicts(request, signal); },
          listRelationships: (request, signal) => controller.listRelationships(request, signal, ids, definitions),
          inspectConflict: (request, signal) => controller.inspectConflict(request, signal, ids),
          resolveConflict: async (request, signal, receipt) => {
            request.relationshipIds.forEach(requireOwned);
            return controller.resolveConflict(request, signal, receipt);
          },
          readFile: async (request, signal) => { requireOwned(request.relationshipId); return controller.readFile(request, signal); },
        },
        relationshipOwner: {
          setEnabled: async (id, enabled, signal) => requesterRelationshipOwner(requireOwned(id)).setEnabled(id, enabled, signal),
          stop: async (id, signal, retirement) => requesterRelationshipOwner(requireOwned(id), context).stop(id, signal, retirement),
          observeCreation: async request => {
            const capture = owned.find(value => value.input.operationId === request.operationId);
            if (!capture) throw new RpcError('Requester Sync custody is unavailable', 'project_requester_authority_unavailable');
            return requesterRelationshipOwner(capture).observeCreation({ ...request, serverId: semanticServerId });
          },
          create: (request, signal) => createRequesterRelationship(request, context!, signal, snapshot),
        },
      };
    },
    handoffSourcePhase: async (request, context) => {
      const serverId = semanticServerId;
      const admission = context?.machineAdmission;
      if (request.input.accountServerId !== serverId || !admission || !context) {
        throw compositionError('workspace_sync_child_unavailable', 'Physical source admission is unavailable');
      }
      context.signal.throwIfAborted();
      let authority: WorkspaceSyncSourceContextV1;
      const delegated = context.workspaceSyncSourceRouting !== undefined;
      if (delegated) {
        const routing = WorkspaceSyncSourceRoutingV1Schema.parse(context.workspaceSyncSourceRouting);
        const original = routing.sourceContext;
        if (!original || routing.accountServerId !== serverId || routing.phase !== request.phase
          || routing.operationId !== request.input.operationId
          || routing.sourceMachineId !== request.input.sourceMachineId
          || routing.sourceRootPath !== request.input.sourceRootPath
          || routing.sourceSessionId !== request.input.sourceSessionId
          || admission.machineId !== request.input.sourceMachineId
          || !isDeepStrictEqual(original.machineAdmission, admission)
          || original.callerAuthority !== context.callerAuthority
          || !isDeepStrictEqual(original.sessionActionOrigin, context.sessionActionOrigin)
          || !isDeepStrictEqual(original.callerInputConstraints, context.callerInputConstraints)) {
          throw compositionError('workspace_sync_child_unavailable', 'Physical source routing does not match the original admission');
        }
        authority = original;
      } else {
        // Direct Account calls keep their existing local manage admission. A
        // delegated child never borrows this parent Account authority.
        if (admission.machineId !== input.localMachineId || admission.role !== 'manage'
          || context.callerAuthority !== 'present_user' || context.sessionActionOrigin !== undefined) {
          throw compositionError('workspace_sync_child_unavailable', 'Physical source admission is unavailable');
        }
        authority = { machineAdmission: admission, callerAuthority: context.callerAuthority };
      }
      if (request.phase === 'prepare' || request.phase === 'finalize') {
        const actionInput = { workspaceAction: request.input.action };
        const spec = getActionSpec('session.handoff');
        const writeAdmission = resolveWorkspaceWriteActionAdmissionV1({ spec, actionInput,
          workspaceWrites: authority.workspaceWrites, currentWorkspaceWrites: authority.sessionActionOrigin?.workspaceWrites,
          agentCaller: authority.sessionActionOrigin !== undefined });
        if (!writeAdmission.ok) throw compositionError(writeAdmission.errorCode, writeAdmission.errorCode);
        const requiredAuthority = resolveCredentialActionAdmissionV1({ spec, actionInput, grant: null, surface: 'rpc',
          authority: authority.sessionActionOrigin ? 'account_automation' : authority.callerAuthority });
        if (!requiredAuthority.ok) throw compositionError(requiredAuthority.errorCode, requiredAuthority.errorCode);
        if (request.phase === 'prepare') {
          const accepted = await readHandoffExecutionBasis({ ...request.input, signal: context.signal }, context, authority);
          assertOriginalTargetAuthority(request.input, accepted.input, authority, context);
        }
      }
      if (!runtime.handoffAdapter.applySourcePhase) {
        throw compositionError('workspace_sync_update_required', 'Physical source phases are unavailable');
      }
      return await runtime.handoffAdapter.applySourcePhase(request,
        request.phase === 'abort' ? undefined : context.signal, authority, context);
    },
    controller: runtime.managedWorkspaceSync,
    prepareBetween: prepareBetweenAtController,
    relationshipOwner: {
      observeCreation: request => committedRelationshipOwner.observeCreation({ ...request, serverId: semanticServerId }),
      setEnabled: async (relationshipId, enabled, signal) => await installedRelationshipLifecycleOwner(relationshipId).setEnabled(relationshipId, enabled, signal),
      stop: async (relationshipId, signal, retirement) => await installedRelationshipLifecycleOwner(relationshipId).stop(relationshipId, signal, retirement),
      create: async (request, signal) => await factories.createRelationshipForProject(
        relationshipCreateDependencies,
        request,
        signal,
      ),
    },
    stageConflictResolutionAtTarget: async (request, signal) => {
      const native = await managedNative(request.relationshipId, request.targetWorkspaceRefId);
      return (native ?? targetAuthority).stageConflictResolutionHere(request, signal);
    },
    applyStagedConflictResolutionAtTarget: async (request, signal) => {
      const native = await managedNative(request.relationshipId, request.targetWorkspaceRefId);
      return (native ?? targetAuthority).applyStagedConflictResolutionHere(request, signal);
    },
    discardStagedConflictResolutionAtTarget: async (request, signal) => {
      const native = await managedNative(request.relationshipId, request.targetWorkspaceRefId);
      return (native ?? targetAuthority).discardStagedConflictResolutionHere(request, signal);
    },
    releaseConflictResolutionCaptureHere: async request => {
      for (const relationshipId of request.actionInput.relationshipIds) {
        const native = await managedNative(relationshipId, request.sourceWorkspaceRefId);
        if (native) return native.releaseConflictResolutionCaptureHere(request);
      }
      return targetAuthority.releaseConflictResolutionCaptureHere(request);
    },
    recoverConflictResolutionAtTarget: async (request, signal) => {
      const native = await managedNative(request.relationshipId, request.targetWorkspaceRefId);
      return native ? native.recoverConflictResolutionHere(request, signal) : targetAuthority.recoverConflictResolutionHere(request, signal);
    },
    hasRetainedRecoveryAdmission: targetAuthority.hasRetainedRecoveryAdmission,
    readFileAtTarget: async (request, signal) => {
      const native = await managedNative(request.relationshipId, request.workspaceRefId);
      return (native ?? targetAuthority).readFileHere(request, signal);
    },
    observeEntryAtTarget: async (request, signal) => {
      const native = await managedNative(request.relationshipId, request.workspaceRefId);
      return (native ?? targetAuthority).observeEntryHere(request, signal);
    },
    preflightHandoffTargetReplacement: targetAuthority.preflightHandoffTargetReplacementHere,
    preflightRelationshipTarget: async (request, context) => {
      const authorization = context.callerInputAuthorization;
      if (!authorization || !isWorkspaceSyncRelationshipWriteActionId(authorization.binding.actionId)
        || authorization.binding.machineId !== input.localMachineId
        || request.operationId !== authorization.binding.requestId) {
        throw compositionError('project_requester_authority_unavailable', 'The original Sync target preflight is unavailable');
      }
      const reviewed = await readReviewedExternalActionInput({ authorization,
        envelope: context.originalActionEnvelope, signal: context.signal });
      const parsed = getActionSpec(authorization.binding.actionId).inputSchema.safeParse(reviewed);
      const action = parsed.success ? parsed.data : null;
      if (!action || typeof action !== 'object' || !('sourceWorkspaceRefId' in action)
        || typeof action.sourceWorkspaceRefId !== 'string' || !('targetMachineId' in action)
        || !('targetPath' in action) || action.targetMachineId !== request.machineId
        || action.targetPath !== request.targetPath) {
        throw compositionError('project_requester_authority_unavailable', 'The original Sync target placement changed');
      }
      const snapshot = await readRequesterProjectSnapshot(context);
      if (!snapshot) throw compositionError('project_requester_authority_unavailable', 'Requester Sync projection is unavailable');
      const source = resolveWorkspaceRefById(snapshot.workspaceRefs, action.sourceWorkspaceRefId, semanticServerId);
      if (!source || isManagedWorkspaceRefV2(source) || source.machineId !== input.localMachineId) {
        throw compositionError('workspace_ref_not_ready', 'The requester source Workspace is unavailable');
      }
      return targetAuthority.preflightHandoffTargetReplacementAtTarget({ ...request, signal: context.signal }, {
        ...context, workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1Schema.parse({
          v: 1, phase: 'prepare', operationId: request.operationId, accountServerId: semanticServerId,
          sourceMachineId: source.machineId, sourceRootPath: source.rootPath,
          originalActionEnvelope: context.originalActionEnvelope,
          sourceContext: projectWorkspaceSyncPhysicalContextFromActionContext(buildActionExecutorContextForRpc(context)),
        }),
      });
    },
    prepareBootstrapAtTarget: async (request, signal, context) => {
      signal?.throwIfAborted();
      // SOURCE has acknowledged staging at Home before dispatching this RPC.
      // A receiving process can still lack the endpoints or staged graph.
      // Refresh that projection before bootstrap so pre-engine recovery can
      // use the retained target with its durable intent. Private requester
      // reads retain their current owner.
      if (!context?.callerInputAuthorization) {
        const relationship = request.transientRelationship;
        const endpointIds = request.owner.kind === 'copy_once'
          ? [request.owner.operation.alphaWorkspaceRefId, request.owner.operation.betaWorkspaceRefId]
          : relationship ? [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId] : [request.targetWorkspaceRefId];
        const snapshot = factories.getProjectSnapshot();
        const refs = snapshot?.workspaceRefs ?? [];
        const owner = request.owner;
        const missingRelationship = owner.kind === 'relationship'
          && !snapshot?.relationships.some(candidate => candidate.relationshipId === owner.relationshipId);
        if (missingRelationship || endpointIds.some(id => !resolveWorkspaceRefById(refs, id, semanticServerId))) {
          await refreshInstalledProjectRows(signal);
        }
      }
      return await targetAuthority.prepareBootstrapHere(request, signal, context);
    },
    releaseBootstrapAtTarget: targetAuthority.releaseBootstrapHere,
    prepareSourceSeedExport: targetAuthority.prepareSourceSeedExport,
    prepareConflictResolutionExport: async request => {
      const native = await managedNative(request.sourceRelationshipId, request.sourceWorkspaceRefId);
      if (!native) return targetAuthority.prepareConflictResolutionExport(request);
      const exported = await native.prepareSourceConflictResolutionExport(request);
      const blobs = new Map(exported.blobs.map(blob => [blob.transferId, blob]));
      return { payloadSource: createBufferTransferPayloadSource(Buffer.from(exported.payload)), onDemandScope: {
        allowTransferId: transferId => blobs.has(transferId), maxResolvedTransfers: blobs.size,
        resolvePayloadSourceOnOpen: async ({ transferId }) => {
          const blob = blobs.get(transferId);
          if (!blob) throw compositionError('approval_stale', 'Reviewed workspace conflict blob is unavailable');
          return { kind: 'native' as const, sizeBytes: blob.sizeBytes, manifestHash: blob.manifestHash,
            readChunk: async range => Buffer.from(await native.readSourceSeedBlob({ operationId: request.operationId, transferId, ...range })) };
        },
      } };
    },
    assertConflictResolutionAuthorized,
    inspectRetiredState: async (signal): Promise<WorkspaceSyncLegacyStateInspectionV1> => {
      signal?.throwIfAborted();
      return await factories.inspectLegacyState({ activeServerDir: input.activeServerDir });
    },
    inspectCommittedCopyHere: async (request, signal, context) => {
      if ('kind' in request) {
        if (context?.workspaceSyncSourceWriterTargetRouting?.target.phase === 'inspect') {
          return targetAuthority.previewCommittedCopyHere({ ...request, ...(signal ? { signal } : {}) }, context);
        }
        const retained = readRequesterPrivateExecution(request.expectedRelationship.relationshipId, context);
        const current = { request, context, serverId: semanticServerId,
          ...(retained ? { requesterAccountId: retained.execution.accountRowsCustody.accountId } : {}),
          machineId: input.localMachineId, credentials: input.credentials, isCurrent: input.isCurrent };
        await assertCurrentWorkspaceCopyPreview(current);
        return await targetAuthority.previewCommittedCopyAtTarget({ ...request, ...(signal ? { signal } : {}) }, context);
      }
      await targetAuthority.inspectCommittedCopyHere({ ...request, ...(signal ? { signal } : {}) }, context);
      return { ok: true };
    },
    removeCommittedCopyHere: async (request, signal, context) => {
      await targetAuthority.removeCommittedCopyHere({ ...request, ...(signal ? { signal } : {}) }, context);
      return { ok: true };
    },
    readProjectWorkerDependencies: async (request, signal, context) => {
      if (request.serverId !== (semanticServerId)
        || request.machineId !== input.localMachineId || !input.readProjectWorkerDependencies) {
        throw compositionError('workspace_sync_dependencies_unavailable', 'Worker dependency target is unavailable');
      }
      if (context?.workspaceSyncSourceWriterTargetRouting) {
        await targetAuthority.assertRetainedCopyDependencyAdmission(request, context);
        return input.readProjectWorkerDependencies(request.workspaceRefId, request.relationshipId);
      }
      const snapshot = await refreshInstalledProjectRows(signal);
      const ref = resolveWorkspaceRefById(snapshot.workspaceRefs, request.workspaceRefId, request.serverId);
      const relationship = snapshot.relationships.find(value => value.relationshipId === request.relationshipId);
      if (!ref || !relationship
        || (relationship.alphaWorkspaceRefId !== ref.id && relationship.betaWorkspaceRefId !== ref.id)) {
        throw compositionError('workspace_sync_dependencies_unavailable', 'Current relationship dependency target is unavailable');
      }
      const machines = resolveWorkspaceSyncRelationshipDependencyMachines({ ...snapshot, serverId: request.serverId,
        relationshipId: relationship.relationshipId });
      if (!machines.includes(input.localMachineId)) {
        throw compositionError('workspace_sync_dependencies_unavailable', 'Machine does not own this dependency component');
      }
      return input.readProjectWorkerDependencies(ref.id, relationship.relationshipId);
    },
  };
  let stopPromise: Promise<void> | null = null;
  const missingActivity: import('@/daemon/lifecycle/managedActivity').LiveWorkProducerV1 = {
    read: () => ({ items: [], coverage: 'unknown' }), subscribe: () => () => {},
  };
  const prepareManagedProjectFiles = async (request: Omit<PrepareManagedProjectFilesSyncInput, 'mode'> & Readonly<{
    mode: PrepareManagedProjectFilesSyncInput['mode'] | 'copy_once';
  }>): Promise<Readonly<{ relationshipId: string; targetWorkspace: WorkspaceAddressV2; baseline?: WorkspaceManifest;
    contentPolicyDigest: WorkspaceContentPolicyV1['policyDigest'] }>> => {
      let custodyCaptured = false;
      try {
      request.signal?.throwIfAborted();
      const credentials = request.credentials ?? input.credentials;
      const accountId = readAccountIdFromToken(credentials.token);
      const custody = request.accountRowsCustody ?? (accountId === installedAccountId ? {
        serverId: semanticServerId, accountId: installedAccountId!, serverHttpBaseUrl: readServerHttpBaseUrl(),
        isCurrent: input.isCurrent ?? (async () => true),
      } : undefined);
      if (!accountId || accountId !== request.requesterAccountId || !custody || custody.accountId !== accountId
        || custody.serverId !== semanticServerId || !await custody.isCurrent()) {
        throw compositionError('project_requester_authority_unavailable', 'Requester Sync custody is unavailable');
      }
      const controller = request.targetManaged.controller ?? (installation
        ? { machineId: input.localMachineId, installationId: installation.installationId } : undefined);
      if (!input.openManagedWorkspaceTarget || !controller || controller.machineId !== input.localMachineId) {
        throw compositionError('workspace_sync_unavailable', 'Managed Workspace Sync transport is unavailable');
      }
      let snapshot = await factories.refreshProjectRows({ credentials, sessionCustody: custody, serverId: semanticServerId,
        selection: { kinds: ['workspace-ref', 'relationship-graph'] }, ...(request.signal ? { signal: request.signal } : {}) });
      const selectedSource = request.sourceWorkspace ? resolveWorkspaceRefById(snapshot.workspaceRefs,
        request.sourceWorkspace.workspaceId, semanticServerId) : undefined;
      if (request.sourceWorkspace && (!selectedSource || isManagedWorkspaceRefV2(selectedSource)
        || selectedSource.machineId !== request.sourceWorkspace.machineId || selectedSource.rootPath !== request.sourceWorkspace.rootPath
        || request.sourceWorkspace.serverId !== semanticServerId)) {
        throw compositionError('workspace_ref_not_ready', 'The selected Project source is unavailable');
      }
      const source = selectedSource ? { workspaceRef: selectedSource, workspaceRefs: snapshot.workspaceRefs }
        : materializeWorkspaceRefForMachineRoot(snapshot.workspaceRefs, { serverId: semanticServerId,
          machineId: input.localMachineId, rootPath: request.sourceRootPath, nowMs: Date.now(), createId: randomUUID });
      const target = materializeWorkspaceRefForManagedRoot(source.workspaceRefs, { serverId: semanticServerId,
        managedId: request.targetManaged.managedId, controller, rootPath: request.targetRootPath, nowMs: Date.now(), createId: randomUUID,
        parentWorkspace: { serverId: semanticServerId, workspaceId: source.workspaceRef.id,
          machineId: resolveWorkspaceSyncExecutionMachineIdV1(source.workspaceRef),
          rootPath: source.workspaceRef.rootPath } });
      const sourceMachineId = resolveWorkspaceSyncExecutionMachineIdV1(source.workspaceRef);
      const copyOnce = request.mode === 'copy_once';
      const existing = !copyOnce ? snapshot.relationships.find(value => value.alphaWorkspaceRefId === source.workspaceRef.id
        && value.betaWorkspaceRefId === target.workspaceRef.id) : undefined;
      const contentPolicy = existing?.contentPolicy ?? request.contentPolicy ?? createDefaultWorkspaceContentPolicyV1();
      if (existing && (existing.mode !== request.mode || existing.controllerMachineId !== sourceMachineId)) {
        throw compositionError('relationship_replacement_required', 'The existing managed Workspace relationship has a different mode');
      }
      const operationId = request.actionContext?.actionRequestId ?? randomUUID();
      const relationshipId = existing?.relationshipId ?? (copyOnce ? operationId : deriveWorkspaceSyncRelationshipId(operationId));
      const known = runtime.handoffAdapter.resolvePrivateExecution?.({ relationshipId });
      snapshot = { ...snapshot, workspaceRefs: target.workspaceRefs };
      const retained = known ?? retainManagedExecution({ operationId: relationshipId, source: source.workspaceRef,
        target: target.workspaceRef, snapshot, credentials, custody, phase: 'open',
        ...(copyOnce ? { action: { kind: 'copy_once', contentPolicy } } as const : {}),
        ...(request.sourceExecutionIdentity && resolveWorkspaceSyncExecutionMachineIdV1(source.workspaceRef) === input.localMachineId
          ? { sourceExecutionIdentity: request.sourceExecutionIdentity } : {}),
        ...(request.releaseCustody ? { releaseCustody: request.releaseCustody } : {}),
        ...(request.retainRelationship ? { retainRelationship: request.retainRelationship } : {}) });
      custodyCaptured = !known;
      try {
        await retained.execution.replaceSnapshot?.(snapshot);
        if (!copyOnce && !request.openProject) await runtime.handoffAdapter.bindPrivateExecutionRelationship?.(retained.input.operationId, relationshipId);
        if (request.sourceWorkspace || sourceMachineId !== input.localMachineId || copyOnce) {
          if (!request.openProject) throw compositionError('workspace_sync_update_required', 'The reviewed Project child is unavailable');
          await requesterRelationshipOwner(retained).materializeEndpoints({ serverId: semanticServerId, purpose: 'project_files',
            sourceMachineId, sourceWorkspaceRefId: source.workspaceRef.id, sourceRootPath: source.workspaceRef.rootPath,
            targetManaged: { managedId: target.workspaceRef.managedId, controller }, targetWorkspaceRefId: target.workspaceRef.id,
            targetRootPath: target.workspaceRef.rootPath, ...(request.signal ? { signal: request.signal } : {}) });
          const projectRequest: OpenProjectInputV1 = { serverId: semanticServerId,
              machineId: controller.machineId, source: { kind: 'workspace', workspaceId: source.workspaceRef.id,
                checkout: { serverId: semanticServerId, workspaceId: source.workspaceRef.id, machineId: sourceMachineId,
                  rootPath: source.workspaceRef.rootPath } },
              materialization: { kind: 'sync', targetPath: target.workspaceRef.rootPath,
                targetManaged: { managedId: target.workspaceRef.managedId, controller }, workspaceAction: copyOnce
                  ? { kind: 'copy_once', contentPolicy }
                  : existing ? { kind: 'relationship', relationshipId, flushBeforeCommit: true }
                    : { kind: 'create_relationship', mode: request.mode,
                      contentPolicy,
                      flushBeforeCommit: true } } };
          const opened = await request.openProject(projectRequest);
          if (opened.kind !== 'opened') throw compositionError(opened.kind === 'refused' ? opened.code : 'indeterminate', 'Project target Open did not settle');
          const settledRelationshipId = runtime.handoffAdapter.resolvePrivateExecution?.({ operationId: retained.input.operationId })?.relationshipId ?? relationshipId;
          if (copyOnce) await runtime.handoffAdapter.releasePrivateExecution?.(retained.input.operationId);
          else {
            await refreshPrivateRows(retained.execution, request.signal);
            await runtime.handoffAdapter.bindPrivateExecutionRelationship?.(retained.input.operationId, settledRelationshipId, 'relationship');
          }
          return { relationshipId: settledRelationshipId, targetWorkspace: workspaceAddressFromRefV2(target.workspaceRef),
            contentPolicyDigest: contentPolicy.policyDigest, ...(opened.copyOnceBaseline ? { baseline: opened.copyOnceBaseline } : {}) };
        }
        const owner = requesterRelationshipOwner(retained);
        if (existing) {
          if (!existing.enabled) await owner.setEnabled(relationshipId, true, request.signal);
          await runtime.managedWorkspaceSync.ensure({ ...existing, enabled: true }, request.signal);
          await runtime.managedWorkspaceSync.flush(relationshipId, request.signal);
        } else {
          const prepared = await owner.prepareCreate({ operationId, serverId: semanticServerId, purpose: 'project_files',
            sourceMachineId: resolveWorkspaceSyncExecutionMachineIdV1(source.workspaceRef), sourceWorkspaceRefId: source.workspaceRef.id, sourceRootPath: source.workspaceRef.rootPath,
            targetManaged: { managedId: request.targetManaged.managedId, controller }, targetWorkspaceRefId: target.workspaceRef.id, targetRootPath: request.targetRootPath,
            mode: request.mode, contentPolicy,
            targetBootstrap: 'use_existing', flushBeforeCommit: true, ...(request.signal ? { signal: request.signal } : {}) });
          await prepared.commit();
        }
        await runtime.handoffAdapter.bindPrivateExecutionRelationship?.(retained.input.operationId, relationshipId, 'relationship');
        return { relationshipId, targetWorkspace: workspaceAddressFromRefV2(target.workspaceRef), contentPolicyDigest: contentPolicy.policyDigest };
      } catch (error) {
        if (!known) await runtime.handoffAdapter.releasePrivateExecution?.(retained.input.operationId);
        throw error;
      }
      } finally {
        if (!custodyCaptured) await request.releaseCustody?.();
      }
  };

  const activitySources = [runtime.managedWorkspaceSync.activity ?? missingActivity,
    targetAuthority.activity ?? missingActivity];
  return {
    handoffAdapter: runtime.handoffAdapter,
    readProcessRoots: () => runtime.readProcessRoots(),
    activity: {
      read: async () => {
        // Capture every rejection even when a later synchronous reader throws.
        const observations = await Promise.all(activitySources.map(async source => await source.read()));
        return { items: observations.flatMap(observation => observation.items),
          coverage: observations.every(observation => observation.coverage === 'complete') ? 'complete' : 'unknown' };
      },
      subscribe: listener => {
        const cleanup = activitySources.map(source => source.subscribe(listener));
        return () => { for (const unsubscribe of cleanup) unsubscribe(); };
      },
    },
    workspaceSync,
    materializeManagedProjectTarget,
    prepareManagedProjectFilesSync: prepareManagedProjectFiles,
    prepareManagedProjectFilesSeed: async request => {
      const seeded = await prepareManagedProjectFiles({ ...request, mode: 'copy_once' });
      return { targetRootPath: request.targetRootPath, targetWorkspace: seeded.targetWorkspace, contentPolicyDigest: seeded.contentPolicyDigest,
        ...(seeded.baseline ? { baseline: seeded.baseline } : {}) };
    },
    readManagedProjectFilesBaseline: async request => {
      const accountId = readAccountIdFromToken((request.credentials ?? input.credentials).token);
      if (!accountId) throw compositionError('project_requester_authority_unavailable', 'Requester Account custody is unavailable');
      const { workspaceId, ...address } = request.targetWorkspace;
      const workspace: ManagedWorkspaceRefV2 = { ...address, id: workspaceId, createdAtMs: 0 };
      const lifetime = new AbortController();
      const signal = request.signal ? AbortSignal.any([request.signal, lifetime.signal]) : lifetime.signal;
      try {
        if (!input.openManagedWorkspaceTarget) throw compositionError('workspace_sync_unavailable', 'Managed workspace transport is unavailable');
        const target = await input.openManagedWorkspaceTarget({ workspace, relationshipId: request.sessionId,
          requesterAccountId: accountId, lifetime: signal });
        const installed = await target.ensureWorkspaceRuntime();
        const workspaceRoot = dirname(workspace.rootPath);
        const channel = target.openChannel(['sh', '-c', 'cd "$1" && exec "$2" workspace-effect', 'workspace-sync',
          workspaceRoot, installed.binaryPath], signal);
        const effect: WorkspaceNativeCopyBaselineEffect = { kind: 'native_copy_baseline', workspaceRoot,
          memberHome: target.home, owner: { accountId, target: workspace },
          policyDigest: request.contentPolicyDigest ?? createDefaultWorkspaceContentPolicyV1().policyDigest };
        let baseline: WorkspaceManifest | null | undefined;
        let failure: unknown;
        const outcome = await runWorkspaceEffectChannel({ channel, signal, id: request.sessionId, effect,
          services: { completeNativeCopyBaseline: async (value: WorkspaceManifest | null) => { baseline = value; },
            fail: async (error: Error) => { failure = error; } },
          refusal: code => compositionError(code, 'The retained workspace baseline is unavailable') });
        if (failure !== undefined) throw failure;
        if (outcome.failure !== undefined) throw outcome.failure;
        if (!outcome.settled || baseline === undefined) throw compositionError('workspace_effect_outcome_unknown', 'The retained workspace baseline is unavailable');
        return baseline;
      } catch (error) {
        signal.throwIfAborted();
        const code = readRpcErrorCode(error) ?? (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined);
        if (code !== 'workspace_sync_unavailable') throw error;
        factories.warn('[DAEMON RUN] The original copied Project baseline is unavailable; Return requires review without a baseline', { code });
        return null;
      } finally { lifetime.abort(); }
    },
    acquireWorkspaceSyncMachineIngress: async request => {
      await privateRecovery;
      let retained = runtime.handoffAdapter.resolvePrivateExecution?.({ operationId: request.operationId })
        ?? runtime.handoffAdapter.resolvePrivateExecution?.({ relationshipId: request.operationId });
      if (!retained) {
        const privateRelationship = await recoverPrivateExecutions(request.operationId);
        retained = runtime.handoffAdapter.resolvePrivateExecution?.({ relationshipId: request.operationId });
        if (!retained && privateRelationship) throw compositionError('agent_isolation_unavailable', 'Private Sync execution is unavailable');
      }
      if (!retained) return targetAuthority.acquireWorkspaceSyncMachineIngress(request);
      await admitPrivateTransfer(request.operationId, request.signal);
      if (retained.execution.managedTarget) {
        const relationship = retained.execution.getSnapshot?.()?.relationships.find(value => value.relationshipId === request.operationId);
        if (relationship) await prepareRelationshipTarget(relationship, request.signal);
        return targetAuthority.acquireWorkspaceSyncMachineIngress(request);
      }
      if (!retained.execution.nativeSync) throw compositionError('agent_isolation_unavailable', 'Private Sync execution is unavailable');
      return retained.execution.nativeSync.acquireWorkspaceSyncMachineIngress(request);
    },
    stop: () => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        unsubscribe();
        await authorityTail.catch(() => undefined);
        const failures: unknown[] = [];
        await startup.catch((error: unknown) => { failures.push(error); });
        await runtime.stop().catch((error: unknown) => { failures.push(error); });
        await targetAuthority.releaseAllRetainedBootstraps().catch((error: unknown) => {
          failures.push(error);
        });
        await runtime.handoffAdapter.releaseAllPrivateExecutions?.().catch((error: unknown) => { failures.push(error); });
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, 'Workspace sync daemon runtime cleanup failed');
        }
      })().catch((error: unknown) => {
        stopPromise = null;
        throw error;
      });
      return stopPromise;
    },
  };
}
