import { ReadWorkspaceSyncFileResultV1Schema, ReadWorkspaceSyncFileV1Schema, HandoffTargetReplacementPreflightResultV1Schema, HandoffTargetReplacementPreflightV1Schema, WorkspaceSyncConflictPageRequestV1Schema, WorkspaceSyncConflictPageV1Schema, WorkspaceSyncRelationshipsListRpcRequestV1Schema, WorkspaceSyncRelationshipsListRpcResultV1Schema, WorkspaceSyncConflictInspectRpcRequestV1Schema, WorkspaceSyncConflictInspectRpcResultV1Schema, WorkspaceSyncConflictResolveRpcInputV1Schema, WorkspaceSyncConflictResolutionResultV1Schema, WorkspaceSyncRelationshipCreateResultV1Schema, WorkspaceSyncRelationshipCreateRpcRequestV1Schema, WorkspaceSyncRelationshipIdV1Schema, WorkspaceSyncLegacyStateInspectionV1Schema, WorkspaceSyncStatusV1Schema, WorkspaceSyncPrepareBetweenRequestV1Schema, WorkspaceSyncPrepareBetweenResultV1Schema, WorkspaceSyncTargetBootstrapPrepareResultV1Schema, WorkspaceSyncTargetBootstrapPrepareV1Schema, WorkspaceSyncTargetBootstrapReleaseResultV1Schema, WorkspaceSyncTargetBootstrapReleaseV1Schema, WorkspaceSyncTargetConflictStageV1Schema, WorkspaceSyncConflictCaptureReleaseV1Schema, WorkspaceSyncTargetConflictApplyV1Schema, WorkspaceSyncTargetConflictApplyResultV1Schema, WorkspaceSyncTargetConflictRecoverV1Schema, WorkspaceSyncTargetConflictRecoverResultV1Schema, WorkspaceSyncTargetFileReadV1Schema, WorkspaceSyncTargetEntryObserveV1Schema, WorkspaceSyncEntryExpectationV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { WorkspaceSyncConflictResolutionResultV1, WorkspaceSyncConflictResolutionV1, WorkspaceSyncConflictResolveActionInputV1, ReadWorkspaceSyncFileResultV1, ReadWorkspaceSyncFileV1, HandoffTargetReplacementPreflightResultV1, HandoffTargetReplacementPreflightV1, WorkspaceSyncConflictPageRequestV1, WorkspaceSyncConflictPageV1, WorkspaceSyncRelationshipsListRpcRequestV1, WorkspaceSyncRelationshipsListRpcResultV1, WorkspaceSyncConflictInspectRpcRequestV1, WorkspaceSyncConflictInspectRpcResultV1, WorkspaceSyncRelationshipCreateResultV1, WorkspaceSyncRelationshipCreateRpcRequestV1, WorkspaceContentPolicyV1, WorkspaceSyncStatusV1, WorkspaceSyncPrepareBetweenRequestV1, WorkspaceSyncPrepareBetweenResultV1, WorkspaceSyncLegacyStateInspectionV1, WorkspaceSyncTargetBootstrapPrepareResultV1, WorkspaceSyncTargetBootstrapPrepareV1, WorkspaceSyncTargetBootstrapReleaseResultV1, WorkspaceSyncTargetBootstrapReleaseV1, WorkspaceSyncTargetConflictStageV1, WorkspaceSyncConflictCaptureReleaseV1, WorkspaceSyncTargetConflictApplyV1, WorkspaceSyncTargetConflictApplyResultV1, WorkspaceSyncTargetConflictRecoverV1, WorkspaceSyncTargetConflictRecoverResultV1, WorkspaceSyncTargetFileReadV1, WorkspaceSyncTargetEntryObserveV1, WorkspaceSyncEntryExpectationV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { projectWorkspaceSyncRpcError } from './workspaceSyncRpcErrors';
import { z } from 'zod/mini';
import type { RpcHandler, RpcHandlerRegistrar, RpcHandlerContext } from '../rpc/types';
import { WorkspaceSyncRelationshipCreationObservationV1Schema, WorkspaceSyncStatusWatchRequestV1Schema, WorkspaceSyncStatusWatchResultV1Schema,
  type WorkspaceSyncStatusWatchRequestV1, type WorkspaceSyncStatusWatchResultV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { WorkspaceSyncHandoffSourcePhaseRequestV1Schema, WorkspaceSyncHandoffSourcePhaseResultV1Schema,
  type WorkspaceSyncHandoffSourcePhaseRequestV1, type WorkspaceSyncHandoffSourcePhaseResultV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { DirectPeerOnDemandTransferScope } from '@/machines/transfer/directPeerTransport';
import type { TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import type { WorkspaceSyncRelationshipOwner } from '@/workspaces/sync/workspaceSyncRelationshipOwner';
import type { WorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import type { WorkspaceSyncTargetAuthority } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { deriveWorkspaceSyncRelationshipId } from '@/workspaces/sync/workspaceSyncRelationshipIdentity';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { PrivateWorkspaceSyncTargetAdmission, PrivateWorkspaceSyncTargetExecutionResolution } from './machineRpcAuthorization';
import { ProjectWorkerDependencyQueryV1Schema, ProjectWorkerDependencyV1Schema,
  type ProjectWorkerDependencyQueryV1, type ProjectWorkerDependencyV1 } from '@happier-dev/protocol/workspaces/projectWorkerExecutionV1';
import { WorkspaceSyncCommittedCopyTargetV1Schema, WorkspaceSyncCommittedCopyTargetResultV1Schema,
  WorkspaceSyncCommittedCopyInspectV1Schema, WorkspaceSyncCommittedCopyPreviewResultV1Schema,
  type WorkspaceSyncCommittedCopyInspectV1, type WorkspaceSyncCommittedCopyInspectResultV1,
  type WorkspaceSyncCommittedCopyTargetV1, type WorkspaceSyncCommittedCopyTargetResultV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncCommittedCopyV1';

export type WorkspaceSyncRpcController = Readonly<{
  get(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1 | null>;
  list(signal?: AbortSignal): Promise<readonly WorkspaceSyncStatusV1[]>;
  watchStatuses(request: WorkspaceSyncStatusWatchRequestV1, signal?: AbortSignal): Promise<WorkspaceSyncStatusWatchResultV1>;
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
  hasRetainedRecoveryAdmission?: WorkspaceSyncTargetAuthority['hasRetainedRecoveryAdmission'];
  /** One requester Account admission for each controller call. The returned
   * view shares the installed controller and its retained native jobs. */
  forRequester?(context?: RpcHandlerContext, options?: Readonly<{ includeAvailability?: boolean }>): Promise<
    Pick<MachineWorkspaceSyncRpcService, 'controller' | 'relationshipOwner'> & Readonly<{
      requesterAvailability?: import('@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas').WorkspaceSyncRequesterAvailabilityV1;
    }>>;
  handoffSourcePhase?(request: WorkspaceSyncHandoffSourcePhaseRequestV1, context?: RpcHandlerContext): Promise<WorkspaceSyncHandoffSourcePhaseResultV1>;
  controller: WorkspaceSyncRpcController;
  prepareBetween(request: WorkspaceSyncPrepareBetweenRequestV1, signal?: AbortSignal, context?: RpcHandlerContext): Promise<WorkspaceSyncPrepareBetweenResultV1>;
  relationshipOwner: Readonly<{
    setEnabled(relationshipId: string, enabled: boolean, signal?: AbortSignal): Promise<void>;
    stop: WorkspaceSyncRelationshipOwner['stop'];
    observeCreation?: (request: WorkspaceSyncRelationshipCreateRpcRequestV1) => Promise<import('@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas').WorkspaceSyncRelationshipCreationObservationV1>;
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
  /** Installed SOURCE spends the admitted normal Action at its target transport. */
  preflightRelationshipTarget?(request: HandoffTargetReplacementPreflightV1, context: RpcHandlerContext): Promise<HandoffTargetReplacementPreflightResultV1>;
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
  removeCommittedCopyHere?(request: WorkspaceSyncCommittedCopyTargetV1, signal?: AbortSignal, context?: RpcHandlerContext): Promise<WorkspaceSyncCommittedCopyTargetResultV1>;
  readProjectWorkerDependencies?(request: ProjectWorkerDependencyQueryV1, signal?: AbortSignal, context?: RpcHandlerContext): Promise<readonly ProjectWorkerDependencyV1[]>;
}>;

/** Admission is already current. Match only the incumbent host capture. */
export function resolvePrivateWorkspaceSyncTargetExecution(
  adapter: Pick<WorkspaceSyncHandoffAdapter, 'resolvePrivateExecution'> &
    Pick<MachineWorkspaceSyncRpcService, 'hasRetainedRecoveryAdmission'>,
  admission: PrivateWorkspaceSyncTargetAdmission,
): PrivateWorkspaceSyncTargetExecutionResolution {
  const { routing } = admission;
  const capture = adapter.resolvePrivateExecution?.(routing.phase === 'recover'
    ? { relationshipId: routing.relationshipId } : { operationId: routing.operationId });
  if (!capture) {
    if (routing.phase === 'recover' && adapter.hasRetainedRecoveryAdmission?.({ request: routing,
      accountServerId: routing.accountServerId, actorAccountId: admission.context.actorAccountId,
      receivingMachine: admission.receivingMachine })) return { kind: 'native_admitted' };
    return { kind: 'no_private_capture' };
  }
  const { input, execution } = capture;
  const identity = execution.executionIdentity;
  const home = routing.accountServerId;
  const workspaceRefId = admission.targetWorkspaceRefId;
  const matches = identity?.kind === 'isolated'
    && identity.requester.accountId === admission.context.actorAccountId
    && execution.accountRowsCustody.accountId === admission.context.actorAccountId
    // Account rows custody holds the semantic Home; requester attribution's
    // serverId is the local profile handle and must not be used as Home identity.
    && execution.accountRowsCustody.serverId === home
    && input.accountServerId === home
    && identity.requester.machineId === admission.receivingMachine.machineId
    && identity.requester.installationId === admission.receivingMachine.installationId
    && input.targetMachineId === admission.receivingMachine.machineId
    && input.targetMachineId === routing.targetMachineId
    && (routing.phase === 'recover' || input.targetRootPath === routing.targetRootPath)
    && (workspaceRefId === undefined || input.targetWorkspaceRefId === workspaceRefId);
  if (!matches) return { kind: 'private_unavailable' };
  // The binding is installed by the canonical signed prepare, before initial
  // ensure. It survives commit for later transfers; an operation id alone
  // never authorizes this continuation. Native custody owns the captured root.
  if (routing.phase === 'recover') {
    const action = input.action;
    const admittedRelationship = action.kind === 'create_relationship'
      || action.kind === 'relationship' && capture.phase === 'relationship' && action.relationshipId === routing.relationshipId;
    if (!admittedRelationship || capture.relationshipId !== routing.relationshipId
      || input.targetWorkspaceRefId !== routing.targetWorkspaceRefId) return { kind: 'private_unavailable' };
  }
  if (routing.phase === 'prepare') {
    const request = WorkspaceSyncTargetBootstrapPrepareV1Schema.parse(admission.request);
    const action = input.action;
    if (action.kind !== 'copy_once' && action.kind !== 'create_relationship') return { kind: 'private_unavailable' };
    if (request.policyDigest !== action.contentPolicy.policyDigest) return { kind: 'private_unavailable' };
    const operation = request.owner.kind === 'copy_once' ? request.owner.operation : request.transientRelationship;
    if (!operation || operation.alphaWorkspaceRefId !== input.sourceWorkspaceRefId
      || operation.betaWorkspaceRefId !== input.targetWorkspaceRefId || request.endpointRole !== 'beta'
      || !sameStrictJsonValue(operation.contentPolicy, action.contentPolicy)) return { kind: 'private_unavailable' };
    if (request.owner.kind === 'relationship'
      && (action.kind !== 'create_relationship' || request.owner.relationshipId !== deriveWorkspaceSyncRelationshipId(input.operationId)
        || !('mode' in operation) || operation.mode !== action.mode)) return { kind: 'private_unavailable' };
    if (request.owner.kind === 'copy_once' && (action.kind !== 'copy_once'
      || request.owner.operation.operationId !== input.operationId)) return { kind: 'private_unavailable' };
  }
  return { kind: 'matched', capture };
}

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

function createWorkspaceSyncRpcRegistrar(registrar: RpcHandlerRegistrar): RpcHandlerRegistrar {
  return {
    registerHandler<TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>): void {
      registrar.registerHandler(method, async (request, context) => {
        try {
          return await handler(request, context);
        } catch (error) {
          throw projectWorkspaceSyncRpcError(error, method, context?.transportRequestId);
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
      const dependencies = z.array(ProjectWorkerDependencyV1Schema).safeParse(error.dependencies);
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
  const requesterService = async (context?: RpcHandlerContext, options?: Readonly<{ includeAvailability?: boolean }>) => {
    const current = service();
    return current.forRequester ? await current.forRequester(context, options) : current;
  };
  const signal = (value: AbortSignal | undefined): AbortSignal => value ?? new AbortController().signal;
  const privateNativeTarget = (context: RpcHandlerContext | undefined) => {
    const capture = context?.workspaceSyncPrivateExecution;
    if (!capture) return null;
    if (!capture.execution.nativeSync) {
      throw new RpcError('Private workspace Sync execution is unavailable', 'agent_isolation_unavailable');
    }
    return capture.execution.nativeSync;
  };

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
    return z.array(ProjectWorkerDependencyV1Schema).parse(await read(request, signal(context?.signal), context));
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT, async (raw, context) => {
    const request = WorkspaceSyncCommittedCopyInspectV1Schema.parse(raw);
    const inspect = service().inspectCommittedCopyHere;
    if (!inspect) unavailable();
    if ('kind' in request) {
      try {
        return WorkspaceSyncCommittedCopyPreviewResultV1Schema.parse(await inspect(request, signal(context?.signal), context));
      } catch (error) {
        // The routed TARGET hop keeps its thrown RPC error for the SOURCE. Only
        // the Action front door projects a typed refusal, which the UI/CLI
        // result readers would otherwise collapse into invalid_action_output.
        if (context?.workspaceSyncSourceWriterTargetRouting) throw error;
        const errorCode = readRpcErrorCode(projectWorkspaceSyncRpcError(error, RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT))
          ?? 'workspace_copy_preview_unavailable';
        return { ok: false, errorCode, error: errorCode };
      }
    }
    return await observeCommittedCopyResult(async () => WorkspaceSyncCommittedCopyTargetResultV1Schema.parse(
      await inspect(request, signal(context?.signal), context),
    ));
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_REMOVE, async (raw, context) => {
    const request = WorkspaceSyncCommittedCopyTargetV1Schema.parse(raw);
    const remove = service().removeCommittedCopyHere;
    if (!remove) unavailable();
    return await observeCommittedCopyResult(() => remove(request, signal(context?.signal), context));
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_GET, async (raw, context) => {
    const request = WorkspaceSyncRelationshipIdV1Schema.parse(raw);
    const status = await (await requesterService(context)).controller.get(request.relationshipId, signal(context?.signal));
    return { status: status === null ? null : WorkspaceSyncStatusV1Schema.parse(status) };
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST, async (raw, context) => {
    requireEmptyRequest(raw);
    const statuses = await (await requesterService(context)).controller.list(signal(context?.signal));
    return { statuses: statuses.map((status) => WorkspaceSyncStatusV1Schema.parse(status)) };
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_WATCH, async (raw, context) => {
    const request = WorkspaceSyncStatusWatchRequestV1Schema.parse(raw);
    return WorkspaceSyncStatusWatchResultV1Schema.parse(
      await (await requesterService(context)).controller.watchStatuses(request, signal(context?.signal)),
    );
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_FLUSH, async (raw, context) => {
    const request = WorkspaceSyncRelationshipIdV1Schema.parse(raw);
    const status = await (await requesterService(context)).controller.flush(request.relationshipId, signal(context?.signal));
    return { status: WorkspaceSyncStatusV1Schema.parse(status) };
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN, async (raw, context) => {
    const request = WorkspaceSyncPrepareBetweenRequestV1Schema.parse(raw);
    return WorkspaceSyncPrepareBetweenResultV1Schema.parse(
      await service().prepareBetween(request, signal(context?.signal), context),
    );
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_PAUSE, async (raw, context) => {
    const request = WorkspaceSyncRelationshipIdV1Schema.parse(raw);
    await (await requesterService(context)).relationshipOwner.setEnabled(request.relationshipId, false, signal(context?.signal));
    return { ok: true as const };
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RESUME, async (raw, context) => {
    const request = WorkspaceSyncRelationshipIdV1Schema.parse(raw);
    await (await requesterService(context)).relationshipOwner.setEnabled(request.relationshipId, true, signal(context?.signal));
    return { ok: true as const };
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE, async (raw, context) => {
    const request = WorkspaceSyncRelationshipCreateRpcRequestV1Schema.parse(raw);
    return WorkspaceSyncRelationshipCreateResultV1Schema.parse(
      await (await requesterService(context)).relationshipOwner.create(request, signal(context?.signal)),
    );
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATION_OBSERVE, async (raw, context) => {
    const observe = (await requesterService(context)).relationshipOwner.observeCreation;
    if (!observe) unavailable();
    return WorkspaceSyncRelationshipCreationObservationV1Schema.parse(await observe(WorkspaceSyncRelationshipCreateRpcRequestV1Schema.parse(raw)));
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TERMINATE, async (raw, context) => {
    const request = WorkspaceSyncRelationshipIdV1Schema.parse(raw);
    await (await requesterService(context)).relationshipOwner.stop(request.relationshipId, signal(context?.signal));
    return { ok: true as const };
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST, async (raw, context) => {
    const request = WorkspaceSyncConflictPageRequestV1Schema.parse(raw);
    return WorkspaceSyncConflictPageV1Schema.parse(
      await (await requesterService(context)).controller.listConflicts(request, signal(context?.signal)),
    );
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST, async (raw, context) => {
    const request = WorkspaceSyncRelationshipsListRpcRequestV1Schema.parse(raw);
    const current = await requesterService(context, { includeAvailability: request.requesterAvailability });
    const result = await current.controller.listRelationships(request, signal(context?.signal));
    return WorkspaceSyncRelationshipsListRpcResultV1Schema.parse({ ...result,
      ...(request.requesterAvailability ? { requesterAvailability: 'requesterAvailability' in current && current.requesterAvailability
        ? current.requesterAvailability : { kind: 'unavailable', reason: 'requester_authority_unavailable' } } : {}) });
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT, async (raw, context) => {
    const request = WorkspaceSyncConflictInspectRpcRequestV1Schema.parse(raw);
    return WorkspaceSyncConflictInspectRpcResultV1Schema.parse(
      await (await requesterService(context)).controller.inspectConflict(request, signal(context?.signal)),
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
    const result = await (await requesterService(context)).controller.resolveConflict(
      actionInput,
      signal(context?.signal),
      actionReceiptId,
    );
    return WorkspaceSyncConflictResolutionResultV1Schema.parse(result);
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_FILE_READ, async (raw, context) => {
    const request = ReadWorkspaceSyncFileV1Schema.parse(raw);
    return ReadWorkspaceSyncFileResultV1Schema.parse(
      await (await requesterService(context)).controller.readFile(request, signal(context?.signal)),
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
    const native = privateNativeTarget(context);
    const recover = native ? context?.workspaceSyncPrivateExecution?.execution.recoverConflictResolutionHere
      : service().recoverConflictResolutionAtTarget;
    if (native && !recover) throw new RpcError('Private workspace Sync execution is unavailable', 'agent_isolation_unavailable');
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
    const native = privateNativeTarget(context);
    return HandoffTargetReplacementPreflightResultV1Schema.parse(
      await (native ? native.preflightHandoffTargetReplacementHere(request, signal(context?.signal))
        : service().preflightHandoffTargetReplacement(request, signal(context?.signal), context)),
    );
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE, async (raw, context) => {
    const request = WorkspaceSyncTargetBootstrapPrepareV1Schema.parse(raw);
    const native = privateNativeTarget(context);
    if (native && context) await context.workspaceSyncPrivateExecution?.execution.bindTargetPhaseContext?.(context);
    if (native && request.owner.kind === 'relationship') {
      const bind = context?.workspaceSyncPrivateExecution?.bindRelationship;
      if (!bind) throw new RpcError('Private workspace relationship custody is unavailable', 'agent_isolation_unavailable');
      await bind(request.owner.relationshipId);
    }
    return WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse(
      await (native ? native.prepareBootstrapHere(request, signal(context?.signal))
        : service().prepareBootstrapAtTarget(request, signal(context?.signal), context)),
    );
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE, async (raw, context) => {
    const request = WorkspaceSyncTargetBootstrapReleaseV1Schema.parse(raw);
    const native = privateNativeTarget(context);
    return WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse(
      await (native ? native.releaseBootstrapHere(request, signal(context?.signal))
        : service().releaseBootstrapAtTarget(request, signal(context?.signal), context)),
    );
  });
  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_LEGACY_INSPECT, async (raw, context) => {
    requireEmptyRequest(raw);
    return WorkspaceSyncLegacyStateInspectionV1Schema.parse(
      await service().inspectRetiredState(signal(context?.signal)),
    );
  });
}
