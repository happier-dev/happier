import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import type {
  ActionExecutorDeps,
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
} from '@happier-dev/protocol';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ProjectWorkerCopyRetireInputV1Schema } from '@happier-dev/protocol';
import { ProjectWorkerDependencyV1Schema, type ProjectWorkerDependencyV1 } from '@happier-dev/protocol/workspaces/projectWorkerExecutionV1';
import { WorkspaceSyncConflictResolveActionInputV1Schema, WorkspaceSyncStatusV1Schema, WorkspaceSyncPrepareBetweenResultV1Schema,
  type HandoffTargetReplacementPreflightResultV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveCredentialActionAdmissionV1, resolveWorkspaceWriteActionAdmissionV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema, type WorkspaceSyncSourceContextV1 } from '@happier-dev/protocol/socketRpc';
import type { MachineInstallationPublicIdentityV1 } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { resolveWorkspaceSyncEndpoint, resolveWorkspaceSyncTransferRoute } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { managedDevcontainerChildProjectionsEqualV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { TransferEndpointCandidateSchema } from '@happier-dev/protocol/machines/transfer/transferStream';
import type { TransferEndpointCandidate } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { RpcError, isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';
import type { WorkspaceSyncCommittedCopyPreviewV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncCommittedCopyV1';

import type { MachineWorkspaceSyncRpcService } from '@/api/machine/rpcHandlers.workspaceSync';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { StoredCredentials } from '@/persistence';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveWorkspaceSyncRootOwnershipDirectory } from '@/configuration/resolveWorkspaceSyncRootOwnershipDirectory';
import { configuration } from '@/configuration';
import {
  getActiveProjectAccountRowsSnapshot,
  subscribeActiveProjectAccountRowsSnapshot,
  type ActiveProjectAccountRowsSnapshot,
  readProjectAccountRows,
} from '@/workspaces/projectAccountRows';
import { resolveWorkspaceSyncRelationshipEndpointRoles } from '@/workspaces/sync/workspaceSyncRelationshipEndpoints';
import { resolveWorkspaceRefById } from '@/workspaces/workspaceRefsV1';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { logger } from '@/ui/logger';
import {
  createWorkspaceRootOwnershipManager,
  type WorkspaceRootOwnershipHandle,
} from '@/workspaces/sync/workspaceSyncRootOwnership';
import {
  createWorkspaceSyncTargetAuthority,
  readWorkspaceSyncChildMachineFacts,
  type AcquireWorkspaceSyncMachineIngressRequest,
  type WorkspaceSyncMachineIngress,
  type WorkspaceSyncTargetPhaseDescriptor,
} from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { prepareWorkspaceSyncGitTarget } from '@/workspaces/sync/workspaceSyncTargetBootstrap';
import { assertWorkspaceSyncRequesterBootstrapSupported, prepareWorkspaceSyncBetween, resolveWorkspaceSyncRelationshipDependencyMachines,
  WorkspaceSyncInitialPreparationRefusal } from '@/workspaces/sync/workspaceSyncPreparation';
import { createWorkspaceSyncSeedExport, materializeLocalWorkspaceSyncSeed, materializeWorkspaceSyncSeedExport, resolveWorkspaceSyncSeedTransfer as resolveSeedWorkspaceTransfer } from '@/workspaces/sync/workspaceSyncSeedTransfer';
import { materializeWorkspaceExportArtifactsWithScmWorkspace } from '@/scm/workspace/workspaceExportMaterialization';
import { buildDirectPeerTransferEndpointPath } from '@/machines/transfer/directPeerTransport';
import { createWorkspaceSyncPeerIdentityValidator } from '@/workspaces/sync/transport/workspaceSyncPeerIdentity';
import {
  createWorkspaceSyncLegacyStateGate,
  inspectRetiredWorkspaceReplicationState,
  type WorkspaceSyncLegacyStateInspection,
} from '@/workspaces/sync/workspaceSyncLegacyState';
import { sameExecutionWorkspace, type WorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import {
  createProjectAccountRowsWorkspaceSyncRelationshipMutation,
  createWorkspaceSyncRelationshipOwner,
  type WorkspaceSyncRelationshipOwner,
} from '@/workspaces/sync/workspaceSyncRelationshipOwner';
import {
  createWorkspaceSyncRelationshipForProject,
  type WorkspaceSyncRelationshipCreateDependencies,
} from '@/workspaces/sync/workspaceSyncRelationshipCreate';
import type { WorkspaceSyncMachineTunnelOpen } from '@/workspaces/sync/workspaceSyncMachineCarrierStream';
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
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';

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
  warn(message: string, error: unknown): void;
}>;

export type ProductionDaemonWorkspaceSyncRuntime = Readonly<{
  activity: import('@/daemon/lifecycle/managedActivity').LiveWorkProducerV1;
  handoffAdapter: WorkspaceSyncHandoffAdapter;
  workspaceSync: MachineWorkspaceSyncRpcService;
  acquireWorkspaceSyncMachineIngress(request: AcquireWorkspaceSyncMachineIngressRequest): Promise<WorkspaceSyncMachineIngress>;
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
  warn: (message, error) => logger.warn(message, error),
};

function compositionError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

async function requireExecutingWorkspaceActionReceipt(input: Readonly<{
  approvalsGet: NonNullable<ActionExecutorDeps['approvalsGet']>;
  serverId: string;
  actionReceiptId: string;
  actionId: 'workspace.sync.conflict.resolve' | 'session.handoff' | 'workspace.sync.relationship.create' | 'projects.worker.copy.retire';
  actionInput: unknown;
  expectedExecutionMachineId?: string;
  expectedExecutionRequestId?: string;
  expectedExecutionSessionId?: string;
  expectedTargetReplacementApproval?: HandoffTargetReplacementApprovalV1;
}>): Promise<void> {
  const artifact = await input.approvalsGet({ artifactId: input.actionReceiptId, serverId: input.serverId });
  const parsed = ApprovalRequestV2Schema.safeParse(artifact);
  const request = parsed.success ? parsed.data : null;
  const origin = request?.executionOriginV1;
  let sameInput = false;
  if (request !== null) {
    try {
      sameInput = createCanonicalJsonSigningInput(request.actionArgs)
        === createCanonicalJsonSigningInput(input.actionInput);
    } catch {
      sameInput = false;
    }
  }
  if (!request
    || !origin
    || request.status !== 'executing'
    || request.decision?.kind !== 'approve'
    || request.actionId !== input.actionId
    || origin.actionId !== input.actionId
    || origin.serverId !== input.serverId
    || (input.expectedExecutionMachineId !== undefined
      && origin.machineId !== input.expectedExecutionMachineId)
    || (input.expectedExecutionRequestId !== undefined
      && origin.requestId !== input.expectedExecutionRequestId)
    || (input.expectedExecutionSessionId !== undefined
      && origin.sessionId !== input.expectedExecutionSessionId)
    || !sameInput
    || (input.expectedTargetReplacementApproval !== undefined
      && !isDeepStrictEqual(
        request.handoffTargetReplacementApproval,
        input.expectedTargetReplacementApproval,
      ))) {
    throw compositionError('approval_stale', 'Workspace Action receipt is stale or does not match');
  }
}

/**
 * Canonical destructive conflict-Action receipt validator. The approvals store
 * remains the injected persistence boundary so production and composed real
 * tests exercise the same admission decision without duplicating its rules.
 */
export function createWorkspaceSyncConflictResolutionAuthorizer(input: Readonly<{
  approvalsGet: NonNullable<ActionExecutorDeps['approvalsGet']>;
  serverId: string;
}>): (actionReceiptId: string, rawActionInput: WorkspaceSyncConflictResolveActionInputV1) => Promise<void> {
  return async (actionReceiptId, rawActionInput) => {
    const actionInput = WorkspaceSyncConflictResolveActionInputV1Schema.parse(rawActionInput);
    await requireExecutingWorkspaceActionReceipt({
      approvalsGet: input.approvalsGet,
      serverId: input.serverId,
      actionReceiptId,
      actionId: 'workspace.sync.conflict.resolve',
      actionInput,
      expectedExecutionMachineId: actionInput.controllerMachineId,
    });
  };
}

/**
 * The exact Action families whose approved input may authorize a destructive
 * workspace destination, and the extra origin facts each one binds.
 *
 * Membership is decided by parsing against the canonical Action input schema —
 * never by trusting an Action id carried alongside the proof. An input that
 * matches neither closed family authorizes nothing, so an unrelated Action's
 * similarly shaped approval cannot be replayed here.
 */
type WorkspaceDestinationActionAdmission = Readonly<{
  actionId: 'session.handoff' | 'workspace.sync.relationship.create';
  expectedExecutionSessionId?: string;
}>;

function admitWorkspaceDestinationActionInput(actionInput: unknown): WorkspaceDestinationActionAdmission | null {
  const createSpec = getActionSpec('workspace.sync.relationship.create');
  if (createSpec.inputSchema.safeParse(actionInput).success) {
    return { actionId: 'workspace.sync.relationship.create' };
  }
  const handoffSpec = getActionSpec('session.handoff');
  const handoff = handoffSpec.inputSchema.safeParse(actionInput);
  if (!handoff.success) return null;
  const sessionId = typeof (handoff.data as { sessionId?: unknown }).sessionId === 'string'
    ? (handoff.data as { sessionId: string }).sessionId.trim()
    : '';
  return {
    actionId: 'session.handoff',
    ...(sessionId ? { expectedExecutionSessionId: sessionId } : {}),
  };
}

/**
 * Canonical destination-approval receipt validator, shared by every workspace
 * target that must prove a destructive destination was actually approved. The
 * approvals store stays the injected persistence boundary so production and
 * composed tests exercise the same admission decision.
 */
export function createWorkspaceDestinationApprovalAuthorizer(input: Readonly<{
  approvalsGet: NonNullable<ActionExecutorDeps['approvalsGet']>;
  serverId: string;
}>): (
  actionReceiptId: string,
  actionInput: unknown,
  approval: HandoffTargetReplacementApprovalV1,
) => Promise<void> {
  return async (actionReceiptId, actionInput, approval) => {
    const admitted = admitWorkspaceDestinationActionInput(actionInput);
    if (!admitted) {
      throw compositionError(
        'approval_stale',
        'Workspace destination approval does not belong to a destination-choosing Action',
      );
    }
    await requireExecutingWorkspaceActionReceipt({
      approvalsGet: input.approvalsGet,
      serverId: input.serverId,
      actionReceiptId,
      actionId: admitted.actionId,
      actionInput,
      expectedExecutionRequestId: approval.operationId,
      ...(admitted.expectedExecutionSessionId
        ? { expectedExecutionSessionId: admitted.expectedExecutionSessionId }
        : {}),
      expectedTargetReplacementApproval: approval,
    });
  };
}

/** The receiving target verifies the persisted approval, not a caller-supplied tuple alone. */
export function createWorkspaceCommittedCopyRemovalAuthorizer(input: Readonly<{
  approvalsGet: NonNullable<ActionExecutorDeps['approvalsGet']>;
  serverId: string;
}>): (actionReceiptId: string, rawActionInput: unknown) => Promise<void> {
  return async (actionReceiptId, rawActionInput) => {
    const parsed = ProjectWorkerCopyRetireInputV1Schema.safeParse(rawActionInput);
    if (!parsed.success || !parsed.data.removeTargetCopy || parsed.data.workspace.serverId !== input.serverId) {
      throw compositionError('approval_stale', 'Approved committed-copy removal input is required');
    }
    await requireExecutingWorkspaceActionReceipt({
      approvalsGet: input.approvalsGet,
      serverId: input.serverId,
      actionReceiptId,
      actionId: 'projects.worker.copy.retire',
      actionInput: parsed.data,
      expectedExecutionMachineId: parsed.data.machineId,
    });
  };
}

function controllerUnavailable(cause?: unknown): Error {
  return Object.assign(new Error('Workspace sync controller machine is unavailable', { cause }), {
    code: 'controller_unavailable',
  });
}

function parseControllerStatusResponse(value: unknown): WorkspaceSyncStatusV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('status' in value)) {
    throw controllerUnavailable();
  }
  const status = (value as { status: unknown }).status;
  const parsed = WorkspaceSyncStatusV1Schema.safeParse(status);
  if (!parsed.success) throw controllerUnavailable(parsed.error);
  return parsed.data;
}

function resolveRelationship(
  snapshot: ActiveProjectAccountRowsSnapshot | null,
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
  snapshot: ActiveProjectAccountRowsSnapshot | null,
  relationship: WorkspaceSyncRelationshipV1,
  serverId: string,
): Readonly<{ workspaceRefId: string; machineId: string; endpointRole: 'alpha' | 'beta' }> {
  const refs = snapshot?.workspaceRefs ?? [];
  const alpha = resolveWorkspaceRefById(refs, relationship.alphaWorkspaceRefId, serverId);
  const beta = resolveWorkspaceRefById(refs, relationship.betaWorkspaceRefId, serverId);
  if (!alpha || !beta) {
    throw compositionError('peer_unavailable', 'Workspace sync relationship endpoint is unavailable');
  }
  const roles = resolveWorkspaceSyncRelationshipEndpointRoles({
    mode: relationship.mode,
    controllerMachineId: relationship.controllerMachineId,
    alphaMachineId: alpha.machineId,
    betaMachineId: beta.machineId,
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
  return { workspaceRefId: target.id, machineId: target.machineId, endpointRole: roles.targetEndpointRole };
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

/** A preview discloses owned-copy identity only to the current personal Machine ingress. */
export async function assertCurrentPersonalWorkspaceCopyPreview(input: Readonly<{
  request: WorkspaceSyncCommittedCopyPreviewV1;
  context?: RpcHandlerContext;
  serverId: string;
  machineId: string;
  credentials: StoredCredentials;
  isCurrent?: () => Promise<boolean>;
}>): Promise<void> {
  if (!input.isCurrent) {
    throw new RpcError('Owned-copy preview credential lifetime is unavailable', 'workspace_copy_preview_unavailable');
  }
  const context = input.context;
  const admission = context?.machineAdmission;
  const accountId = readAccountIdFromToken(input.credentials.token);
  if (!context || context.signal.aborted || !admission || !accountId
    || input.request.workspace.serverId !== input.serverId
    || (input.machineId !== input.request.machineId && input.machineId !== input.request.targetMachineId)
    || admission.machineId !== input.machineId || admission.role !== 'manage'
    || admission.actorAccountId !== accountId || admission.custodianAccountId !== accountId
    || !context.verifyMachineAdmissionCurrent || !await input.isCurrent()
    || !await context.verifyMachineAdmissionCurrent() || !await input.isCurrent()
    || context.signal.aborted) {
    throw new RpcError('Owned-copy preview requires current personal Machine admission', 'forbidden');
  }
}

/**
 * The production composition boundary for Lane 08. It constructs one root
 * owner, target authority, broker/manager lifecycle, controller, and handoff
 * adapter for the registered daemon machine. The retired legacy-state root is
 * inspected exactly once here, and the resulting availability assertion is
 * threaded into the controller and target authority so unknown or retired v1
 * state fails closed before any mutation. Engine startup is best-effort: the
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
    /** Actual target-child socket, preserving the original Home-admitted requester. */
    callWorkspaceTargetPhase?: (descriptor: WorkspaceSyncTargetPhaseDescriptor, context: RpcHandlerContext) => Promise<unknown>;
    /** Current installed physical TARGET socket, never the borrower's Parent Account transport. */
    callWorkspaceSeedExport?: (descriptor: Readonly<{ machineId: string;
      request: import('@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas').WorkspaceSyncSeedExportPrepareV1;
      signal?: AbortSignal }>, context: RpcHandlerContext) => Promise<unknown>;
    /** The actual installed target admission owner, never a count-derived projection. */
    readProjectWorkerDependencies?: (workspaceRefId: string, relationshipId?: string) => readonly ProjectWorkerDependencyV1[];
    openMachineCarrierTunnel?: WorkspaceSyncMachineTunnelOpen;
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
  const serverHttpBaseUrl = resolveServerHttpBaseUrl();
  const suppliedFactories: ProductionDaemonWorkspaceSyncFactories = { ...defaultFactories, ...overrides };
  const factories: ProductionDaemonWorkspaceSyncFactories = {
    ...suppliedFactories,
    getProjectSnapshot: () => {
      const snapshot = suppliedFactories.getProjectSnapshot();
      if (!snapshot) throw compositionError('project_account_rows_unavailable', 'Project records are unavailable');
      return snapshot;
    },
  };
  let inspection: WorkspaceSyncLegacyStateInspection;
  try {
    inspection = await factories.inspectLegacyState({
      activeServerDir: input.activeServerDir,
      installationId: input.localMachineId,
      nowMs: Date.now(),
    });
  } catch (error) {
    factories.warn('[DAEMON RUN] Failed to inspect retired workspace replication state', error);
    inspection = {
      status: 'legacy_workspace_sync_state_unknown',
      path: join(input.activeServerDir, 'workspace-replication'),
      reason: 'inspection_failed',
    };
  }
  const assertLegacyStateAvailable = (): void => createWorkspaceSyncLegacyStateGate(inspection)();
  const daemonDataRoot = join(input.happyHomeDir, 'daemon');
  const workspaceSyncRoot = join(daemonDataRoot, 'workspace-sync');
  const rootOwnershipManager = factories.createRootOwnershipManager({
    lockDirectory: factories.resolveRootOwnershipDirectory(),
  });
  let runtime: ReturnType<typeof createDaemonWorkspaceSyncRuntime> | null = null;
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
  const approvalsStore = createCliApprovalsArtifactStore({ credentials: input.credentials });
  const assertConflictResolutionAuthorized = createWorkspaceSyncConflictResolutionAuthorizer({
    approvalsGet: approvalsStore.approvalsGet,
    serverId: semanticServerId,
  });
  const assertTargetReplacementAuthorized = createWorkspaceDestinationApprovalAuthorizer({
    approvalsGet: approvalsStore.approvalsGet,
    serverId: semanticServerId,
  });
  const assertCommittedCopyRemovalAuthorized = createWorkspaceCommittedCopyRemovalAuthorizer({
    approvalsGet: approvalsStore.approvalsGet,
    serverId: semanticServerId,
  });
  const targetAuthority = factories.createTargetAuthority({
    localServerId: semanticServerId,
    localMachineId: input.localMachineId,
    getProjectSnapshot: factories.getProjectSnapshot,
    ...(input.callWorkspaceTargetPhase ? { callWorkspaceTargetPhase: input.callWorkspaceTargetPhase } : {}),
    refreshProjectSnapshot: async (signal, context) => await factories.refreshProjectRows({
      ...(context?.callerInputAuthorization ? { authorization: context.callerInputAuthorization,
        effectActionId: context.callerInputAuthorization.binding.actionId } : { credentials: input.credentials }),
      serverId: semanticServerId,
      ...(signal ? { signal } : {}),
    }),
    readChildMachineFacts: async (machineIds, signal) => await readWorkspaceSyncChildMachineFacts({
      serverId: semanticServerId,
      serverHttpBaseUrl, localProfileId, ...(input.homeTarget ? { homeTarget: input.homeTarget } : {}),
      credentials: input.credentials, machineIds, signal,
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
    assertLegacyStateAvailable,
    prepareSourceSeedExport: async ({ operationId, sourceWorkspaceRefId, targetMachineId, contentPolicy }) => {
      if (!runtime) {
        throw compositionError('workspace_sync_unavailable', 'Workspace sync runtime is unavailable');
      }
      return await runtime.managedWorkspaceSync.withAuthorizedSourceSeedExport({
        operationId,
        sourceWorkspaceRefId,
        targetMachineId,
        contentPolicy,
      }, async (sourcePath) => await factories.prepareSourceSeedExport({
        operationId,
        activeServerDir: input.activeServerDir,
        sourcePath,
        workspaceTransfer: resolveSeedWorkspaceTransfer(contentPolicy),
      }));
    },
    resolutionMaterialDirectory: join(input.activeServerDir, 'workspace-sync', 'resolution'),
    resolveLocalResolutionEndpoint: async (relationshipId, workspaceRefId) => await runtime?.managedWorkspaceSync.resolveLocalResolutionEndpoint(
      relationshipId, workspaceRefId,
    ) ?? null,
    requestResolutionExport: async (request) => {
      if (!input.requestDirectTransferPayloadFile) {
        throw compositionError('agent_unavailable', 'Reviewed workspace conflict transfer is unavailable');
      }
      if (request.sourceMachineId !== input.localMachineId && !input.openMachineCarrierTunnel) {
        throw compositionError('machine_carrier_unavailable', 'Reviewed workspace conflict source Machine carrier is unavailable');
      }
      const { signal: exportSignal, ...wireRequest } = request;
      const preparedRaw = await factories.callMachineRpc({
        credentials: input.credentials,
        machineId: request.sourceMachineId,
        method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
        request: { t: 'workspace_sync_resolution_v1', ...wireRequest },
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
            : await input.openMachineCarrierTunnel!({
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
            credentials: input.credentials,
            machineId: request.sourceMachineId,
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE,
            request: { transferId: request.operationId },
          });
        },
      };
    },
    bootstrap: {
      materializationDirectory: join(input.activeServerDir, 'workspace-sync', 'materialization'),
      rootOwnershipManager,
      prepareGitTarget: factories.prepareGitTarget,
      materializeLocalSeed: async ({ operationId, sourcePath, canonicalRoot, contentPolicy, materializationReceiptPath, originalTargetExists, targetFence }) => await factories.materializeLocalSeed({
        operationId,
        activeServerDir: input.activeServerDir,
        sourcePath,
        targetPath: canonicalRoot,
        materializationReceiptPath,
        originalTargetExists,
        targetFence,
        workspaceTransfer: resolveSeedWorkspaceTransfer(contentPolicy),
      }),
      ...(input.openMachineCarrierTunnel && input.requestDirectTransferPayloadFile
        ? { materializeRemoteSeed: async (request) => {
            const seedRequest = {
              t: 'workspace_sync_seed_v1' as const,
              operationId: request.operationId,
              sourceWorkspaceRefId: request.sourceWorkspaceRefId,
              targetMachineId: input.localMachineId,
              contentPolicy: request.contentPolicy,
            };
            const seedContext = request.context?.callerInputAuthorization?.binding.actionId === 'projects.open'
              && request.context.workspaceSyncSourceWriterTargetRouting !== undefined ? request.context : undefined;
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
                ...(request.signal ? { signal: request.signal } : {}),
              });
            const preparedRaw = await prepare.catch(() => {
                request.signal?.throwIfAborted();
                throw compositionError('target_bootstrap_offline', 'Workspace sync source seed is unavailable');
              });
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
      ...(request.signal ? { signal: request.signal } : {}),
    }),
  });

  const readHandoffProjectSnapshot = async (signal?: AbortSignal, context?: RpcHandlerContext) => {
    const authorization = context?.callerInputAuthorization;
    if (authorization && (authorization.binding.accountId !== context?.machineAdmission?.actorAccountId
      || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent())) {
      throw compositionError('project_requester_authority_unavailable', 'The admitted requester is no longer current');
    }
    const snapshot = authorization ? await factories.refreshProjectRows({ authorization,
      effectActionId: authorization.binding.actionId, serverId: semanticServerId, signal }) : factories.getProjectSnapshot();
    if (!snapshot) throw compositionError('workspace_sync_settings_unavailable', 'Workspace sync settings are unavailable');
    return snapshot;
  };
  const readHandoffChildMachines = async (machineIds: readonly string[], signal?: AbortSignal, context?: RpcHandlerContext) => {
    const authorization = context?.callerInputAuthorization;
    return await readWorkspaceSyncChildMachineFacts({ serverId: semanticServerId,
      ...(authorization ? { authorization, effectActionId: authorization.binding.actionId,
        ...(context?.requesterSessionBootstrap ? { credentials: context.requesterSessionBootstrap.credentials } : {}) }
        : { credentials: input.credentials }),
      serverHttpBaseUrl: authorization?.requesterHttpProjection?.serverHttpBaseUrl ?? serverHttpBaseUrl,
      localProfileId, ...(input.homeTarget ? { homeTarget: input.homeTarget } : {}), machineIds, signal });
  };
  const currentRouteSnapshot = async (request: WorkspaceSyncPrepareBetweenRequestV1, signal?: AbortSignal, context?: RpcHandlerContext) => {
    const snapshot = await readHandoffProjectSnapshot(signal, context);
    const serverId = semanticServerId;
    const workspaceRefs = snapshot.workspaceRefs.filter(ref => ref.serverId === serverId);
    const endpoints = workspaceRefs.filter(ref => ref.id === request.sourceWorkspaceRefId || ref.id === request.targetWorkspaceRefId);
    const childMachines = await readHandoffChildMachines(endpoints.map(ref => ref.machineId), signal, context);
    return {
      serverId,
      workspaceRefs,
      relationships: snapshot.relationships,
      childMachines,
    };
  };
  const currentRoute = async (request: WorkspaceSyncPrepareBetweenRequestV1, signal?: AbortSignal, context?: RpcHandlerContext) => {
    return resolveWorkspaceSyncTransferRoute({
      ...await currentRouteSnapshot(request, signal, context),
      sourceWorkspaceRefId: request.sourceWorkspaceRefId,
      targetWorkspaceRefId: request.targetWorkspaceRefId,
    });
  };
  const routeFailure = (route: Extract<Awaited<ReturnType<typeof currentRoute>>, { ok: false }>): WorkspaceSyncPrepareBetweenResultV1 => ({
    ok: false,
    errorCode: route.code,
    completed: [],
    ...('relationshipId' in route ? { blockedRelationshipId: route.relationshipId } : {}),
  });
  const prepareBetweenAtController = async (
    request: WorkspaceSyncPrepareBetweenRequestV1,
    signal?: AbortSignal,
    context?: RpcHandlerContext,
  ): Promise<WorkspaceSyncPrepareBetweenResultV1> => {
    if (!runtime) throw controllerUnavailable();
    const route = await currentRoute(request, signal, context);
    if (!route.ok) return routeFailure(route);
    if (route.kind !== 'same_workspace') assertWorkspaceSyncRequesterBootstrapSupported({
      authorization: context?.callerInputAuthorization, ownerKind: 'relationship' });
    if (route.kind !== 'same_workspace' && route.controllerMachineId !== input.localMachineId) {
      throw compositionError('workspace_sync_controller_mismatch', 'Linked workspace route belongs to another controller');
    }
    return await prepareWorkspaceSyncBetween({
      ...request,
      serverId: semanticServerId,
      readCurrent: async () => await currentRouteSnapshot(request, signal, context),
      flush: async (relationshipId, flushSignal) => await runtime!.managedWorkspaceSync.flush(relationshipId, flushSignal),
      ...(signal ? { signal } : {}),
    });
  };
  const handoffPrepareBetween = async (
    request: WorkspaceSyncPrepareBetweenRequestV1,
    signal?: AbortSignal,
    context?: RpcHandlerContext,
  ): Promise<WorkspaceSyncPrepareBetweenResultV1> => {
    const route = await currentRoute(request, signal, context);
    if (!route.ok) return routeFailure(route);
    if (route.kind !== 'same_workspace') assertWorkspaceSyncRequesterBootstrapSupported({
      authorization: context?.callerInputAuthorization, ownerKind: 'relationship' });
    if (route.kind === 'same_workspace' || route.controllerMachineId === input.localMachineId) {
      return await prepareBetweenAtController(request, signal, context);
    }
    try {
      const result = await factories.callMachineRpc({
        credentials: input.credentials,
        machineId: route.controllerMachineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN,
        request,
        ...(signal ? { signal } : {}),
      });
      return WorkspaceSyncPrepareBetweenResultV1Schema.parse(result);
    } catch (error) {
      if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
        return { ok: false, errorCode: 'workspace_sync_update_required', completed: [] };
      }
      throw error;
    }
  };

  const readHandoffExecutionBasis = async (request: Parameters<DaemonWorkspaceSyncRuntimeDependencies['bootstrap']>[0], context?: RpcHandlerContext,
    physicalSourceAuthority?: WorkspaceSyncSourceContextV1) => {
    const serverId = semanticServerId;
    if (physicalSourceAuthority) {
      // SOURCE ingress has already retained the original logical carrier. This
      // daemon owns only its native-bound source root, not the Actor's Project
      // rows or independently chosen target namespace.
      if (!context?.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()) {
        throw compositionError('workspace_sync_child_unavailable', 'Physical source admission is no longer current');
      }
      const snapshot = await readHandoffProjectSnapshot(request.signal);
      const childMachines = await readHandoffChildMachines([request.sourceMachineId], request.signal);
      const child = childMachines.find(child => child.machineId === request.sourceMachineId && child.serverId === serverId);
      if (!child || child.projection.observation.storage.kind !== 'bind'
        || child.controller.machineId !== input.localMachineId
        || (context.workspaceSyncSourceRouting ? child.installationId : child.controller.installationId)
          !== physicalSourceAuthority.machineAdmission.installationId) {
        throw compositionError('workspace_sync_child_unavailable', 'The admitted child does not resolve to this physical source');
      }
      const resolved = resolveWorkspaceSyncEndpoint({ namespace: { serverId, machineId: request.sourceMachineId,
        rootPath: request.sourceRootPath }, workspaceRefs: snapshot.workspaceRefs, childMachines });
      if (!resolved.ok || resolved.endpoint.machineId !== input.localMachineId) {
        throw compositionError('workspace_sync_child_unavailable', 'The physical source Workspace is unavailable');
      }
      return { snapshot, childMachines, input: { ...request, sourceWorkspaceRefId: resolved.endpoint.id,
        sourceMachineId: resolved.endpoint.machineId, sourceRootPath: resolved.endpoint.rootPath } };
    }
    const authorization = context?.callerInputAuthorization;
    const snapshot = await readHandoffProjectSnapshot(request.signal, context);
    if (authorization) {
      for (const endpoint of [
        { workspaceId: request.sourceWorkspaceRefId, machineId: request.sourceMachineId, rootPath: request.sourceRootPath },
        { workspaceId: request.targetWorkspaceRefId, machineId: request.targetMachineId, rootPath: request.targetRootPath },
      ]) {
        if (endpoint.workspaceId && resolveWorkspaceRefV1(snapshot.workspaceRefs, { serverId, ...endpoint }).kind !== 'resolved') {
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
      const resolved = resolveWorkspaceSyncEndpoint({ workspace: workspace.ref, workspaceRefs: snapshot.workspaceRefs, childMachines });
      if (!resolved.ok) throw compositionError('workspace_sync_child_unavailable', 'Child Sync endpoint is unavailable');
      return resolved.endpoint;
    };
    const sourceEndpoint = childEndpoint(request.sourceMachineId, request.sourceRootPath, request.sourceWorkspaceRefId);
    const targetEndpoint = childEndpoint(request.targetMachineId, request.targetRootPath, request.targetWorkspaceRefId);
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
  const resolveHandoffExecutionInput: NonNullable<DaemonWorkspaceSyncRuntimeDependencies['resolveHandoffExecutionInput']> = async (request, authority, context) => {
    const accepted = await readHandoffExecutionBasis(request, context, authority);
    const route = request.action.kind === 'linked_workspace' && accepted.input.sourceWorkspaceRefId && accepted.input.targetWorkspaceRefId
      ? resolveWorkspaceSyncTransferRoute({ serverId: semanticServerId, workspaceRefs: accepted.snapshot.workspaceRefs,
        relationships: accepted.snapshot.relationships, childMachines: accepted.childMachines,
        sourceWorkspaceRefId: accepted.input.sourceWorkspaceRefId, targetWorkspaceRefId: accepted.input.targetWorkspaceRefId }) : null;
    if (request.action.kind === 'create_relationship' || request.action.kind === 'relationship'
      || request.action.kind === 'linked_workspace' && !(route?.ok && route.kind === 'same_workspace')) {
      try {
        assertWorkspaceSyncRequesterBootstrapSupported({ authorization: context?.callerInputAuthorization, ownerKind: 'relationship' });
      } catch (error) {
        // This resolver runs only for a genuinely new prepared operation, before
        // relationship writes, target bootstrap, source RPC or engine effects.
        throw new WorkspaceSyncInitialPreparationRefusal(error);
      }
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
        destinationIntent: 'materialize_from_source_workspace', ...(request.signal ? { signal: request.signal } : {}),
      }, context);
      const target = targetPreflight.targetWorkspace;
      if (!target || !targetPreflight.physicalEndpoint || target.serverId !== semanticServerId
        || target.machineId !== targetPreflight.physicalEndpoint.machineId) {
        throw compositionError('workspace_sync_update_required', 'The qualified target Workspace is unavailable');
      }
      executionInput = { ...accepted.input, targetWorkspaceRefId: target.id,
        targetMachineId: target.machineId, targetRootPath: target.rootPath };
    }
    return { input: executionInput, ...(targetPreflight ? { targetPreflight } : {}), assertCurrent: async () => {
      const current = await readHandoffExecutionBasis(request, context, authority);
      if (current.childMachines.length !== accepted.childMachines.length
        || accepted.childMachines.some(child => {
          const now = current.childMachines.find(candidate => candidate.machineId === child.machineId && candidate.serverId === child.serverId);
          return !now || now.installationId !== child.installationId
            || !managedDevcontainerChildProjectionsEqualV1(now.projection, child.projection);
        })
        || (['sourceMachineId', 'targetMachineId', 'sourceWorkspaceRefId', 'targetWorkspaceRefId', 'sourceRootPath', 'targetRootPath'] as const)
          .some(field => current.input[field] !== accepted.input[field])) {
        throw compositionError('workspace_sync_child_unavailable', 'Child Sync custody changed before the effect');
      }
    } };
  };

  runtime = factories.createDaemonRuntime({
    daemonDataRoot,
    localServerId: semanticServerId,
    localMachineId: input.localMachineId,
    releaseChannel: input.releaseChannel,
    resolveWorkspaceRef: async (workspaceRefId, copyOperationId) => {
      const ref = (copyOperationId ? runtime?.handoffAdapter.resolvePreparedCopyTarget?.(copyOperationId, workspaceRefId) : null)
        ?? resolveWorkspaceRefById(
        factories.getProjectSnapshot()?.workspaceRefs ?? [],
        workspaceRefId,
        semanticServerId,
      );
      return ref ? { serverId: ref.serverId, machineId: ref.machineId, rootPath: ref.rootPath } : null;
    },
    rootOwnershipManager,
    borrowLinkedSourceRoot: async (operationId, workspaceRefId) => await targetAuthority.borrowSourceRootForCopy({ operationId, workspaceRefId }),
    prepareRelationshipTarget: async (relationship, signal, preparation) => {
      const target = resolveRelationshipBootstrapTarget(factories.getProjectSnapshot(), relationship, semanticServerId);
      const prepared = await targetAuthority.prepareBootstrapAtTarget({
        v: 1,
        bootstrapOperationId: relationship.relationshipId,
        owner: { kind: 'relationship', relationshipId: relationship.relationshipId },
        ...(preparation?.transient ? { transientRelationship: relationship } : {}),
        targetWorkspaceRefId: target.workspaceRefId,
        targetMachineId: target.machineId,
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
      });
      return prepared.ownershipHandles ? { ownershipHandles: prepared.ownershipHandles } : undefined;
    },
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
            ...(signal ? { signal } : {}),
          });
          return parseControllerStatusResponse(response);
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error && typeof error === 'object' && 'code' in error) throw error;
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
          || target.machineId !== targetPreflight.physicalEndpoint.machineId) {
          throw compositionError('workspace_sync_child_unavailable', 'The qualified target Workspace changed before preparation');
        }
        bootstrapInput = { ...bootstrapInput, targetWorkspaceRefId: target.id,
          targetMachineId: target.machineId, targetRootPath: target.rootPath };
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
        if (!sourceRef || sourceRef.machineId !== input.localMachineId) {
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
      } : undefined;
      let physicalTargetEndpoint: MachineInstallationPublicIdentityV1 | undefined;
      let sourceSeedTargetWorkspace: WorkspaceRefV1 | undefined;
      let acceptedTargetWorkspace: WorkspaceRefV1 | undefined;
      let retainedTargetCleanupContext: RpcHandlerContext | undefined;
      const releaseTarget = async (reason: 'abort' | 'copy_committed' | 'relationship_committed') => {
        const cleanupSignal = new AbortController().signal;
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
            destinationIntent: prepareRequest.targetBootstrap,
            ...(bootstrapInput.signal ? { signal: bootstrapInput.signal } : {}),
          }, context);
          if (!preflight.physicalEndpoint || !sourceRouting.sourceContext) {
            throw compositionError('workspace_sync_update_required', 'The installed target cleanup endpoint is unavailable');
          }
          const sourceWriter = context.workspaceSyncSourceWriterTargetRouting?.sourceWriter
            ?? basis.childMachines.find(child => child.machineId === sourceRouting.sourceMachineId)?.controller;
          const accountId = readAccountIdFromToken(input.credentials.token);
          if (!sourceWriter || sourceWriter.machineId !== input.localMachineId || !accountId
            || sourceRouting.sourceContext.machineAdmission.custodianAccountId !== accountId) {
            throw compositionError('workspace_sync_child_unavailable', 'The installed source cleanup identity is unavailable');
          }
          const retainedRouting = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({
            v: 1, sourceWriter: { machineId: sourceWriter.machineId, installationId: sourceWriter.installationId },
            source: sourceRouting,
            target: { v: 1, phase: 'release', operationId: prepareRequest.bootstrapOperationId,
              accountServerId: semanticServerId, targetMachineId: admittedTarget.machineId,
              targetRootPath: admittedTarget.rootPath },
          });
          // Current installed-custodian transport releases custody only. The
          // historical Actor and ceilings remain unchanged in the B snapshot;
          // the target retrieves its original admitted context from its loan.
          retainedTargetCleanupContext = {
            signal: new AbortController().signal, callerAuthority: 'present_user',
            machineAdmission: { ...sourceRouting.sourceContext.machineAdmission,
              actorAccountId: accountId, custodianAccountId: accountId, machineId: sourceWriter.machineId,
              installationId: sourceWriter.installationId, role: 'manage' },
            workspaceSyncSourceWriterTargetRouting: retainedRouting,
          };
          physicalTargetEndpoint = preflight.physicalEndpoint;
          if (preflight.targetWorkspace) {
            const target = preflight.targetWorkspace;
            if (bootstrapInput.action.kind !== 'copy_once' || target.serverId !== semanticServerId
              || target.id !== prepareRequest.targetWorkspaceRefId || target.machineId !== physicalTargetEndpoint.machineId
              || target.machineId !== bootstrapInput.targetMachineId || target.rootPath !== bootstrapInput.targetRootPath) {
              throw compositionError('workspace_sync_child_unavailable', 'The qualified seed target changed before preparation');
            }
            sourceSeedTargetWorkspace = target;
          }
        }
        const prepareTarget = async () => await targetAuthority.prepareBootstrapAtTarget({
          ...prepareRequest, ...(admittedTarget ? { admittedTarget } : {}),
        }, context);
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
            || target.machineId !== physicalTargetEndpoint.machineId) {
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
    ...(input.openMachineCarrierTunnel
      ? { openMachineCarrierTunnel: input.openMachineCarrierTunnel }
      : {}),
    stageConflictResolutionAtTarget: targetAuthority.stageConflictResolutionAtTarget,
    applyStagedConflictResolutionAtTarget: targetAuthority.applyStagedConflictResolutionAtTarget,
    discardStagedConflictResolutionAtTarget: targetAuthority.discardStagedConflictResolutionAtTarget,
    releaseConflictResolutionCaptureAtSource: targetAuthority.releaseConflictResolutionCaptureAtSource,
    recoverConflictResolutionAtTarget: targetAuthority.recoverConflictResolutionAtTarget,
    readFileAtTarget: targetAuthority.readFileAtTarget,
    observeEntryAtTarget: targetAuthority.observeEntryAtTarget,
    assertConflictResolutionAuthorized,
    getProjectSnapshot: factories.getProjectSnapshot,
    assertLegacyStateAvailable,
    onEngineReadinessPublished: publishReadiness,
    ...(input.onStatusPublished ? { onStatusPublished: input.onStatusPublished } : {}),
  });

  relationshipOwner = factories.createRelationshipOwner({
    localMachineId: input.localMachineId,
    mutateProjectSnapshot: createProjectAccountRowsWorkspaceSyncRelationshipMutation(input.credentials),
    readProjectSnapshot: async () => {
      return await factories.refreshProjectRows({ credentials: input.credentials });
    },
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
      const refreshed = await factories.refreshProjectRows({
        credentials: input.credentials,
        ...(signal ? { signal } : {}),
      });
      await runtime.whenProjectsSettled({
        graphRevision: graphRevision < 0 ? 'absent' : graphRevision,
        ...(refreshed.scopeKey ? { scopeKey: refreshed.scopeKey } : {}),
        ...(signal ? { signal } : {}),
      });
    },
    readRelationshipDependencies: async (relationship, snapshot) => {
      const serverId = semanticServerId;
      const machineIds = resolveWorkspaceSyncRelationshipDependencyMachines({ ...snapshot, serverId,
        relationshipId: relationship.relationshipId });
      const dependencies = await Promise.all(machineIds.flatMap(machineId =>
        [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId].map(async (workspaceRefId) => {
        if (machineId === input.localMachineId) {
          if (!input.readProjectWorkerDependencies) throw compositionError('workspace_sync_dependencies_unavailable', 'Worker dependency owner is unavailable');
          return input.readProjectWorkerDependencies(workspaceRefId, relationship.relationshipId);
        }
        try {
          return ProjectWorkerDependencyV1Schema.array().parse(await factories.callMachineRpc({
            credentials: input.credentials, machineId,
            method: RPC_METHODS.DAEMON_PROJECT_WORKER_DEPENDENCIES,
            request: { serverId, machineId,
              workspaceRefId, relationshipId: relationship.relationshipId },
          }));
        } catch {
          throw compositionError('workspace_sync_dependencies_unavailable', 'Worker dependency observation is unavailable');
        }
      })));
      return [...new Map(dependencies.flat().map(dependency => [dependency.operationId, dependency])).values()];
    },
    inspectCommittedRelationshipTarget: async (_relationship, _removal, signal, approval) => {
      if (!approval) throw compositionError('approval_required', 'Committed-copy removal approval is required');
      await targetAuthority.inspectCommittedCopyAtTarget({ ...approval, ...(signal ? { signal } : {}) });
    },
    removeCommittedRelationshipTarget: async (_relationship, _removal, signal, approval) => {
      if (!approval) throw compositionError('approval_required', 'Committed-copy removal approval is required');
      await targetAuthority.removeCommittedCopyAtTarget({ ...approval, ...(signal ? { signal } : {}) });
    },
  });

  let authorityTail = Promise.resolve();
  const reconcileAuthority = (): void => {
    authorityTail = authorityTail
      .catch(() => undefined)
      .then(async () => await targetAuthority.reconcileRetainedBootstraps());
    void authorityTail.catch((error) => {
      factories.warn('[DAEMON RUN] Failed to reconcile workspace sync target bootstrap ownership', error);
    });
  };
  const unsubscribe = factories.subscribeProjectSnapshot(() => reconcileAuthority());
  reconcileAuthority();
  await authorityTail.catch(() => undefined);
  await runtime.start().then(
    () => publishReadiness({ state: 'ready' }),
    (error) => {
      publishReadiness({ state: 'unavailable', errorCode: 'engine_unavailable' });
    factories.warn(
      '[DAEMON RUN] Workspace sync engine is initially unavailable; commands and settings changes may retry it',
      error,
    );
    },
  );

  const committedRelationshipOwner = relationshipOwner;
  const relationshipCreateDependencies: WorkspaceSyncRelationshipCreateDependencies = {
    localServerId: semanticServerId,
    localMachineId: input.localMachineId,
    resolveWorkspaceRef: (workspaceRefId) => {
      const ref = resolveWorkspaceRefById(
        factories.getProjectSnapshot()?.workspaceRefs ?? [],
        workspaceRefId,
        semanticServerId,
      );
      return ref ? { serverId: ref.serverId, machineId: ref.machineId, rootPath: ref.rootPath } : null;
    },
    relationshipOwner: committedRelationshipOwner,
  };

  const workspaceSync: MachineWorkspaceSyncRpcService = {
    handoffSourcePhase: async (request, context) => {
      const serverId = semanticServerId;
      const admission = context?.machineAdmission;
      if (request.input.accountServerId !== serverId || !admission || !context
        || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()) {
        throw compositionError('workspace_sync_child_unavailable', 'Physical source admission is unavailable');
      }
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
        const accepted = await readHandoffExecutionBasis({ ...request.input, signal: context.signal }, context, authority);
        assertOriginalTargetAuthority(request.input, accepted.input, authority, context);
        const child = accepted.childMachines.find(child => child.machineId === request.input.sourceMachineId);
        if (!child || child.projection.observation.storage.kind !== 'bind'
          || accepted.input.sourceMachineId !== input.localMachineId
          || (delegated ? child.installationId : child.controller.installationId) !== admission.installationId) {
          throw compositionError('workspace_sync_child_unavailable', 'The admitted child does not resolve to this physical source');
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
      setEnabled: async (relationshipId, enabled, signal) => await committedRelationshipOwner.setEnabled(relationshipId, enabled, signal),
      stop: async (relationshipId, signal, retirement) => await committedRelationshipOwner.stop(relationshipId, signal, retirement),
      create: async (request, signal) => await factories.createRelationshipForProject(
        relationshipCreateDependencies,
        request,
        signal,
      ),
    },
    stageConflictResolutionAtTarget: targetAuthority.stageConflictResolutionHere,
    applyStagedConflictResolutionAtTarget: targetAuthority.applyStagedConflictResolutionHere,
    discardStagedConflictResolutionAtTarget: targetAuthority.discardStagedConflictResolutionHere,
    releaseConflictResolutionCaptureHere: targetAuthority.releaseConflictResolutionCaptureHere,
    recoverConflictResolutionAtTarget: targetAuthority.recoverConflictResolutionHere,
    readFileAtTarget: targetAuthority.readFileHere,
    observeEntryAtTarget: targetAuthority.observeEntryHere,
    preflightHandoffTargetReplacement: targetAuthority.preflightHandoffTargetReplacementHere,
    prepareBootstrapAtTarget: targetAuthority.prepareBootstrapHere,
    releaseBootstrapAtTarget: targetAuthority.releaseBootstrapHere,
    prepareSourceSeedExport: targetAuthority.prepareSourceSeedExport,
    prepareConflictResolutionExport: targetAuthority.prepareConflictResolutionExport,
    assertConflictResolutionAuthorized,
    inspectRetiredState: async (signal): Promise<WorkspaceSyncLegacyStateInspectionV1> => {
      signal?.throwIfAborted();
      try {
        inspection = await factories.inspectLegacyState({
          activeServerDir: input.activeServerDir,
          installationId: input.localMachineId,
          nowMs: Date.now(),
        });
      } catch (error) {
        factories.warn('[DAEMON RUN] Failed to reinspect retired workspace replication state', error);
        inspection = {
          status: 'legacy_workspace_sync_state_unknown',
          path: join(input.activeServerDir, 'workspace-replication'),
          reason: 'inspection_failed',
        };
      }
      if (inspection.status === 'absent') return { status: 'absent' };
      if (inspection.status === 'legacy_workspace_sync_state_unknown') return inspection;
      return {
        status: inspection.status,
        classification: inspection.classification,
        quarantinePath: inspection.quarantinePath,
        schemaVersion: inspection.schemaVersion,
      };
    },
    inspectCommittedCopyHere: async (request, signal, context) => {
      if ('kind' in request) {
        const current = { request, context, serverId: semanticServerId,
          machineId: input.localMachineId, credentials: input.credentials, isCurrent: input.isCurrent };
        await assertCurrentPersonalWorkspaceCopyPreview(current);
        const result = await targetAuthority.previewCommittedCopyAtTarget({ ...request, ...(signal ? { signal } : {}) });
        await assertCurrentPersonalWorkspaceCopyPreview(current);
        return result;
      }
      await targetAuthority.inspectCommittedCopyHere({ ...request, ...(signal ? { signal } : {}) });
      return { ok: true };
    },
    removeCommittedCopyHere: async (request, signal) => {
      await targetAuthority.removeCommittedCopyHere({ ...request, ...(signal ? { signal } : {}) });
      return { ok: true };
    },
    readProjectWorkerDependencies: async (request, signal) => {
      if (request.serverId !== (semanticServerId)
        || request.machineId !== input.localMachineId || !input.readProjectWorkerDependencies) {
        throw compositionError('workspace_sync_dependencies_unavailable', 'Worker dependency target is unavailable');
      }
      const snapshot = await factories.refreshProjectRows({ credentials: input.credentials, serverId: request.serverId, signal });
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
  const activitySources = [runtime.managedWorkspaceSync.activity ?? missingActivity,
    targetAuthority.activity ?? missingActivity];
  return {
    handoffAdapter: runtime.handoffAdapter,
    activity: {
      read: async () => {
        const observations = await Promise.all(activitySources.map(source => source.read()));
        return { items: observations.flatMap(observation => observation.items),
          coverage: observations.every(observation => observation.coverage === 'complete') ? 'complete' : 'unknown' };
      },
      subscribe: listener => {
        const cleanup = activitySources.map(source => source.subscribe(listener));
        return () => { for (const unsubscribe of cleanup) unsubscribe(); };
      },
    },
    workspaceSync,
    acquireWorkspaceSyncMachineIngress: targetAuthority.acquireWorkspaceSyncMachineIngress,
    stop: () => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        unsubscribe();
        await authorityTail.catch(() => undefined);
        const failures: unknown[] = [];
        await runtime.stop().catch((error: unknown) => { failures.push(error); });
        await targetAuthority.releaseAllRetainedBootstraps().catch((error: unknown) => {
          failures.push(error);
        });
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
