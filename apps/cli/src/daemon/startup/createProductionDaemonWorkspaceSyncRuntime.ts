import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
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
} from '@happier-dev/protocol';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { WorkspaceSyncConflictResolveActionInputV1Schema, WorkspaceSyncStatusV1Schema, WorkspaceSyncPrepareBetweenResultV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveWorkspaceSyncTransferRoute } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { TransferEndpointCandidateSchema } from '@happier-dev/protocol/machines/transfer/transferStream';
import type { TransferEndpointCandidate } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';

import type { MachineWorkspaceSyncRpcService } from '@/api/machine/rpcHandlers.workspaceSync';
import type { StoredCredentials } from '@/persistence';
import { resolveWorkspaceSyncRootOwnershipDirectory } from '@/configuration/resolveWorkspaceSyncRootOwnershipDirectory';
import { configuration } from '@/configuration';
import {
  getActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsSnapshot,
  type ActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveWorkspaceSyncRelationshipEndpointRoles } from '@/workspaces/sync/workspaceSyncRelationshipEndpoints';
import { resolveWorkspaceRefById } from '@/settings/accountSettings/workspaceRefsV1';
import { refreshAccountSettingsForMinimumVersion } from '@/settings/accountSettings/refreshAccountSettingsForMinimumVersion';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { logger } from '@/ui/logger';
import {
  createWorkspaceRootOwnershipManager,
  type WorkspaceRootOwnershipHandle,
} from '@/workspaces/sync/workspaceSyncRootOwnership';
import {
  createWorkspaceSyncTargetAuthority,
  type AcquireWorkspaceSyncMachineIngressRequest,
  type WorkspaceSyncMachineIngress,
} from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { prepareWorkspaceSyncGitTarget } from '@/workspaces/sync/workspaceSyncTargetBootstrap';
import { prepareWorkspaceSyncBetween } from '@/workspaces/sync/workspaceSyncPreparation';
import { createWorkspaceSyncSeedExport, materializeLocalWorkspaceSyncSeed, materializeWorkspaceSyncSeedExport, resolveWorkspaceSyncSeedTransfer as resolveSeedWorkspaceTransfer } from '@/workspaces/sync/workspaceSyncSeedTransfer';
import { materializeWorkspaceExportArtifactsWithScmWorkspace } from '@/scm/workspace/workspaceExportMaterialization';
import { buildDirectPeerTransferEndpointPath } from '@/machines/transfer/directPeerTransport';
import { createWorkspaceSyncPeerIdentityValidator } from '@/workspaces/sync/transport/workspaceSyncPeerIdentity';
import {
  createWorkspaceSyncLegacyStateGate,
  inspectRetiredWorkspaceReplicationState,
  type WorkspaceSyncLegacyStateInspection,
} from '@/workspaces/sync/workspaceSyncLegacyState';
import type { WorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import {
  createAccountSettingsWorkspaceSyncRelationshipMutation,
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
  getSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
  subscribeSettingsSnapshot: typeof subscribeActiveAccountSettingsSnapshot;
  callMachineRpc: typeof callMachineRpc;
  inspectLegacyState: typeof inspectRetiredWorkspaceReplicationState;
  prepareGitTarget: typeof prepareWorkspaceSyncGitTarget;
  createRelationshipOwner: typeof createWorkspaceSyncRelationshipOwner;
  createRelationshipForProject: typeof createWorkspaceSyncRelationshipForProject;
  refreshSettings: typeof refreshAccountSettingsForMinimumVersion;
  prepareSourceSeedExport: typeof createWorkspaceSyncSeedExport;
  materializeSeedExport: typeof materializeWorkspaceSyncSeedExport;
  materializeLocalSeed: typeof materializeLocalWorkspaceSyncSeed;
  warn(message: string, error: unknown): void;
}>;

export type ProductionDaemonWorkspaceSyncRuntime = Readonly<{
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
  getSettingsSnapshot: getActiveAccountSettingsSnapshot,
  subscribeSettingsSnapshot: subscribeActiveAccountSettingsSnapshot,
  callMachineRpc,
  inspectLegacyState: inspectRetiredWorkspaceReplicationState,
  prepareGitTarget: prepareWorkspaceSyncGitTarget,
  createRelationshipOwner: createWorkspaceSyncRelationshipOwner,
  createRelationshipForProject: createWorkspaceSyncRelationshipForProject,
  refreshSettings: refreshAccountSettingsForMinimumVersion,
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
  actionId: 'workspace.sync.conflict.resolve' | 'session.handoff' | 'workspace.sync.relationship.create';
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
  snapshot: ActiveAccountSettingsSnapshot | null,
  relationshipId: string,
): WorkspaceSyncRelationshipV1 {
  const matches = (snapshot?.settings.workspaceSyncRelationshipsV1 ?? []).filter((candidate) => (
    candidate.relationshipId === relationshipId && candidate.enabled
  ));
  if (matches.length !== 1) {
    throw compositionError('relationship_not_ready', 'Workspace sync relationship is not ready');
  }
  return matches[0]!;
}

function resolveRelationshipBootstrapTarget(
  snapshot: ActiveAccountSettingsSnapshot | null,
  relationship: WorkspaceSyncRelationshipV1,
): Readonly<{ workspaceRefId: string; machineId: string; endpointRole: 'alpha' | 'beta' }> {
  const refs = snapshot?.settings.workspaceRefsV1 ?? [];
  const alpha = resolveWorkspaceRefById(refs, relationship.alphaWorkspaceRefId);
  const beta = resolveWorkspaceRefById(refs, relationship.betaWorkspaceRefId);
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
  snapshot: ActiveAccountSettingsSnapshot | null,
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
      workspaceRefs: snapshot?.settings.workspaceRefsV1 ?? [],
      relationships: snapshot?.settings.workspaceSyncRelationshipsV1 ?? [],
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
    localMachineId: string;
    releaseChannel: PublicReleaseRingId;
    credentials: StoredCredentials;
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
  const factories: ProductionDaemonWorkspaceSyncFactories = { ...defaultFactories, ...overrides };
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
    serverId: input.activeServerId ?? configuration.activeServerId,
  });
  const assertTargetReplacementAuthorized = createWorkspaceDestinationApprovalAuthorizer({
    approvalsGet: approvalsStore.approvalsGet,
    serverId: input.activeServerId ?? configuration.activeServerId,
  });
  const targetAuthority = factories.createTargetAuthority({
    localServerId: input.activeServerId ?? configuration.activeServerId,
    localMachineId: input.localMachineId,
    getSettingsSnapshot: factories.getSettingsSnapshot,
    assertConflictResolutionAuthorized,
    assertTargetReplacementAuthorized,
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
            const preparedRaw = await factories.callMachineRpc({
                credentials: input.credentials,
                machineId: request.sourceMachineId,
                method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
                request: {
                  t: 'workspace_sync_seed_v1',
                  operationId: request.operationId,
                  sourceWorkspaceRefId: request.sourceWorkspaceRefId,
                  targetMachineId: input.localMachineId,
                  contentPolicy: request.contentPolicy,
                },
                ...(request.signal ? { signal: request.signal } : {}),
              })
              .catch(() => {
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

  const currentRoute = (request: WorkspaceSyncPrepareBetweenRequestV1) => {
    const snapshot = factories.getSettingsSnapshot();
    const serverId = input.activeServerId ?? configuration.activeServerId;
    return resolveWorkspaceSyncTransferRoute({
      workspaceRefs: (snapshot?.settings.workspaceRefsV1 ?? []).filter((ref) => ref.serverId === serverId),
      relationships: snapshot?.settings.workspaceSyncRelationshipsV1 ?? [],
      sourceWorkspaceRefId: request.sourceWorkspaceRefId,
      targetWorkspaceRefId: request.targetWorkspaceRefId,
    });
  };
  const routeFailure = (route: Extract<ReturnType<typeof currentRoute>, { ok: false }>): WorkspaceSyncPrepareBetweenResultV1 => ({
    ok: false,
    errorCode: route.code,
    completed: [],
    ...('relationshipId' in route ? { blockedRelationshipId: route.relationshipId } : {}),
  });
  const prepareBetweenAtController = async (
    request: WorkspaceSyncPrepareBetweenRequestV1,
    signal?: AbortSignal,
  ): Promise<WorkspaceSyncPrepareBetweenResultV1> => {
    if (!runtime) throw controllerUnavailable();
    const route = currentRoute(request);
    if (!route.ok) return routeFailure(route);
    if (route.kind !== 'same_workspace' && route.controllerMachineId !== input.localMachineId) {
      throw compositionError('workspace_sync_controller_mismatch', 'Linked workspace route belongs to another controller');
    }
    return await prepareWorkspaceSyncBetween({
      ...request,
      readCurrent: async () => {
        const snapshot = factories.getSettingsSnapshot();
        if (!snapshot) throw compositionError('workspace_sync_settings_unavailable', 'Workspace sync settings are unavailable');
        return {
          workspaceRefs: snapshot.settings.workspaceRefsV1.filter((ref) => (
            ref.serverId === (input.activeServerId ?? configuration.activeServerId)
          )),
          relationships: snapshot.settings.workspaceSyncRelationshipsV1,
        };
      },
      flush: async (relationshipId, flushSignal) => await runtime!.managedWorkspaceSync.flush(relationshipId, flushSignal),
      ...(signal ? { signal } : {}),
    });
  };
  const handoffPrepareBetween = async (
    request: WorkspaceSyncPrepareBetweenRequestV1,
    signal?: AbortSignal,
  ): Promise<WorkspaceSyncPrepareBetweenResultV1> => {
    const route = currentRoute(request);
    if (!route.ok) return routeFailure(route);
    if (route.kind === 'same_workspace' || route.controllerMachineId === input.localMachineId) {
      return await prepareBetweenAtController(request, signal);
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

  runtime = factories.createDaemonRuntime({
    daemonDataRoot,
    localServerId: input.activeServerId ?? configuration.activeServerId,
    localMachineId: input.localMachineId,
    releaseChannel: input.releaseChannel,
    resolveWorkspaceRef: async (workspaceRefId) => {
      const ref = resolveWorkspaceRefById(
        factories.getSettingsSnapshot()?.settings.workspaceRefsV1 ?? [],
        workspaceRefId,
      );
      return ref ? { serverId: ref.serverId, machineId: ref.machineId, rootPath: ref.rootPath } : null;
    },
    rootOwnershipManager,
    borrowLinkedSourceRoot: async (operationId, workspaceRefId) => await targetAuthority.borrowSourceRootForCopy({ operationId, workspaceRefId }),
    prepareRelationshipTarget: async (relationship, signal, preparation) => {
      const target = resolveRelationshipBootstrapTarget(factories.getSettingsSnapshot(), relationship);
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
        factories.getSettingsSnapshot()?.settings.workspaceRefsV1 ?? [],
        operation.betaWorkspaceRefId,
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
        const relationship = resolveRelationship(factories.getSettingsSnapshot(), relationshipId);
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
    bootstrap: async (bootstrapInput) => {
      const prepareRequest = resolveBootstrapPrepareRequest(
        bootstrapInput,
        factories.getSettingsSnapshot(),
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
          factories.getSettingsSnapshot()?.settings.workspaceRefsV1 ?? [],
          sourceWorkspaceRefId,
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
      try {
        const prepareTarget = async () => await targetAuthority.prepareBootstrapAtTarget(prepareRequest);
        const preparedTarget = sourceOwnership && copySourceWorkspaceRefId && copyTargetWorkspaceRefId
          && bootstrapInput.action.kind === 'copy_once' && runtime
          ? await runtime.managedWorkspaceSync.withSourceSeedAuthorization({
              v: 1,
              operationId: bootstrapInput.operationId,
              controllerMachineId: bootstrapInput.sourceMachineId,
              alphaWorkspaceRefId: copySourceWorkspaceRefId,
              betaWorkspaceRefId: copyTargetWorkspaceRefId,
              contentPolicy: bootstrapInput.action.contentPolicy,
            }, [sourceOwnership], prepareTarget)
          : await prepareTarget();
        targetOwnershipHandles = preparedTarget.ownershipHandles ?? [];
      } catch (error) {
        await releaseSourceOwnership?.();
        throw error;
      }
      let released = false;
      let sourceReleased = false;
      const targetWorkspaceRefId = prepareRequest.targetWorkspaceRefId;
      return {
        ...((sourceOwnership || targetOwnershipHandles.length > 0)
          ? { ownershipHandles: [...(sourceOwnership ? [sourceOwnership] : []), ...targetOwnershipHandles] }
          : {}),
        release: async (reason) => {
          if (released) return;
          try {
            if (reason === 'abort' || bootstrapInput.action.kind === 'copy_once' || bootstrapInput.action.kind === 'create_relationship') {
              await targetAuthority.releaseBootstrapAtTarget({
                v: 1,
                bootstrapOperationId: bootstrapInput.operationId,
                targetWorkspaceRefId,
                targetMachineId: bootstrapInput.targetMachineId,
                reason: reason === 'commit'
                  ? bootstrapInput.action.kind === 'copy_once'
                    ? 'copy_committed'
                    : 'relationship_committed'
                  : 'abort',
              });
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
    getSettingsSnapshot: factories.getSettingsSnapshot,
    assertLegacyStateAvailable,
    onEngineReadinessPublished: publishReadiness,
    ...(input.onStatusPublished ? { onStatusPublished: input.onStatusPublished } : {}),
  });

  relationshipOwner = factories.createRelationshipOwner({
    localMachineId: input.localMachineId,
    mutateSettings: createAccountSettingsWorkspaceSyncRelationshipMutation(input.credentials),
    readSettings: async () => {
      const refreshed = await factories.refreshSettings({ credentials: input.credentials, forceRefresh: true });
      return refreshed.rawSettings ?? refreshed.settings;
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
      const target = resolveRelationshipBootstrapTarget(factories.getSettingsSnapshot(), relationship);
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
      const target = resolveRelationshipBootstrapTarget(factories.getSettingsSnapshot(), relationship);
      await targetAuthority.releaseBootstrapAtTarget({
        v: 1,
        bootstrapOperationId: relationship.relationshipId,
        targetWorkspaceRefId: target.workspaceRefId,
        targetMachineId: target.machineId,
        reason: 'abort',
      });
    },
    waitForSettingsReconciliation: async (settingsVersion, signal) => {
      if (!runtime) throw controllerUnavailable();
      signal?.throwIfAborted();
      const refreshed = await factories.refreshSettings({
        credentials: input.credentials,
        minSettingsVersion: settingsVersion,
        forceRefresh: true,
      });
      await runtime.whenSettingsSettled({
        settingsVersion,
        ...(refreshed.scopeKey ? { scopeKey: refreshed.scopeKey } : {}),
        ...(signal ? { signal } : {}),
      });
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
  const unsubscribe = factories.subscribeSettingsSnapshot(() => reconcileAuthority());
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
    localServerId: input.activeServerId ?? configuration.activeServerId,
    localMachineId: input.localMachineId,
    resolveWorkspaceRef: (workspaceRefId) => {
      const ref = resolveWorkspaceRefById(
        factories.getSettingsSnapshot()?.settings.workspaceRefsV1 ?? [],
        workspaceRefId,
      );
      return ref ? { serverId: ref.serverId, machineId: ref.machineId, rootPath: ref.rootPath } : null;
    },
    relationshipOwner: committedRelationshipOwner,
  };

  const workspaceSync: MachineWorkspaceSyncRpcService = {
    controller: runtime.managedWorkspaceSync,
    prepareBetween: prepareBetweenAtController,
    relationshipOwner: {
      setEnabled: async (relationshipId, enabled, signal) => await committedRelationshipOwner.setEnabled(relationshipId, enabled, signal),
      stop: async (relationshipId, signal) => await committedRelationshipOwner.stop(relationshipId, signal),
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
  };
  let stopPromise: Promise<void> | null = null;
  return {
    handoffAdapter: runtime.handoffAdapter,
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
