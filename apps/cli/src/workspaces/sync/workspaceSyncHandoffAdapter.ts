import { type ManagedWorkspaceSync, type WorkspaceSyncCopyOnceV1 } from './workspaceSyncTypes';
import { validateWorkspaceSyncContentPolicy } from './workspaceSyncSettings';
import type {
  HandoffTargetReplacementApprovalV1, HandoffWorkspaceActionV1,
  WorkspaceSyncPrepareBetweenResultV1, WorkspaceSyncStatusV1, WorkspaceRefV1,
} from '@happier-dev/protocol';
import type { WorkspaceSyncLocalAgentStreamOpen } from './workspaceSyncController';
import type { WorkspaceRootOwnershipHandle } from './workspaceSyncRootOwnership';
import {
  WorkspaceSyncPreparationRefusal,
  type PreparedWorkspaceSyncRelationship,
  type WorkspaceSyncRelationshipOwner,
} from './workspaceSyncRelationshipOwner';
import { assertWorkspaceSyncStatusClean, prepareWorkspaceSyncRelationship } from './workspaceSyncPreparation';
import {
  WorkspaceSyncHandoffSourceInputV1Schema, WorkspaceSyncHandoffSourcePhaseResultV1Schema,
  type WorkspaceSyncHandoffSourceInputV1, type WorkspaceSyncHandoffSourcePhaseRequestV1,
  type WorkspaceSyncHandoffSourcePhaseResultV1, type WorkspaceSyncHandoffPreparedV1,
  type WorkspaceSyncHandoffSettledV1, type HandoffTargetReplacementPreflightResultV1,
} from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';
import { projectActionFailureCauseV1, readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isDeepStrictEqual } from 'node:util';
import type { WorkspaceSyncSourceContextV1 } from '@happier-dev/protocol/socketRpc';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { logger } from '@/ui/logger';
import type { MachineInstallationPublicIdentityV1 } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { StoredCredentials } from '@/persistence';
import type { ActiveProjectAccountRowsSnapshot, ProjectAccountSessionCustody } from '@/workspaces/projectAccountRows';
import type { HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { PrivateProjectNativeSync, PrivateProjectSyncEffectConfiguration, PrivateProjectSyncNetwork } from '@/workspaces/activation/privateProjectSyncEffect';
import type { WorkspaceSyncTargetPhaseDescriptor } from './workspaceSyncTargetAuthority';
import { workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { isManagedWorkspaceRefV2, type ManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveWorkspaceSyncExecutionMachineIdV1 } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import type { ManagedWorkspaceSyncTarget } from '@/machines/managed/acquire';
import type { WorkspaceManifest } from '@happier-dev/protocol/workspaces/manifestSchema';
import { deriveWorkspaceSyncRelationshipId } from '@happier-dev/protocol/workspaces/workspaceSyncAdmissionV1';
import {
  createWorkspaceSyncExecutionRegistry,
  sameAdmittedHandoffInput,
  type WorkspaceSyncExecutionRegistry,
} from './workspaceSyncExecutionRegistry';

/** Handoff's workspace integration seam; execution tracking lives in WorkspaceSyncExecutionRegistry. */
export type WorkspaceSyncHandoffAction = HandoffWorkspaceActionV1;
export type WorkspaceSyncHandoffSourcePhaseAuthority = WorkspaceSyncSourceContextV1;

export type WorkspaceSyncPrivateExecution = Readonly<{
  credentials: StoredCredentials;
  accountRowsCustody: ProjectAccountSessionCustody;
  executionIdentity?: HostRequesterExecutionIdentity;
  nativeSync?: PrivateProjectNativeSync;
  sourceNativeSync?: PrivateProjectNativeSync;
  managedTarget?: Readonly<{
    workspace: ManagedWorkspaceRefV2;
    open(): Promise<Readonly<{ target: ManagedWorkspaceSyncTarget; native: PrivateProjectNativeSync; signal: AbortSignal }>>;
    close(): Promise<void>;
  }>;
  getSnapshot?: () => ActiveProjectAccountRowsSnapshot | null;
  replaceSnapshot?: (snapshot: ActiveProjectAccountRowsSnapshot) => Promise<void>;
  callTargetPhase?: (descriptor: WorkspaceSyncTargetPhaseDescriptor) => Promise<unknown>;
  bindTargetPhaseContext?: (context: RpcHandlerContext) => void;
  recoverConflictResolutionHere?: (request: Parameters<PrivateProjectNativeSync['recoverConflictResolutionHere']>[0],
    signal?: AbortSignal) => ReturnType<PrivateProjectNativeSync['recoverConflictResolutionHere']>;
  recoverConflictResolutionAtTarget?: (request: Parameters<PrivateProjectNativeSync['recoverConflictResolutionHere']>[0],
    signal?: AbortSignal) => ReturnType<PrivateProjectNativeSync['recoverConflictResolutionHere']>;
  assertTransferCurrent(): Promise<void>;
  onSourceRootReleased?(): Promise<void>;
  retainRelationship?(relationshipId: string): Promise<void>;
  release(): Promise<void>;
}>;

export type PrepareWorkspaceSyncPrivateExecutionInput = Omit<WorkspaceSyncPrivateExecution, 'nativeSync' | 'getSnapshot'> & Readonly<{
  input: PrepareWorkspaceSyncHandoffInput;
  context?: RpcHandlerContext;
  snapshot: ActiveProjectAccountRowsSnapshot;
  createNativeSync(input: Readonly<{ configuration: PrivateProjectSyncEffectConfiguration; network: PrivateProjectSyncNetwork }>): Promise<PrivateProjectNativeSync>;
}>;

export type RetainedWorkspaceSyncPrivateExecution = Readonly<{
  input: PrepareWorkspaceSyncHandoffInput;
  execution: WorkspaceSyncPrivateExecution;
  phase: 'open' | 'relationship';
  relationshipId?: string;
  bindRelationship?: (relationshipId: string, settledPhase?: 'relationship') => Promise<void>;
}>;

export type WorkspaceSyncPrivateWorkspaceResolution = Readonly<
  { kind: 'unowned' } | { kind: 'unavailable' } | { kind: 'resolved'; workspace: WorkspaceRefV1 }
>;

export type PrepareWorkspaceSyncHandoffInput = Readonly<{
  operationId: string;
  accountServerId?: string;
  sourceSessionId?: string;
  targetReplacementApproval?: HandoffTargetReplacementApprovalV1;
  targetReplacementApprovalReceiptId?: string;
  targetReplacementApprovalActionInput?: unknown;
  action: WorkspaceSyncHandoffAction;
  sourceMachineId: string;
  targetMachineId: string;
  targetManaged?: Pick<ManagedWorkspaceRefV2, 'managedId' | 'controller'>;
  sourceWorkspaceRefId?: string;
  managedCopySource?: ManagedWorkspaceRefV2;
  targetWorkspaceRefId?: string;
  sourceRootPath: string;
  targetRootPath: string;
  signal?: AbortSignal;
  onEffectsIssued?: () => void;
  callWorkspaceSourcePhase?: (descriptor: Readonly<{
    machineId: string;
    physicalEndpoint?: MachineInstallationPublicIdentityV1;
    request: WorkspaceSyncHandoffSourcePhaseRequestV1;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
}>;

export type WorkspaceSyncHandoffPrepared = Readonly<WorkspaceSyncHandoffPreparedV1>;
export type CommitWorkspaceSyncHandoffInput = Readonly<{ operationId: string; prepared: WorkspaceSyncHandoffPrepared; signal?: AbortSignal }>;
export type WorkspaceSyncHandoffCommitted = Readonly<WorkspaceSyncHandoffSettledV1>;
export type FinalizeWorkspaceSyncHandoffInput = CommitWorkspaceSyncHandoffInput;
export type WorkspaceSyncHandoffFinalized = WorkspaceSyncHandoffCommitted;
export type AbortWorkspaceSyncHandoffInput = Readonly<{ operationId: string; prepared?: WorkspaceSyncHandoffPrepared; signal?: AbortSignal }>;

export type WorkspaceSyncManagedCopySource = Readonly<{
  workspace: ManagedWorkspaceRefV2;
  ownership: WorkspaceRootOwnershipHandle;
  openAgent: WorkspaceSyncLocalAgentStreamOpen;
}>;

export type WorkspaceSyncHandoffAdapterDeps = Readonly<{
  sync: ManagedWorkspaceSync;
  executionRegistry?: WorkspaceSyncExecutionRegistry;
  preparePrivateExecution?: (input: PrepareWorkspaceSyncPrivateExecutionInput) => Promise<WorkspaceSyncPrivateExecution>;
  resolveRelationshipOwner?: (input: PrepareWorkspaceSyncHandoffInput, context?: RpcHandlerContext) => Promise<Pick<WorkspaceSyncRelationshipOwner, 'materializeEndpoints' | 'prepareCreate'>>;
  localMachineId?: string;
  resolveExecutionInput?: (input: PrepareWorkspaceSyncHandoffInput, authority?: WorkspaceSyncHandoffSourcePhaseAuthority,
    context?: RpcHandlerContext) => Promise<Readonly<{
    input: PrepareWorkspaceSyncHandoffInput;
    targetPreflight?: HandoffTargetReplacementPreflightResultV1;
    sourcePhysicalEndpoint?: MachineInstallationPublicIdentityV1;
  }>>;
  /** Existing-relationship flush; the handoff's admitted context selects whose custody reaches the controller. */
  relationshipController?: Readonly<{
    flush(relationshipId: string, signal?: AbortSignal, context?: RpcHandlerContext): Promise<WorkspaceSyncStatusV1>;
  }>;
  prepareBetween?: (
    request: Readonly<{ sourceWorkspaceRefId: string; targetWorkspaceRefId: string }>,
    signal?: AbortSignal, context?: RpcHandlerContext,
  ) => Promise<WorkspaceSyncPrepareBetweenResultV1>;
  relationshipOwner?: Pick<WorkspaceSyncRelationshipOwner, 'materializeEndpoints' | 'prepareCreate'>;
  bootstrap: (input: PrepareWorkspaceSyncHandoffInput, admittedInput?: PrepareWorkspaceSyncHandoffInput,
    authority?: WorkspaceSyncHandoffSourcePhaseAuthority, context?: RpcHandlerContext,
    targetPreflight?: HandoffTargetReplacementPreflightResultV1) => Promise<Readonly<{
    release(reason: 'abort' | 'commit'): Promise<void>;
    ownershipHandles?: readonly WorkspaceRootOwnershipHandle[];
    targetWorkspace?: WorkspaceRefV1;
    managedCopySource?: WorkspaceSyncManagedCopySource;
    copyOnceBaseline?: WorkspaceManifest;
    copyOnceExcludedPaths?: readonly string[];
  }>>;
}>;

export interface WorkspaceSyncHandoffAdapter {
  readonly executionRegistry?: WorkspaceSyncExecutionRegistry;
  preparePrivateExecution?(input: PrepareWorkspaceSyncPrivateExecutionInput): Promise<WorkspaceSyncPrivateExecution>;
  retainPrivateExecution?(input: Readonly<{ input: PrepareWorkspaceSyncHandoffInput; execution: WorkspaceSyncPrivateExecution;
    phase?: RetainedWorkspaceSyncPrivateExecution['phase'] }>): void;
  bindPrivateExecutionRelationship?(operationId: string, relationshipId: string, settledPhase?: 'relationship'): Promise<void>;
  resolvePrivateExecution?(input: Readonly<{ operationId?: string; relationshipId?: string }>): RetainedWorkspaceSyncPrivateExecution | null;
  listPrivateExecutions?(): readonly RetainedWorkspaceSyncPrivateExecution[];
  resolvePrivateWorkspaceRef?(workspaceRefId: string, serverId: string): WorkspaceSyncPrivateWorkspaceResolution;
  releasePrivateExecution?(operationId: string): Promise<void>;
  releaseAllPrivateExecutions?(): Promise<void>;
  resolvePreparedCopyTarget?(operationId: string, workspaceRefId: string): WorkspaceRefV1 | null;
  resolvePreparedManagedCopySource?(operationId: string, workspaceRefId: string): WorkspaceSyncManagedCopySource | null;
  applySourcePhase?(request: WorkspaceSyncHandoffSourcePhaseRequestV1, signal?: AbortSignal,
    authority?: WorkspaceSyncHandoffSourcePhaseAuthority, context?: RpcHandlerContext): Promise<WorkspaceSyncHandoffSourcePhaseResultV1>;
  prepareBetween(request: Readonly<{ sourceWorkspaceRefId: string; targetWorkspaceRefId: string }>,
    signal?: AbortSignal, context?: RpcHandlerContext): Promise<WorkspaceSyncPrepareBetweenResultV1>;
  prepare(input: PrepareWorkspaceSyncHandoffInput, authority?: WorkspaceSyncHandoffSourcePhaseAuthority,
    context?: RpcHandlerContext): Promise<WorkspaceSyncHandoffPrepared>;
  finalize(input: FinalizeWorkspaceSyncHandoffInput): Promise<WorkspaceSyncHandoffFinalized>;
  commit(input: CommitWorkspaceSyncHandoffInput): Promise<WorkspaceSyncHandoffCommitted>;
  abort(input: AbortWorkspaceSyncHandoffInput): Promise<void>;
}

const adapterError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

function copyPreparationRefusal(request: PrepareWorkspaceSyncHandoffInput, error: unknown): WorkspaceSyncPreparationRefusal | undefined {
  if (error instanceof WorkspaceSyncPreparationRefusal) return error;
  if (request.action.kind !== 'copy_once') return undefined;
  const code = readActionErrorCodeV1(error);
  if (!code) return undefined;
  const refusedBeforeEffect = error && typeof error === 'object' && 'effectAttempted' in error && error.effectAttempted === false;
  if (!refusedBeforeEffect && !(request.action.contentPolicy.contentOnly && code === 'workspace_root_in_use')) return undefined;
  return new WorkspaceSyncPreparationRefusal(code, {
    ok: false, errorCode: code, error: code,
    failureCause: projectActionFailureCauseV1(error, 'projects.open', { allowUnknownErrorCode: true }),
  });
}

/** One containing agent-free Open; the same adapter owns clean bytes, READY and commit custody. */
export async function materializeWorkspaceSyncForOpen(adapter: WorkspaceSyncHandoffAdapter, request: PrepareWorkspaceSyncHandoffInput,
  context?: RpcHandlerContext, authority?: WorkspaceSyncHandoffSourcePhaseAuthority): Promise<Pick<WorkspaceSyncHandoffPrepared, 'copyOnceBaseline' | 'copyOnceExcludedPaths'>> {
  const prepared = await adapter.prepare(request, authority, context).catch((error: unknown) => {
    throw copyPreparationRefusal(request, error) ?? error;
  });
  request.onEffectsIssued?.();
  await adapter.finalize({ operationId: request.operationId, prepared, signal: request.signal });
  await adapter.commit({ operationId: request.operationId, prepared, signal: request.signal });
  return {
    ...(prepared.copyOnceBaseline ? { copyOnceBaseline: prepared.copyOnceBaseline } : {}),
    ...(prepared.copyOnceExcludedPaths ? { copyOnceExcludedPaths: prepared.copyOnceExcludedPaths } : {}),
  };
}

type PreparedOperation = Readonly<{
  prepared: WorkspaceSyncHandoffPrepared;
  admittedInput: PrepareWorkspaceSyncHandoffInput;
  executionInput: PrepareWorkspaceSyncHandoffInput;
  fence?: Awaited<ReturnType<WorkspaceSyncHandoffAdapterDeps['bootstrap']>>;
  finalizedStatus?: WorkspaceSyncStatusV1;
  finalizedRoute?: Extract<WorkspaceSyncPrepareBetweenResultV1, { ok: true }>['traversed'];
  finalized?: boolean;
  relationshipTransaction?: PreparedWorkspaceSyncRelationship;
  remoteSource?: Readonly<{ machineId: string; input: WorkspaceSyncHandoffSourceInputV1; physicalEndpoint?: MachineInstallationPublicIdentityV1 }>;
  sourcePhaseAuthority?: WorkspaceSyncHandoffSourcePhaseAuthority;
  sourcePhaseContext?: RpcHandlerContext;
  hadPrivateExecution?: boolean;
}>;

export function sameExecutionWorkspace(input: Pick<PrepareWorkspaceSyncHandoffInput,
  'sourceWorkspaceRefId' | 'targetWorkspaceRefId' | 'sourceMachineId' | 'targetMachineId' | 'sourceRootPath' | 'targetRootPath' | 'targetManaged'>): boolean {
  return !input.targetManaged && input.sourceWorkspaceRefId !== undefined && input.sourceWorkspaceRefId === input.targetWorkspaceRefId
    && input.sourceMachineId === input.targetMachineId && input.sourceRootPath === input.targetRootPath;
}

function sourcePhaseInput(input: PrepareWorkspaceSyncHandoffInput): WorkspaceSyncHandoffSourceInputV1 {
  return WorkspaceSyncHandoffSourceInputV1Schema.parse({
    operationId: input.operationId, accountServerId: input.accountServerId,
    ...(input.sourceSessionId !== undefined ? { sourceSessionId: input.sourceSessionId } : {}),
    action: input.action, sourceMachineId: input.sourceMachineId, targetMachineId: input.targetMachineId,
    ...(input.sourceWorkspaceRefId !== undefined ? { sourceWorkspaceRefId: input.sourceWorkspaceRefId } : {}),
    ...(input.targetWorkspaceRefId !== undefined ? { targetWorkspaceRefId: input.targetWorkspaceRefId } : {}),
    sourceRootPath: input.sourceRootPath, targetRootPath: input.targetRootPath,
    ...(input.targetReplacementApproval !== undefined ? { targetReplacementApproval: input.targetReplacementApproval } : {}),
    ...(input.targetReplacementApprovalReceiptId !== undefined ? { targetReplacementApprovalReceiptId: input.targetReplacementApprovalReceiptId } : {}),
    ...(input.targetReplacementApprovalActionInput !== undefined ? { targetReplacementApprovalActionInput: input.targetReplacementApprovalActionInput } : {}),
  });
}

async function callSourcePhase(operation: Pick<PreparedOperation, 'admittedInput' | 'remoteSource'>,
  request: WorkspaceSyncHandoffSourcePhaseRequestV1, signal?: AbortSignal): Promise<WorkspaceSyncHandoffSourcePhaseResultV1> {
  if (!operation.remoteSource || !operation.admittedInput.callWorkspaceSourcePhase) {
    throw adapterError('workspace_sync_update_required', 'Physical source phase transport is unavailable');
  }
  try {
    const result = WorkspaceSyncHandoffSourcePhaseResultV1Schema.parse(await operation.admittedInput.callWorkspaceSourcePhase({
      machineId: operation.remoteSource.machineId, request,
      ...(operation.remoteSource.physicalEndpoint ? { physicalEndpoint: operation.remoteSource.physicalEndpoint } : {}),
      ...(signal ? { signal } : {}),
    }));
    const expected = { prepare: 'prepared', finalize: 'finalized', commit: 'committed', abort: 'aborted' } as const;
    const settled = result.phase === 'prepared' ? result.prepared
      : result.phase === 'finalized' || result.phase === 'committed' ? result.result : undefined;
    if (result.phase !== expected[request.phase] || (settled !== undefined
      && (settled.operationId !== request.input.operationId || settled.kind !== request.input.action.kind))) {
      throw adapterError('workspace_sync_operation_conflict', 'Source phase response identity mismatch');
    }
    return result;
  } catch (error) {
    if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
      throw adapterError('workspace_sync_update_required', 'Physical source controller requires an update');
    }
    throw error;
  }
}

function copyOnceInput(input: PrepareWorkspaceSyncHandoffInput): WorkspaceSyncCopyOnceV1 {
  if (input.action.kind !== 'copy_once') throw new Error('workspace sync action is not copy_once');
  if (!input.sourceWorkspaceRefId || !input.targetWorkspaceRefId) {
    throw adapterError('workspace_ref_not_ready', 'Workspace copy endpoints are unavailable');
  }
  return {
    v: 1, operationId: input.operationId, controllerMachineId: input.sourceMachineId,
    alphaWorkspaceRefId: input.sourceWorkspaceRefId, betaWorkspaceRefId: input.targetWorkspaceRefId,
    contentPolicy: validateWorkspaceSyncContentPolicy(input.action.contentPolicy),
    ...(input.action.exclusionCandidates ? { exclusionCandidates: input.action.exclusionCandidates } : {}),
  };
}

async function prepareLinkedRoute(deps: WorkspaceSyncHandoffAdapterDeps, input: PrepareWorkspaceSyncHandoffInput,
  context?: RpcHandlerContext): Promise<Extract<WorkspaceSyncPrepareBetweenResultV1, { ok: true }>['traversed']> {
  if (!deps.prepareBetween) throw adapterError('workspace_sync_unavailable', 'Linked workspace preparation is unavailable');
  if (!input.sourceWorkspaceRefId || !input.targetWorkspaceRefId) throw adapterError('workspace_ref_not_ready', 'Linked workspace endpoints are unavailable');
  const result = await deps.prepareBetween({
    sourceWorkspaceRefId: input.sourceWorkspaceRefId, targetWorkspaceRefId: input.targetWorkspaceRefId,
  }, input.signal, context);
  if (!result.ok) {
    const completedIds = result.completed.map(({ relationshipId }) => relationshipId);
    const partial = completedIds.length > 0;
    const message = partial
      ? `Some files synchronized through ${completedIds.join(' → ')}; ${result.blockedRelationshipId ?? 'the next link'} is blocked (${result.errorCode})`
      : `Workspace preparation stopped at ${result.blockedRelationshipId ?? result.errorCode}`;
    throw Object.assign(new Error(message), { code: partial ? 'workspace_sync_partial_route_blocked' : result.errorCode, details: result });
  }
  return result.traversed;
}

function buildSettledResult(
  operationId: string,
  prepared: WorkspaceSyncHandoffPrepared,
  status: WorkspaceSyncStatusV1 | undefined,
  traversed: WorkspaceSyncHandoffPrepared['traversed'],
): WorkspaceSyncHandoffSettledV1 {
  const action = prepared.action;
  return {
    kind: action.kind,
    operationId,
    ...(action.kind === 'relationship'
      ? { relationshipId: action.relationshipId, relationshipCreated: false }
      : action.kind === 'create_relationship' && prepared.relationshipId
        ? { relationshipId: prepared.relationshipId, relationshipCreated: prepared.relationshipCreated ?? true }
        : {}),
    ...(status === undefined ? {} : { status }),
    ...(traversed === undefined ? {} : { traversed }),
  };
}

export function createWorkspaceSyncHandoffAdapter(deps: WorkspaceSyncHandoffAdapterDeps): WorkspaceSyncHandoffAdapter {
  const preparedOperations = new Map<string, PreparedOperation>();
  const registry = deps.executionRegistry ?? createWorkspaceSyncExecutionRegistry();
  const relationshipControllerFor = (context?: RpcHandlerContext) => ({
    flush: (relationshipId: string, signal?: AbortSignal) => deps.relationshipController
      ? deps.relationshipController.flush(relationshipId, signal, context) : deps.sync.flush(relationshipId, signal),
  });

  const adapter: WorkspaceSyncHandoffAdapter = {
    executionRegistry: registry,
    async preparePrivateExecution(request) {
      if (!deps.preparePrivateExecution) throw adapterError('workspace_sync_unavailable', 'Private Sync execution is unavailable');
      const execution = await deps.preparePrivateExecution(request);
      registry.retain({ input: request.input, execution });
      return execution;
    },
    retainPrivateExecution: request => registry.retain(request),
    bindPrivateExecutionRelationship: (operationId, relationshipId, settledPhase) =>
      registry.bindRelationship(operationId, relationshipId, settledPhase),
    resolvePrivateExecution: request => registry.resolve(request),
    listPrivateExecutions: () => registry.list(),
    resolvePrivateWorkspaceRef: (workspaceRefId, serverId) => registry.resolveWorkspaceRef(workspaceRefId, serverId),
    releasePrivateExecution: operationId => registry.release(operationId),
    releaseAllPrivateExecutions: () => registry.releaseAll(),
    resolvePreparedManagedCopySource(operationId, workspaceRefId) {
      const source = preparedOperations.get(operationId)?.fence?.managedCopySource;
      return source?.workspace.id === workspaceRefId ? source : null;
    },
    resolvePreparedCopyTarget(operationId, workspaceRefId) {
      const operation = preparedOperations.get(operationId);
      const target = operation?.fence?.targetWorkspace;
      return operation?.prepared.action.kind === 'copy_once' && target?.id === workspaceRefId ? target : null;
    },
    async applySourcePhase(request, signal, authority, context) {
      const existing = preparedOperations.get(request.input.operationId);
      if (existing && (!sameAdmittedHandoffInput(existing.admittedInput, request.input)
        || !isDeepStrictEqual(existing.sourcePhaseAuthority, authority)
        || ('prepared' in request && request.prepared !== undefined && !isDeepStrictEqual(existing.prepared, request.prepared)))) {
        throw adapterError('workspace_sync_operation_conflict', 'Source phase does not match the retained operation');
      }
      if (request.phase === 'prepare') {
        const prepared = await adapter.prepare({ ...request.input, ...(signal ? { signal } : {}) }, authority, context);
        const operation = preparedOperations.get(request.input.operationId);
        if (operation) preparedOperations.set(request.input.operationId, {
          ...operation, ...(authority ? { sourcePhaseAuthority: authority } : {}), ...(context ? { sourcePhaseContext: context } : {}),
        });
        return { v: 1, phase: 'prepared', prepared };
      }
      if (!existing) {
        if (request.phase === 'abort') return { v: 1, phase: 'aborted' };
        throw adapterError('workspace_sync_prepare_missing', 'Source preparation is unavailable');
      }
      if (request.phase === 'abort') {
        await adapter.abort({ operationId: request.input.operationId, prepared: existing.prepared });
        return { v: 1, phase: 'aborted' };
      }
      const phaseInput = { operationId: request.input.operationId, prepared: existing.prepared, ...(signal ? { signal } : {}) };
      if (request.phase === 'finalize') return { v: 1, phase: 'finalized', result: await adapter.finalize(phaseInput) };
      return { v: 1, phase: 'committed', result: await adapter.commit(phaseInput) };
    },
    async prepareBetween(request, signal, context) {
      if (!deps.prepareBetween) throw adapterError('workspace_sync_unavailable', 'Linked workspace preparation is unavailable');
      signal?.throwIfAborted();
      return await deps.prepareBetween(request, signal, context);
    },
    async prepare(input, authority, context) {
      input.signal?.throwIfAborted();
      const existingOperation = preparedOperations.get(input.operationId);
      if (existingOperation) {
        if (!sameAdmittedHandoffInput(existingOperation.admittedInput, input)) {
          throw adapterError('workspace_sync_operation_conflict', 'Workspace sync operation identity is already in use');
        }
        return existingOperation.prepared;
      }
      if (input.action.kind !== 'none' && (!input.sourceRootPath.trim() || !input.targetRootPath.trim())) {
        throw adapterError('workspace_root_unsafe', 'workspace_root_unsafe');
      }
      if (input.action.kind === 'copy_once') validateWorkspaceSyncContentPolicy(input.action.contentPolicy);
      const hadPrivateExecution = registry.hasOperation(input.operationId)
        || (input.action.kind === 'create_relationship'
          && registry.findByRelationshipId(deriveWorkspaceSyncRelationshipId(input.operationId)) !== null)
        || (input.action.kind === 'relationship'
          && registry.findByRelationshipId(input.action.relationshipId) !== null);
      try {
        const admittedInput = input;
        const execution = input.action.kind !== 'none' ? await deps.resolveExecutionInput?.(input, authority, context) : undefined;
        if (execution) input = execution.input;
        if ((input.action.kind === 'copy_once' || input.action.kind === 'create_relationship')
          && admittedInput.sourceMachineId !== input.sourceMachineId
          && deps.localMachineId !== undefined && input.sourceMachineId !== deps.localMachineId
          && !sameExecutionWorkspace(input)) {
          const remoteSource = {
            machineId: input.sourceMachineId, input: sourcePhaseInput(admittedInput),
            ...(execution?.sourcePhysicalEndpoint ? { physicalEndpoint: execution.sourcePhysicalEndpoint } : {}),
          };
          input.onEffectsIssued?.();
          const result = await callSourcePhase({ admittedInput, remoteSource }, { v: 1, phase: 'prepare', input: remoteSource.input }, input.signal);
          if (result.phase !== 'prepared' || result.prepared.operationId !== input.operationId
            || !isDeepStrictEqual(result.prepared.action, input.action)) {
            throw adapterError('workspace_sync_operation_conflict', 'Physical source preparation is invalid');
          }
          preparedOperations.set(input.operationId, { prepared: result.prepared, admittedInput, executionInput: input, remoteSource });
          return result.prepared;
        }
        const relationshipOwner = input.action.kind === 'create_relationship'
          || input.action.kind === 'copy_once' && (!input.sourceWorkspaceRefId || !input.targetWorkspaceRefId)
          ? await deps.resolveRelationshipOwner?.(input, context) ?? deps.relationshipOwner : undefined;
        if (input.action.kind === 'create_relationship') {
          if (!relationshipOwner) throw adapterError('workspace_sync_unavailable', 'Workspace relationship owner is unavailable');
          const accountServerId = input.accountServerId?.trim();
          if (!accountServerId) throw adapterError('workspace_ref_not_ready', 'Workspace relationship Account Home is unavailable');
          input.onEffectsIssued?.();
          const relationshipTransaction = await relationshipOwner.prepareCreate({
            operationId: input.operationId, serverId: accountServerId,
            sourceMachineId: input.sourceMachineId, sourceRootPath: input.sourceRootPath,
            ...(input.targetManaged ? { targetManaged: input.targetManaged, purpose: 'project_files' as const } : { targetMachineId: input.targetMachineId }),
            targetRootPath: input.targetRootPath,
            ...(input.sourceWorkspaceRefId ? { sourceWorkspaceRefId: input.sourceWorkspaceRefId } : {}),
            ...(input.targetWorkspaceRefId ? { targetWorkspaceRefId: input.targetWorkspaceRefId } : {}),
            mode: input.action.mode, contentPolicy: validateWorkspaceSyncContentPolicy(input.action.contentPolicy),
            targetBootstrap: 'materialize_from_source_workspace',
            ...(input.targetReplacementApproval ? {
              targetReplacementApproval: input.targetReplacementApproval,
              targetReplacementApprovalActionInput: input.targetReplacementApprovalActionInput,
            } : {}),
            ...(input.targetReplacementApprovalReceiptId ? { targetReplacementApprovalReceiptId: input.targetReplacementApprovalReceiptId } : {}),
            flushBeforeCommit: true, ...(input.signal ? { signal: input.signal } : {}), ...(context ? { requesterContext: context } : {}),
          });
          let preparedStatus: WorkspaceSyncStatusV1;
          try {
            preparedStatus = assertWorkspaceSyncStatusClean(relationshipTransaction.status);
          } catch (error) {
            try { await relationshipTransaction.abort(); } catch (cleanupError) {
              throw new AggregateError([error, cleanupError], 'Workspace relationship preparation failed and cleanup is pending');
            }
            throw error;
          }
          const prepared: WorkspaceSyncHandoffPrepared = {
            kind: input.action.kind, operationId: input.operationId,
            relationshipId: relationshipTransaction.relationship.relationshipId,
            relationshipCreated: !relationshipTransaction.reused, action: input.action, status: preparedStatus,
          };
          preparedOperations.set(input.operationId, { prepared, admittedInput, executionInput: input, relationshipTransaction, hadPrivateExecution });
          return prepared;
        }
        let effectiveInput = input;
        if (input.action.kind !== 'none' && typeof deps.bootstrap !== 'function') {
          throw adapterError('workspace_sync_unavailable', 'Workspace sync bootstrap authority is unavailable');
        }
        let withdrawTarget: ((cause: unknown) => Promise<never>) | undefined;
        if (input.action.kind === 'copy_once' && (!input.sourceWorkspaceRefId || !input.targetWorkspaceRefId)) {
          const accountServerId = input.accountServerId?.trim();
          if (!relationshipOwner || !accountServerId) throw adapterError('workspace_ref_not_ready', 'Workspace copy Account Home is unavailable');
          input.onEffectsIssued?.();
          const endpoints = await relationshipOwner.materializeEndpoints({
            serverId: accountServerId, sourceMachineId: input.sourceMachineId, sourceRootPath: input.sourceRootPath,
            ...(input.managedCopySource ? { sourceAddress: workspaceAddressFromRefV2(input.managedCopySource), purpose: 'project_files' as const } : {}),
            ...(input.targetManaged ? { targetManaged: input.targetManaged, purpose: 'project_files' as const } : { targetMachineId: input.targetMachineId }),
            targetRootPath: input.targetRootPath,
            ...(input.sourceWorkspaceRefId ? { sourceWorkspaceRefId: input.sourceWorkspaceRefId } : {}),
            ...(input.targetWorkspaceRefId ? { targetWorkspaceRefId: input.targetWorkspaceRefId } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          });
          withdrawTarget = endpoints.withdrawTarget;
          effectiveInput = { ...input, sourceWorkspaceRefId: endpoints.source.id, targetWorkspaceRefId: endpoints.target.id };
        }
        const sameWorkspace = (input.action.kind === 'linked_workspace' || input.action.kind === 'copy_once') && sameExecutionWorkspace(input);
        let fence: PreparedOperation['fence'];
        if (input.action.kind !== 'none' && !sameWorkspace) {
          input.onEffectsIssued?.();
          try {
            fence = await deps.bootstrap(effectiveInput, admittedInput, authority, context, execution?.targetPreflight);
          } catch (error) {
            const refusal = copyPreparationRefusal(input, error);
            if (withdrawTarget && refusal) await withdrawTarget(refusal);
            throw refusal ?? error;
          }
        }
        try {
          if (input.action.kind === 'copy_once' && fence?.targetWorkspace) {
            const target = fence.targetWorkspace;
            effectiveInput = {
              ...effectiveInput, targetWorkspaceRefId: target.id,
              targetMachineId: resolveWorkspaceSyncExecutionMachineIdV1(target), targetRootPath: target.rootPath,
              targetManaged: isManagedWorkspaceRefV2(target) ? { managedId: target.managedId, controller: target.controller } : undefined,
            };
          }
          const status = input.action.kind === 'relationship'
            ? await prepareWorkspaceSyncRelationship(relationshipControllerFor(context), input.action.relationshipId, input.signal)
            : undefined;
          const traversed = input.action.kind === 'linked_workspace'
            ? await prepareLinkedRoute(deps, admittedInput, context)
            : undefined;
          const prepared: WorkspaceSyncHandoffPrepared = {
            kind: input.action.kind, operationId: input.operationId, action: input.action,
            ...(input.action.kind === 'copy_once' && fence?.copyOnceBaseline ? { copyOnceBaseline: fence.copyOnceBaseline } : {}),
            ...(input.action.kind === 'copy_once' && fence?.copyOnceExcludedPaths ? { copyOnceExcludedPaths: fence.copyOnceExcludedPaths } : {}),
            ...(input.action.kind === 'relationship' ? { relationshipId: input.action.relationshipId, relationshipCreated: false } : {}),
            ...(status === undefined ? {} : { status }),
            ...(traversed === undefined ? {} : { traversed }),
          };
          preparedOperations.set(input.operationId, {
            prepared, admittedInput, executionInput: effectiveInput, hadPrivateExecution,
            ...(fence ? { fence } : {}), ...(context ? { sourcePhaseContext: context } : {}),
          });
          return prepared;
        } catch (error) {
          try { await fence?.release('abort'); } catch (cleanupError) {
            logger.warnLocalFile('[Workspace Sync] Refused target custody release failed', { failureCause: projectActionFailureCauseV1(cleanupError) });
          }
          throw error;
        }
      } catch (error) {
        const retained = registry.getByOperationId(input.operationId);
        if (!hadPrivateExecution && !preparedOperations.has(input.operationId)
          && retained !== null && (!retained.relationshipId || error instanceof WorkspaceSyncPreparationRefusal)) {
          try { await registry.release(input.operationId); } catch (cleanupError) {
            logger.warnLocalFile('[Workspace Sync] Refused private execution cleanup failed', { failureCause: projectActionFailureCauseV1(cleanupError) });
          }
        }
        throw error;
      }
    },
    async finalize(input) {
      input.signal?.throwIfAborted();
      const operation = preparedOperations.get(input.operationId);
      if (!operation && input.prepared.action.kind !== 'none') {
        throw adapterError('workspace_sync_prepare_missing', 'Workspace sync preparation authority is unavailable');
      }
      const prepared = operation?.prepared ?? input.prepared;
      const preparedInput = operation?.executionInput;
      try {
        if (operation?.remoteSource) {
          const result = await callSourcePhase(operation, { v: 1, phase: 'finalize', input: operation.remoteSource.input, prepared: operation.prepared }, input.signal);
          if (result.phase !== 'finalized') throw new Error('Source finalization response mismatch');
          preparedOperations.set(input.operationId, { ...operation, finalized: true, finalizedStatus: result.result.status, finalizedRoute: result.result.traversed });
          return result.result;
        }
        let status = prepared.status;
        let traversed = prepared.traversed;
        if (prepared.action.kind === 'copy_once') {
          if (!preparedInput) throw adapterError('workspace_sync_prepare_missing', 'Workspace sync preparation authority is unavailable');
          const seededContentOnly = prepared.action.contentPolicy.contentOnly && prepared.copyOnceBaseline !== undefined;
          if (!seededContentOnly && !sameExecutionWorkspace(preparedInput)) {
            status = assertWorkspaceSyncStatusClean(await deps.sync.copyOnce(copyOnceInput(preparedInput), input.signal, operation?.fence?.ownershipHandles));
          }
        } else if (prepared.action.kind === 'relationship' && prepared.action.flushBeforeCommit) {
          status = await prepareWorkspaceSyncRelationship(relationshipControllerFor(operation?.sourcePhaseContext),
            prepared.action.relationshipId, input.signal);
        } else if (prepared.action.kind === 'create_relationship' && prepared.relationshipId) {
          status = await prepareWorkspaceSyncRelationship(deps.sync, prepared.relationshipId, input.signal);
        } else if (prepared.action.kind === 'linked_workspace') {
          if (!preparedInput) throw adapterError('workspace_sync_prepare_missing', 'Workspace sync preparation authority is unavailable');
          traversed = await prepareLinkedRoute(deps, operation!.admittedInput, operation!.sourcePhaseContext);
        }
        await operation?.relationshipTransaction?.commit();
        if (operation) preparedOperations.set(input.operationId, { ...operation, finalized: true, finalizedStatus: status, finalizedRoute: traversed });
        return buildSettledResult(input.operationId, prepared, status, traversed);
      } finally {
        const retained = registry.getByOperationId(input.operationId);
        if (retained?.relationshipId) await registry.bindRelationship(input.operationId, retained.relationshipId, 'relationship');
      }
    },
    async commit(input) {
      input.signal?.throwIfAborted();
      const operation = preparedOperations.get(input.operationId);
      const prepared = operation?.prepared ?? input.prepared;
      if (prepared.action.kind !== 'none' && !operation) {
        throw adapterError('workspace_sync_prepare_missing', 'Workspace sync preparation authority is unavailable');
      }
      if (prepared.action.kind !== 'none' && !operation?.finalized) {
        throw adapterError('workspace_sync_finalize_missing', 'Workspace sync finalization is required before target resume');
      }
      if (operation?.remoteSource) {
        const result = await callSourcePhase(operation, { v: 1, phase: 'commit', input: operation.remoteSource.input, prepared: operation.prepared }, input.signal);
        if (result.phase !== 'committed') throw new Error('Source commit response mismatch');
        if (result.result.relationshipId) await registry.bindRelationship(input.operationId, result.result.relationshipId, 'relationship');
        preparedOperations.delete(input.operationId);
        return result.result;
      }
      await operation?.fence?.release('commit');
      if (prepared.relationshipId) await registry.bindRelationship(input.operationId, prepared.relationshipId, 'relationship');
      else if (!operation?.hadPrivateExecution) await registry.release(input.operationId);
      preparedOperations.delete(input.operationId);
      return buildSettledResult(input.operationId, prepared, operation?.finalizedStatus ?? prepared.status, operation?.finalizedRoute ?? prepared.traversed);
    },
    async abort(input) {
      const operation = preparedOperations.get(input.operationId);
      if (operation?.remoteSource) {
        await callSourcePhase(operation, { v: 1, phase: 'abort', input: operation.remoteSource.input, prepared: operation.prepared });
        await registry.release(input.operationId);
        preparedOperations.delete(input.operationId);
        return;
      }
      const cleanup = await Promise.allSettled([
        ...(operation?.prepared.action.kind === 'copy_once' && !sameExecutionWorkspace(operation.executionInput) ? [deps.sync.terminate(input.operationId)] : []),
        ...(operation?.relationshipTransaction ? [operation.relationshipTransaction.abort()] : []),
        ...(operation?.fence ? [operation.fence.release('abort')] : []),
      ]);
      const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Workspace handoff abort cleanup failed');
      if (!operation?.hadPrivateExecution) await registry.release(input.operationId);
      preparedOperations.delete(input.operationId);
    },
  };
  return adapter;
}
