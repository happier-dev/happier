import { ReadWorkspaceSyncFileResultV1Schema, ReadWorkspaceSyncFileV1Schema, HandoffTargetReplacementPreflightResultV1Schema, HandoffTargetReplacementPreflightV1Schema, WorkspaceSyncConflictPageRequestV1Schema, WorkspaceSyncConflictPageV1Schema, WorkspaceSyncRelationshipsListRpcRequestV1Schema, WorkspaceSyncRelationshipsListRpcResultV1Schema, WorkspaceSyncConflictInspectRpcRequestV1Schema, WorkspaceSyncConflictInspectRpcResultV1Schema, WorkspaceSyncConflictResolveRpcInputV1Schema, WorkspaceSyncConflictResolutionResultV1Schema, WorkspaceSyncRelationshipCreateResultV1Schema, WorkspaceSyncRelationshipCreateRpcRequestV1Schema, WorkspaceSyncRelationshipIdV1Schema, WorkspaceSyncLegacyStateInspectionV1Schema, WorkspaceSyncStatusV1Schema, WorkspaceSyncPrepareBetweenRequestV1Schema, WorkspaceSyncPrepareBetweenResultV1Schema, WorkspaceSyncTargetBootstrapPrepareResultV1Schema, WorkspaceSyncTargetBootstrapPrepareV1Schema, WorkspaceSyncTargetBootstrapReleaseResultV1Schema, WorkspaceSyncTargetBootstrapReleaseV1Schema, WorkspaceSyncTargetConflictStageV1Schema, WorkspaceSyncConflictCaptureReleaseV1Schema, WorkspaceSyncTargetConflictApplyV1Schema, WorkspaceSyncTargetConflictApplyResultV1Schema, WorkspaceSyncTargetConflictRecoverV1Schema, WorkspaceSyncTargetConflictRecoverResultV1Schema, WorkspaceSyncTargetFileReadV1Schema, WorkspaceSyncTargetEntryObserveV1Schema, WorkspaceSyncEntryExpectationV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { WorkspaceSyncConflictResolutionResultV1, WorkspaceSyncConflictResolutionV1, WorkspaceSyncConflictResolveActionInputV1, ReadWorkspaceSyncFileResultV1, ReadWorkspaceSyncFileV1, HandoffTargetReplacementPreflightResultV1, HandoffTargetReplacementPreflightV1, WorkspaceSyncConflictPageRequestV1, WorkspaceSyncConflictPageV1, WorkspaceSyncRelationshipsListRpcRequestV1, WorkspaceSyncRelationshipsListRpcResultV1, WorkspaceSyncConflictInspectRpcRequestV1, WorkspaceSyncConflictInspectRpcResultV1, WorkspaceSyncRelationshipCreateResultV1, WorkspaceSyncRelationshipCreateRpcRequestV1, WorkspaceContentPolicyV1, WorkspaceSyncStatusV1, WorkspaceSyncPrepareBetweenRequestV1, WorkspaceSyncPrepareBetweenResultV1, WorkspaceSyncLegacyStateInspectionV1, WorkspaceSyncTargetBootstrapPrepareResultV1, WorkspaceSyncTargetBootstrapPrepareV1, WorkspaceSyncTargetBootstrapReleaseResultV1, WorkspaceSyncTargetBootstrapReleaseV1, WorkspaceSyncTargetConflictStageV1, WorkspaceSyncConflictCaptureReleaseV1, WorkspaceSyncTargetConflictApplyV1, WorkspaceSyncTargetConflictApplyResultV1, WorkspaceSyncTargetConflictRecoverV1, WorkspaceSyncTargetConflictRecoverResultV1, WorkspaceSyncTargetFileReadV1, WorkspaceSyncTargetEntryObserveV1, WorkspaceSyncEntryExpectationV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import type { RpcHandler, RpcHandlerRegistrar, RpcHandlerContext } from '../rpc/types';
import { WorkspaceSyncHandoffSourcePhaseRequestV1Schema, WorkspaceSyncHandoffSourcePhaseResultV1Schema,
  type WorkspaceSyncHandoffSourcePhaseRequestV1, type WorkspaceSyncHandoffSourcePhaseResultV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { DirectPeerOnDemandTransferScope } from '@/machines/transfer/directPeerTransport';
import type { TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import type { WorkspaceSyncRelationshipOwner } from '@/workspaces/sync/workspaceSyncRelationshipOwner';
import { ProjectWorkerDependencyQueryV1Schema, ProjectWorkerDependencyV1Schema,
  type ProjectWorkerDependencyQueryV1, type ProjectWorkerDependencyV1 } from '@happier-dev/protocol/workspaces/projectWorkerExecutionV1';
import { WorkspaceSyncCommittedCopyTargetV1Schema, WorkspaceSyncCommittedCopyTargetResultV1Schema,
  WorkspaceSyncCommittedCopyInspectV1Schema, WorkspaceSyncCommittedCopyPreviewResultV1Schema,
  type WorkspaceSyncCommittedCopyInspectV1, type WorkspaceSyncCommittedCopyInspectResultV1,
  type WorkspaceSyncCommittedCopyTargetV1, type WorkspaceSyncCommittedCopyTargetResultV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncCommittedCopyV1';

export type WorkspaceSyncRpcController = Readonly<{
  get(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1 | null>;
  list(signal?: AbortSignal): Promise<readonly WorkspaceSyncStatusV1[]>;
  flush(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  pause(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  resume(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  terminate(relationshipId: string, signal?: AbortSignal): Promise<void>;
  listConflicts(request: WorkspaceSyncConflictPageRequestV1, signal?: AbortSignal): Promise<WorkspaceSyncConflictPageV1>;
  listRelationships(request: WorkspaceSyncRelationshipsListRpcRequestV1, signal?: AbortSignal): Promise<WorkspaceSyncRelationshipsListRpcResultV1>;
  inspectConflict(request: WorkspaceSyncConflictInspectRpcRequestV1, signal?: AbortSignal): Promise<WorkspaceSyncConflictInspectRpcResultV1>;
  resolveConflict(
    request: WorkspaceSyncConflictResolutionV1,
    signal: AbortSignal | undefined,
    actionReceiptId: string,
  ): Promise<WorkspaceSyncConflictResolutionResultV1>;
  readFile(request: ReadWorkspaceSyncFileV1, signal?: AbortSignal): Promise<ReadWorkspaceSyncFileResultV1>;
}>;

export type MachineWorkspaceSyncRpcService = Readonly<{
  handoffSourcePhase?(request: WorkspaceSyncHandoffSourcePhaseRequestV1, context?: RpcHandlerContext): Promise<WorkspaceSyncHandoffSourcePhaseResultV1>;
  controller: WorkspaceSyncRpcController;
  prepareBetween(request: WorkspaceSyncPrepareBetweenRequestV1, signal?: AbortSignal): Promise<WorkspaceSyncPrepareBetweenResultV1>;
  relationshipOwner: Readonly<{
    setEnabled(relationshipId: string, enabled: boolean, signal?: AbortSignal): Promise<void>;
    stop: WorkspaceSyncRelationshipOwner['stop'];
    /** Direct Project linking; the same single relationship writer as handoff. */
    create(
      request: WorkspaceSyncRelationshipCreateRpcRequestV1,
      signal?: AbortSignal,
    ): Promise<WorkspaceSyncRelationshipCreateResultV1>;
  }>;
  stageConflictResolutionAtTarget?(request: WorkspaceSyncTargetConflictStageV1, signal?: AbortSignal): Promise<void>;
  applyStagedConflictResolutionAtTarget?(request: WorkspaceSyncTargetConflictApplyV1, signal?: AbortSignal): Promise<WorkspaceSyncTargetConflictApplyResultV1>;
  discardStagedConflictResolutionAtTarget?(request: WorkspaceSyncTargetConflictApplyV1, signal?: AbortSignal): Promise<void>;
  releaseConflictResolutionCaptureHere?(request: WorkspaceSyncConflictCaptureReleaseV1): Promise<void>;
  recoverConflictResolutionAtTarget?(request: WorkspaceSyncTargetConflictRecoverV1, signal?: AbortSignal): Promise<WorkspaceSyncTargetConflictRecoverResultV1>;
  readFileAtTarget(
    request: WorkspaceSyncTargetFileReadV1,
    signal?: AbortSignal,
  ): Promise<ReadWorkspaceSyncFileResultV1>;
  observeEntryAtTarget(
    request: WorkspaceSyncTargetEntryObserveV1,
    signal?: AbortSignal,
  ): Promise<WorkspaceSyncEntryExpectationV1>;
  preflightHandoffTargetReplacement(
    request: HandoffTargetReplacementPreflightV1,
    signal?: AbortSignal,
    context?: RpcHandlerContext,
  ): Promise<HandoffTargetReplacementPreflightResultV1>;
  prepareBootstrapAtTarget(
    request: WorkspaceSyncTargetBootstrapPrepareV1,
    signal?: AbortSignal,
    context?: RpcHandlerContext,
  ): Promise<WorkspaceSyncTargetBootstrapPrepareResultV1>;
  releaseBootstrapAtTarget(
    request: WorkspaceSyncTargetBootstrapReleaseV1,
    signal?: AbortSignal,
    context?: RpcHandlerContext,
  ): Promise<WorkspaceSyncTargetBootstrapReleaseResultV1>;
  prepareSourceSeedExport?(request: Readonly<{
    operationId: string;
    sourceWorkspaceRefId: string;
    targetMachineId: string;
    contentPolicy: WorkspaceContentPolicyV1;
  }>): Promise<Readonly<{ payloadSource: TransferPayloadSource; onDemandScope: DirectPeerOnDemandTransferScope }>>;
  prepareConflictResolutionExport?(request: WorkspaceSyncTargetConflictStageV1): Promise<Readonly<{
    payloadSource: TransferPayloadSource;
    onDemandScope: DirectPeerOnDemandTransferScope;
  }>>;
  inspectRetiredState(signal?: AbortSignal): Promise<WorkspaceSyncLegacyStateInspectionV1>;
  assertConflictResolutionAuthorized?(
    actionReceiptId: string,
    actionInput: WorkspaceSyncConflictResolveActionInputV1,
  ): Promise<void>;
  inspectCommittedCopyHere?(request: WorkspaceSyncCommittedCopyInspectV1, signal?: AbortSignal, context?: RpcHandlerContext): Promise<WorkspaceSyncCommittedCopyInspectResultV1>;
  removeCommittedCopyHere?(request: WorkspaceSyncCommittedCopyTargetV1, signal?: AbortSignal): Promise<WorkspaceSyncCommittedCopyTargetResultV1>;
  readProjectWorkerDependencies?(request: ProjectWorkerDependencyQueryV1, signal?: AbortSignal): Promise<readonly ProjectWorkerDependencyV1[]>;
}>;

function unavailable(): never {
  throw Object.assign(new Error('Workspace sync runtime is unavailable'), {
    code: 'workspace_sync_unavailable',
  });
}

function requireEmptyRequest(raw: unknown): void {
  if (raw === undefined || raw === null) return;
  if (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0) return;
  throw Object.assign(new Error('Invalid workspace sync request'), { code: 'invalid_request' });
}

// Workspace Sync has no Protocol error-code schema: its transported RPCs are
// private adapters. Keep promotion closed here so Node/fs codes never become
// caller-visible protocol identity merely because they use `error.code`.
const WORKSPACE_SYNC_RPC_ERROR_CODES: ReadonlySet<string> = new Set([
  'agent_unavailable',
  'approval_stale',
  'approval_required',
  'bootstrap_definition_conflict',
  'cancelled',
  'conflict_changed',
  'conflict_resolution_unsupported',
  'controller_unavailable',
  'engine_unavailable',
  'git_selection_unavailable',
  'indeterminate',
  'invalid_request',
  'machine_carrier_unavailable',
  'peer_unavailable',
  'relationship_definition_conflict',
  'relationship_not_owned',
  'relationship_not_ready',
  'relationship_replacement_required',
  'relationship_runtime_mismatch',
  'root_changed',
  'root_mismatch',
  'target_bootstrap_offline',
  'target_bootstrap_required',
  'target_unavailable',
  'workspace_file_unsupported',
  'workspace_machine_not_enrolled',
  'workspace_ref_not_ready',
  'workspace_root_identity_unavailable',
  'workspace_root_in_use',
  'workspace_root_ownership_compromised',
  'workspace_root_ownership_lost',
  'workspace_root_unsafe',
  'workspace_sync_controller_mismatch',
  'workspace_sync_child_unavailable',
  'workspace_sync_settings_conflict',
  'workspace_sync_settings_invalid',
  'workspace_sync_settings_unavailable',
  'workspace_sync_unavailable',
  'workspace_sync_update_required',
  'workspace_sync_operation_conflict',
  'workspace_sync_prepare_missing',
  'workspace_sync_finalize_missing',
  'workspace_write_denied',
  'workspace_write_escalation_denied',
  'present_user_required',
  'workspace_copy_not_owned',
  'workspace_copy_preview_unavailable',
  'workspace_copy_removal_unavailable',
  'workspace_copy_removal_unknown',
  'workspace_sync_relationship_in_use',
  'workspace_sync_dependencies_unavailable',
  'workspace_target_materialization_manual_recovery',
] as const);

function projectWorkspaceSyncRpcError(error: unknown): unknown {
  if (readRpcErrorCode(error) !== undefined || !(error instanceof Error)) return error;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code !== 'string' || !WORKSPACE_SYNC_RPC_ERROR_CODES.has(code)) return error;
  return Object.assign(new RpcError(error.message, code), { code });
}

function createWorkspaceSyncRpcRegistrar(registrar: RpcHandlerRegistrar): RpcHandlerRegistrar {
  return {
    registerHandler<TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>): void {
      registrar.registerHandler(method, async (request, context) => {
        try {
          return await handler(request, context);
        } catch (error) {
          throw projectWorkspaceSyncRpcError(error);
        }
      });
    },
  };
}

async function observeCommittedCopyResult(
  action: () => Promise<WorkspaceSyncCommittedCopyTargetResultV1>,
): Promise<WorkspaceSyncCommittedCopyTargetResultV1> {
  try {
    return WorkspaceSyncCommittedCopyTargetResultV1Schema.parse(await action());
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'workspace_sync_relationship_in_use'
      && 'dependencies' in error) {
      const dependencies = ProjectWorkerDependencyV1Schema.array().safeParse(error.dependencies);
      if (dependencies.success) return { ok: false, errorCode: 'workspace_sync_relationship_in_use', dependencies: dependencies.data };
    }
    throw error;
  }
}

export function registerMachineWorkspaceSyncRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  service?: MachineWorkspaceSyncRpcService;
}>): void {
  const rpcHandlerManager = createWorkspaceSyncRpcRegistrar(params.rpcHandlerManager);
  const service = (): MachineWorkspaceSyncRpcService => params.service ?? unavailable();
  const signal = (value: AbortSignal | undefined): AbortSignal => value ?? new AbortController().signal;

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE, async (raw, context) => {
    const request = WorkspaceSyncHandoffSourcePhaseRequestV1Schema.parse(raw);
    const phase = service().handoffSourcePhase;
    if (!phase) unavailable();
    return WorkspaceSyncHandoffSourcePhaseResultV1Schema.parse(await phase(request, context));
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_PROJECT_WORKER_DEPENDENCIES, async (raw, context) => {
    const request = ProjectWorkerDependencyQueryV1Schema.parse(raw);
    const read = service().readProjectWorkerDependencies;
    if (!read) unavailable();
    return ProjectWorkerDependencyV1Schema.array().parse(await read(request, signal(context?.signal)));
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT, async (raw, context) => {
    const request = WorkspaceSyncCommittedCopyInspectV1Schema.parse(raw);
    const inspect = service().inspectCommittedCopyHere;
    if (!inspect) unavailable();
    if ('kind' in request) {
      return WorkspaceSyncCommittedCopyPreviewResultV1Schema.parse(await inspect(request, signal(context?.signal), context));
    }
    return await observeCommittedCopyResult(async () => WorkspaceSyncCommittedCopyTargetResultV1Schema.parse(
      await inspect(request, signal(context?.signal)),
    ));
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_REMOVE, async (raw, context) => {
    const request = WorkspaceSyncCommittedCopyTargetV1Schema.parse(raw);
    const remove = service().removeCommittedCopyHere;
    if (!remove) unavailable();
    return await observeCommittedCopyResult(() => remove(request, signal(context?.signal)));
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_GET, async (raw, context) => {
    const request = WorkspaceSyncRelationshipIdV1Schema.parse(raw);
    const status = await service().controller.get(request.relationshipId, signal(context?.signal));
    return { status: status === null ? null : WorkspaceSyncStatusV1Schema.parse(status) };
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST, async (raw, context) => {
    requireEmptyRequest(raw);
    const statuses = await service().controller.list(signal(context?.signal));
    return { statuses: statuses.map((status) => WorkspaceSyncStatusV1Schema.parse(status)) };
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_FLUSH, async (raw, context) => {
    const request = WorkspaceSyncRelationshipIdV1Schema.parse(raw);
    const status = await service().controller.flush(request.relationshipId, signal(context?.signal));
    return { status: WorkspaceSyncStatusV1Schema.parse(status) };
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN, async (raw, context) => {
    const request = WorkspaceSyncPrepareBetweenRequestV1Schema.parse(raw);
    return WorkspaceSyncPrepareBetweenResultV1Schema.parse(
      await service().prepareBetween(request, signal(context?.signal)),
    );
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_PAUSE, async (raw, context) => {
    const request = WorkspaceSyncRelationshipIdV1Schema.parse(raw);
    await service().relationshipOwner.setEnabled(request.relationshipId, false, signal(context?.signal));
    return { ok: true as const };
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RESUME, async (raw, context) => {
    const request = WorkspaceSyncRelationshipIdV1Schema.parse(raw);
    await service().relationshipOwner.setEnabled(request.relationshipId, true, signal(context?.signal));
    return { ok: true as const };
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE, async (raw, context) => {
    const request = WorkspaceSyncRelationshipCreateRpcRequestV1Schema.parse(raw);
    return WorkspaceSyncRelationshipCreateResultV1Schema.parse(
      await service().relationshipOwner.create(request, signal(context?.signal)),
    );
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TERMINATE, async (raw, context) => {
    const request = WorkspaceSyncRelationshipIdV1Schema.parse(raw);
    await service().relationshipOwner.stop(request.relationshipId, signal(context?.signal));
    return { ok: true as const };
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST, async (raw, context) => {
    const request = WorkspaceSyncConflictPageRequestV1Schema.parse(raw);
    return WorkspaceSyncConflictPageV1Schema.parse(
      await service().controller.listConflicts(request, signal(context?.signal)),
    );
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST, async (raw, context) => {
    const request = WorkspaceSyncRelationshipsListRpcRequestV1Schema.parse(raw);
    return WorkspaceSyncRelationshipsListRpcResultV1Schema.parse(
      await service().controller.listRelationships(request, signal(context?.signal)),
    );
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT, async (raw, context) => {
    const request = WorkspaceSyncConflictInspectRpcRequestV1Schema.parse(raw);
    return WorkspaceSyncConflictInspectRpcResultV1Schema.parse(
      await service().controller.inspectConflict(request, signal(context?.signal)),
    );
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_RESOLVE, async (raw, context) => {
    const parsed = WorkspaceSyncConflictResolveRpcInputV1Schema.safeParse(raw);
    const assertConflictResolutionAuthorized = service().assertConflictResolutionAuthorized;
    if (!parsed.success || !assertConflictResolutionAuthorized) {
      throw Object.assign(new Error('Confirmed workspace conflict Action receipt is required'), { code: 'approval_required' });
    }
    const { actionReceiptId, actionInput } = parsed.data;
    await assertConflictResolutionAuthorized(actionReceiptId, actionInput);
    const result = await service().controller.resolveConflict(
      actionInput,
      signal(context?.signal),
      actionReceiptId,
    );
    return WorkspaceSyncConflictResolutionResultV1Schema.parse(result);
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_FILE_READ, async (raw, context) => {
    const request = ReadWorkspaceSyncFileV1Schema.parse(raw);
    return ReadWorkspaceSyncFileResultV1Schema.parse(
      await service().controller.readFile(request, signal(context?.signal)),
    );
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_STAGE, async (raw, context) => {
    const request = WorkspaceSyncTargetConflictStageV1Schema.parse(raw);
    const stage = service().stageConflictResolutionAtTarget;
    if (!stage) unavailable();
    await stage(request, signal(context?.signal));
    return { ok: true as const };
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_APPLY, async (raw, context) => {
    const request = WorkspaceSyncTargetConflictApplyV1Schema.parse(raw);
    const apply = service().applyStagedConflictResolutionAtTarget;
    if (!apply) unavailable();
    return WorkspaceSyncTargetConflictApplyResultV1Schema.parse(
      await apply(request, signal(context?.signal)),
    );
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_STAGE_DISCARD, async (raw, context) => {
    const request = WorkspaceSyncTargetConflictApplyV1Schema.parse(raw);
    const discard = service().discardStagedConflictResolutionAtTarget;
    if (!discard) unavailable();
    await discard(request, signal(context?.signal));
    return { ok: true as const };
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_CAPTURE_RELEASE, async (raw) => {
    const request = WorkspaceSyncConflictCaptureReleaseV1Schema.parse(raw);
    const release = service().releaseConflictResolutionCaptureHere;
    if (!release) unavailable();
    await release(request);
    return { ok: true as const };
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_RECOVER, async (raw, context) => {
    const request = WorkspaceSyncTargetConflictRecoverV1Schema.parse(raw);
    const recover = service().recoverConflictResolutionAtTarget;
    if (!recover) unavailable();
    return WorkspaceSyncTargetConflictRecoverResultV1Schema.parse(
      await recover(request, signal(context?.signal)),
    );
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ, async (raw, context) => {
    const request = WorkspaceSyncTargetFileReadV1Schema.parse(raw);
    return ReadWorkspaceSyncFileResultV1Schema.parse(
      await service().readFileAtTarget(request, signal(context?.signal)),
    );
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_ENTRY_OBSERVE, async (raw, context) => {
    const request = WorkspaceSyncTargetEntryObserveV1Schema.parse(raw);
    return WorkspaceSyncEntryExpectationV1Schema.parse(
      await service().observeEntryAtTarget(request, signal(context?.signal)),
    );
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT, async (raw, context) => {
    const request = HandoffTargetReplacementPreflightV1Schema.parse(raw);
    return HandoffTargetReplacementPreflightResultV1Schema.parse(
      await service().preflightHandoffTargetReplacement(request, signal(context?.signal), context),
    );
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE, async (raw, context) => {
    const request = WorkspaceSyncTargetBootstrapPrepareV1Schema.parse(raw);
    return WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse(
      await service().prepareBootstrapAtTarget(request, signal(context?.signal), context),
    );
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE, async (raw, context) => {
    const request = WorkspaceSyncTargetBootstrapReleaseV1Schema.parse(raw);
    return WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse(
      await service().releaseBootstrapAtTarget(request, signal(context?.signal), context),
    );
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_LEGACY_INSPECT, async (raw, context) => {
    requireEmptyRequest(raw);
    return WorkspaceSyncLegacyStateInspectionV1Schema.parse(
      await service().inspectRetiredState(signal(context?.signal)),
    );
  });
}
