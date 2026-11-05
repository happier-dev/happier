import {
  type ManagedWorkspaceSync,
  type WorkspaceSyncCopyOnceV1,
} from './workspaceSyncTypes';
import { validateWorkspaceSyncContentPolicy } from './workspaceSyncSettings';
import type {
  HandoffTargetReplacementApprovalV1,
  HandoffWorkspaceActionV1,
  WorkspaceSyncPrepareBetweenResultV1,
  WorkspaceSyncStatusV1,
  WorkspaceRefV1,
} from '@happier-dev/protocol';
import type { WorkspaceRootOwnershipHandle } from './workspaceSyncRootOwnership';
import type {
  PreparedWorkspaceSyncRelationship,
  WorkspaceSyncRelationshipOwner,
} from './workspaceSyncRelationshipOwner';
import { assertWorkspaceSyncStatusClean, prepareWorkspaceSyncRelationship } from './workspaceSyncPreparation';
import {
  WorkspaceSyncHandoffSourceInputV1Schema,
  WorkspaceSyncHandoffSourcePhaseResultV1Schema,
  type WorkspaceSyncHandoffSourceInputV1,
  type WorkspaceSyncHandoffSourcePhaseRequestV1,
  type WorkspaceSyncHandoffSourcePhaseResultV1,
  type WorkspaceSyncHandoffPreparedV1,
  type WorkspaceSyncHandoffSettledV1,
  type HandoffTargetReplacementPreflightResultV1,
} from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';
import { isDeepStrictEqual } from 'node:util';
import type { WorkspaceSyncSourceContextV1 } from '@happier-dev/protocol/socketRpc';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { StoredCredentials } from '@/persistence';
import type { ActiveProjectAccountRowsSnapshot, ProjectAccountSessionCustody } from '@/workspaces/projectAccountRows';
import type { HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { PrivateProjectNativeSync, PrivateProjectSyncEffectConfiguration, PrivateProjectSyncNetwork } from '@/workspaces/activation/privateProjectSyncEffect';
import type { WorkspaceSyncTargetPhaseDescriptor } from './workspaceSyncTargetAuthority';
import { resolveWorkspaceRefById } from '@/workspaces/workspaceRefsV1';

/**
 * Handoff's only workspace integration seam.  The adapter deliberately knows
 * about product actions and lifecycle, while ManagedWorkspaceSync owns all
 * Mutagen/session mechanics.
 */

export type WorkspaceSyncHandoffAction = HandoffWorkspaceActionV1;

/** Verified host admission retained only in the incumbent prepared operation. Never a wire credential. */
export type WorkspaceSyncHandoffSourcePhaseAuthority = WorkspaceSyncSourceContextV1;

/** Host-only Open custody. It never enters source-phase or Action wire input. */
export type WorkspaceSyncPrivateExecution = Readonly<{
  credentials: StoredCredentials;
  accountRowsCustody: ProjectAccountSessionCustody;
  executionIdentity?: HostRequesterExecutionIdentity;
  nativeSync?: PrivateProjectNativeSync;
  getSnapshot?: () => ActiveProjectAccountRowsSnapshot | null;
  replaceSnapshot?: (snapshot: ActiveProjectAccountRowsSnapshot) => Promise<void>;
  callTargetPhase?: (descriptor: WorkspaceSyncTargetPhaseDescriptor) => Promise<unknown>;
  /** Receiving admission binds its original signed SOURCE transport on the host. */
  bindTargetPhaseContext?: (context: RpcHandlerContext) => void;
  /** The receiving admitted relationship refreshes its Account graph at this owner. */
  recoverConflictResolutionHere?: (request: Parameters<PrivateProjectNativeSync['recoverConflictResolutionHere']>[0],
    signal?: AbortSignal) => ReturnType<PrivateProjectNativeSync['recoverConflictResolutionHere']>;
  assertTransferCurrent(): Promise<void>;
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
  /** Host-derived Account Home scope, required only for relationship creation. */
  accountServerId?: string;
  sourceSessionId?: string;
  targetReplacementApproval?: HandoffTargetReplacementApprovalV1;
  targetReplacementApprovalReceiptId?: string;
  targetReplacementApprovalActionInput?: unknown;
  action: WorkspaceSyncHandoffAction;
  sourceMachineId: string;
  targetMachineId: string;
  sourceWorkspaceRefId?: string;
  targetWorkspaceRefId?: string;
  sourceRootPath: string;
  targetRootPath: string;
  signal?: AbortSignal;
  /** Host-bound transport retains the actual caller authority; never serialized. */
  callWorkspaceSourcePhase?: (descriptor: Readonly<{
    machineId: string;
    request: WorkspaceSyncHandoffSourcePhaseRequestV1;
    signal?: AbortSignal;
  }>) => Promise<unknown>;
}>;

export type WorkspaceSyncHandoffPrepared = Readonly<WorkspaceSyncHandoffPreparedV1>;

export type CommitWorkspaceSyncHandoffInput = Readonly<{
  operationId: string;
  prepared: WorkspaceSyncHandoffPrepared;
  signal?: AbortSignal;
}>;

export type WorkspaceSyncHandoffCommitted = Readonly<WorkspaceSyncHandoffSettledV1>;
export type FinalizeWorkspaceSyncHandoffInput = CommitWorkspaceSyncHandoffInput;
export type WorkspaceSyncHandoffFinalized = WorkspaceSyncHandoffCommitted;

export type AbortWorkspaceSyncHandoffInput = Readonly<{
  operationId: string;
  prepared?: WorkspaceSyncHandoffPrepared;
  signal?: AbortSignal;
}>;

export type WorkspaceSyncHandoffAdapterDeps = Readonly<{
  sync: ManagedWorkspaceSync;
  preparePrivateExecution?: (input: PrepareWorkspaceSyncPrivateExecutionInput) => Promise<WorkspaceSyncPrivateExecution>;
  resolveRelationshipOwner?: (input: PrepareWorkspaceSyncHandoffInput, context?: RpcHandlerContext) => Promise<Pick<WorkspaceSyncRelationshipOwner, 'materializeEndpoints' | 'prepareCreate'>>;
  localMachineId?: string;
  /** Production resolves native bind custody without changing admitted Session/Project placement. */
  resolveExecutionInput?: (input: PrepareWorkspaceSyncHandoffInput, authority?: WorkspaceSyncHandoffSourcePhaseAuthority,
    context?: RpcHandlerContext) => Promise<Readonly<{
    input: PrepareWorkspaceSyncHandoffInput;
    targetPreflight?: HandoffTargetReplacementPreflightResultV1;
  }>>;
  relationshipController?: Pick<ManagedWorkspaceSync, 'flush'>;
  prepareBetween?: (
    request: Readonly<{ sourceWorkspaceRefId: string; targetWorkspaceRefId: string }>,
    signal?: AbortSignal,
    context?: RpcHandlerContext,
  ) => Promise<WorkspaceSyncPrepareBetweenResultV1>;
  relationshipOwner?: Pick<WorkspaceSyncRelationshipOwner, 'materializeEndpoints' | 'prepareCreate'>;
  bootstrap: (input: PrepareWorkspaceSyncHandoffInput, admittedInput?: PrepareWorkspaceSyncHandoffInput,
    authority?: WorkspaceSyncHandoffSourcePhaseAuthority, context?: RpcHandlerContext,
    targetPreflight?: HandoffTargetReplacementPreflightResultV1) => Promise<Readonly<{
    release(reason: 'abort' | 'commit'): Promise<void>;
    ownershipHandles?: readonly WorkspaceRootOwnershipHandle[];
    targetWorkspace?: WorkspaceRefV1;
  }>>;
}>;

export interface WorkspaceSyncHandoffAdapter {
  preparePrivateExecution?(input: PrepareWorkspaceSyncPrivateExecutionInput): Promise<WorkspaceSyncPrivateExecution>;
  retainPrivateExecution?(input: Readonly<{ input: PrepareWorkspaceSyncHandoffInput; execution: WorkspaceSyncPrivateExecution;
    phase?: RetainedWorkspaceSyncPrivateExecution['phase'] }>): void;
  bindPrivateExecutionRelationship?(operationId: string, relationshipId: string, settledPhase?: 'relationship'): Promise<void>;
  resolvePrivateExecution?(input: Readonly<{ operationId?: string; relationshipId?: string }>): RetainedWorkspaceSyncPrivateExecution | null;
  listPrivateExecutions?(): readonly RetainedWorkspaceSyncPrivateExecution[];
  resolvePrivateWorkspaceRef?(workspaceRefId: string, serverId: string): WorkspaceSyncPrivateWorkspaceResolution;
  releasePrivateExecution?(operationId: string): Promise<void>;
  releaseAllPrivateExecutions?(): Promise<void>;
  /** Exact accepted copy endpoint in the incumbent prepared operation only. */
  resolvePreparedCopyTarget?(operationId: string, workspaceRefId: string): WorkspaceRefV1 | null;
  applySourcePhase?(request: WorkspaceSyncHandoffSourcePhaseRequestV1, signal?: AbortSignal,
    authority?: WorkspaceSyncHandoffSourcePhaseAuthority, context?: RpcHandlerContext): Promise<WorkspaceSyncHandoffSourcePhaseResultV1>;
  prepareBetween(
    request: Readonly<{ sourceWorkspaceRefId: string; targetWorkspaceRefId: string }>,
    signal?: AbortSignal,
    context?: RpcHandlerContext,
  ): Promise<WorkspaceSyncPrepareBetweenResultV1>;
  prepare(input: PrepareWorkspaceSyncHandoffInput, authority?: WorkspaceSyncHandoffSourcePhaseAuthority,
    context?: RpcHandlerContext): Promise<WorkspaceSyncHandoffPrepared>;
  finalize(input: FinalizeWorkspaceSyncHandoffInput): Promise<WorkspaceSyncHandoffFinalized>;
  commit(input: CommitWorkspaceSyncHandoffInput): Promise<WorkspaceSyncHandoffCommitted>;
  abort(input: AbortWorkspaceSyncHandoffInput): Promise<void>;
}

/** One containing agent-free Open; the same adapter owns clean bytes, READY and commit custody. */
export async function materializeWorkspaceSyncForOpen(adapter: WorkspaceSyncHandoffAdapter, request: PrepareWorkspaceSyncHandoffInput,
  context?: RpcHandlerContext, authority?: WorkspaceSyncHandoffSourcePhaseAuthority): Promise<void> {
  const prepared = await adapter.prepare(request, authority, context);
  await adapter.finalize({ operationId: request.operationId, prepared, signal: request.signal });
  await adapter.commit({ operationId: request.operationId, prepared, signal: request.signal });
}

type PreparedOperation = Readonly<{
  prepared: WorkspaceSyncHandoffPrepared;
  /** Retry identity remains the admitted request, before endpoint resolution. */
  admittedInput: PrepareWorkspaceSyncHandoffInput;
  executionInput: PrepareWorkspaceSyncHandoffInput;
  fence?: Readonly<{
    release(reason: 'abort' | 'commit'): Promise<void>;
    ownershipHandles?: readonly WorkspaceRootOwnershipHandle[];
    targetWorkspace?: WorkspaceRefV1;
  }>;
  finalizedStatus?: WorkspaceSyncStatusV1;
  finalizedRoute?: Extract<WorkspaceSyncPrepareBetweenResultV1, { ok: true }>['traversed'];
  finalized?: boolean;
  relationshipTransaction?: PreparedWorkspaceSyncRelationship;
  remoteSource?: Readonly<{ machineId: string; input: WorkspaceSyncHandoffSourceInputV1 }>;
  sourcePhaseAuthority?: WorkspaceSyncHandoffSourcePhaseAuthority;
  /** Original verified host context stays private; cleanup never replays its bearer or canceled callbacks. */
  sourcePhaseContext?: RpcHandlerContext;
}>;

function sameAdmittedInput(left: PrepareWorkspaceSyncHandoffInput, right: PrepareWorkspaceSyncHandoffInput): boolean {
  return (['operationId', 'accountServerId', 'sourceSessionId', 'sourceMachineId', 'targetMachineId',
    'sourceWorkspaceRefId', 'targetWorkspaceRefId', 'sourceRootPath', 'targetRootPath',
    'targetReplacementApprovalReceiptId'] as const).every(field => left[field] === right[field])
    && isDeepStrictEqual(left.action, right.action)
    && isDeepStrictEqual(left.targetReplacementApproval, right.targetReplacementApproval)
    && isDeepStrictEqual(left.targetReplacementApprovalActionInput, right.targetReplacementApprovalActionInput);
}

export function sameExecutionWorkspace(input: Pick<PrepareWorkspaceSyncHandoffInput,
  'sourceWorkspaceRefId' | 'targetWorkspaceRefId' | 'sourceMachineId' | 'targetMachineId' | 'sourceRootPath' | 'targetRootPath'>): boolean {
  return input.sourceWorkspaceRefId !== undefined && input.sourceWorkspaceRefId === input.targetWorkspaceRefId
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
    throw Object.assign(new Error('Physical source phase transport is unavailable'), { code: 'workspace_sync_update_required' });
  }
  try {
    const result = WorkspaceSyncHandoffSourcePhaseResultV1Schema.parse(await operation.admittedInput.callWorkspaceSourcePhase({
      machineId: operation.remoteSource.machineId, request,
      ...(signal ? { signal } : {}),
    }));
    const expected = { prepare: 'prepared', finalize: 'finalized', commit: 'committed', abort: 'aborted' } as const;
    const settled = result.phase === 'prepared' ? result.prepared
      : result.phase === 'finalized' || result.phase === 'committed' ? result.result : undefined;
    if (result.phase !== expected[request.phase] || (settled !== undefined
      && (settled.operationId !== request.input.operationId || settled.kind !== request.input.action.kind))) {
      throw Object.assign(new Error('Source phase response identity mismatch'), { code: 'workspace_sync_operation_conflict' });
    }
    return result;
  } catch (error) {
    if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
      throw Object.assign(new Error('Physical source controller requires an update'), { code: 'workspace_sync_update_required' });
    }
    throw error;
  }
}

function copyOnceInput(input: PrepareWorkspaceSyncHandoffInput): WorkspaceSyncCopyOnceV1 {
  if (input.action.kind !== 'copy_once') throw new Error('workspace sync action is not copy_once');
  if (!input.sourceWorkspaceRefId || !input.targetWorkspaceRefId) {
    throw Object.assign(new Error('Workspace copy endpoints are unavailable'), { code: 'workspace_ref_not_ready' });
  }
  return {
    v: 1,
    operationId: input.operationId,
    controllerMachineId: input.sourceMachineId,
    alphaWorkspaceRefId: input.sourceWorkspaceRefId,
    betaWorkspaceRefId: input.targetWorkspaceRefId,
    contentPolicy: validateWorkspaceSyncContentPolicy(input.action.contentPolicy),
  };
}

async function prepareLinkedRoute(
  deps: WorkspaceSyncHandoffAdapterDeps,
  input: PrepareWorkspaceSyncHandoffInput,
  context?: RpcHandlerContext,
): Promise<Extract<WorkspaceSyncPrepareBetweenResultV1, { ok: true }>['traversed']> {
  if (!deps.prepareBetween) {
    throw Object.assign(new Error('Linked workspace preparation is unavailable'), { code: 'workspace_sync_unavailable' });
  }
  if (!input.sourceWorkspaceRefId || !input.targetWorkspaceRefId) {
    throw Object.assign(new Error('Linked workspace endpoints are unavailable'), { code: 'workspace_ref_not_ready' });
  }
  const result = await deps.prepareBetween({
    sourceWorkspaceRefId: input.sourceWorkspaceRefId,
    targetWorkspaceRefId: input.targetWorkspaceRefId,
  }, input.signal, context);
  if (!result.ok) {
    const completedIds = result.completed.map(({ relationshipId }) => relationshipId);
    const partial = completedIds.length > 0;
    const message = partial
      ? `Some files synchronized through ${completedIds.join(' → ')}; ${result.blockedRelationshipId ?? 'the next link'} is blocked (${result.errorCode})`
      : `Workspace preparation stopped at ${result.blockedRelationshipId ?? result.errorCode}`;
    throw Object.assign(new Error(message), {
      code: partial ? 'workspace_sync_partial_route_blocked' : result.errorCode,
      details: result,
    });
  }
  return result.traversed;
}

export function createWorkspaceSyncHandoffAdapter(deps: WorkspaceSyncHandoffAdapterDeps): WorkspaceSyncHandoffAdapter {
  const preparedByOperation = new Map<string, { operation?: PreparedOperation; privateExecution?: RetainedWorkspaceSyncPrivateExecution }>();
  const getPrepared = (operationId: string) => preparedByOperation.get(operationId)?.operation;
  const setPrepared = (operationId: string, operation: PreparedOperation) => {
    preparedByOperation.set(operationId, { ...preparedByOperation.get(operationId), operation });
  };
  const deletePrepared = (operationId: string) => {
    const retained = preparedByOperation.get(operationId)?.privateExecution;
    if (retained?.relationshipId) preparedByOperation.set(operationId, { privateExecution: retained });
    else preparedByOperation.delete(operationId);
  };
  const relationshipController = deps.relationshipController ?? deps.sync;

  const adapter: WorkspaceSyncHandoffAdapter = {
    async preparePrivateExecution(request) {
      if (!deps.preparePrivateExecution) throw Object.assign(new Error('Private Sync execution is unavailable'), { code: 'workspace_sync_unavailable' });
      const execution = await deps.preparePrivateExecution(request);
      adapter.retainPrivateExecution!({ input: request.input, execution });
      return execution;
    },
    retainPrivateExecution(request) {
      const previous = preparedByOperation.get(request.input.operationId);
      if (previous?.privateExecution && (!sameAdmittedInput(previous.privateExecution.input, request.input)
        || previous.privateExecution.execution !== request.execution)) {
        throw Object.assign(new Error('Private Sync operation identity is already in use'), { code: 'workspace_sync_operation_conflict' });
      }
      preparedByOperation.set(request.input.operationId, { ...previous, privateExecution: {
        ...previous?.privateExecution, ...request, phase: request.phase ?? previous?.privateExecution?.phase ?? 'open',
      } });
    },
    async bindPrivateExecutionRelationship(operationId, relationshipId, settledPhase) {
      const record = preparedByOperation.get(operationId);
      if (!record?.privateExecution) return;
      if (record.privateExecution.relationshipId && record.privateExecution.relationshipId !== relationshipId) {
        throw Object.assign(new Error('Private Sync relationship identity changed'), { code: 'workspace_sync_operation_conflict' });
      }
      if (record.privateExecution.relationshipId !== relationshipId) {
        await record.privateExecution.execution.retainRelationship?.(relationshipId);
      }
      record.privateExecution = { ...record.privateExecution, relationshipId,
        phase: settledPhase ?? record.privateExecution.phase };
    },
    resolvePrivateExecution(request) {
      if (request.operationId === undefined && request.relationshipId === undefined) return null;
      const retained = request.operationId !== undefined ? preparedByOperation.get(request.operationId)?.privateExecution
        : [...preparedByOperation.values()].find(record => record.privateExecution?.relationshipId === request.relationshipId)?.privateExecution;
      return retained && (request.relationshipId === undefined || retained.relationshipId === request.relationshipId)
        ? { ...retained, bindRelationship: (relationshipId, settledPhase) => adapter.bindPrivateExecutionRelationship!(retained.input.operationId, relationshipId, settledPhase) } : null;
    },
    listPrivateExecutions: () => [...preparedByOperation.values()].flatMap(record => record.privateExecution ? [record.privateExecution] : []),
    resolvePrivateWorkspaceRef(workspaceRefId, serverId) {
      const candidates = [...preparedByOperation.values()].flatMap(record => {
        const capture = record.privateExecution?.execution;
        return capture?.getSnapshot?.()?.workspaceRefs.filter(ref => ref.id === workspaceRefId)
          .map(workspace => ({ accountId: capture.accountRowsCustody.accountId, workspace })) ?? [];
      });
      if (!candidates.length) return { kind: 'unowned' };
      const endpoints = new Set<string>();
      const unique = candidates.filter(({ accountId, workspace }) => {
        const endpoint = JSON.stringify([accountId, workspace.serverId, workspace.id, workspace.machineId, workspace.rootPath]);
        if (endpoints.has(endpoint)) return false;
        endpoints.add(endpoint);
        return true;
      });
      const workspace = resolveWorkspaceRefById(unique.map(candidate => candidate.workspace), workspaceRefId, serverId);
      return workspace ? { kind: 'resolved', workspace } : { kind: 'unavailable' };
    },
    async releasePrivateExecution(operationId) {
      const retained = preparedByOperation.get(operationId)?.privateExecution;
      // The captured lifetime owner knows whether Open still needs the checkout
      // or a retained relationship has accepted responsibility for its member.
      await retained?.execution.release();
      preparedByOperation.delete(operationId);
    },
    async releaseAllPrivateExecutions() {
      const results = await Promise.allSettled([...preparedByOperation.entries()].filter(([, record]) => record.privateExecution)
        .map(([operationId]) => adapter.releasePrivateExecution!(operationId)));
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'Private Sync cleanup failed');
    },
    resolvePreparedCopyTarget(operationId, workspaceRefId) {
      const operation = getPrepared(operationId);
      const target = operation?.fence?.targetWorkspace;
      return operation?.prepared.action.kind === 'copy_once' && target?.id === workspaceRefId ? target : null;
    },
    async applySourcePhase(request, signal, authority, context) {
      const existing = getPrepared(request.input.operationId);
      if (existing && (!sameAdmittedInput(existing.admittedInput, request.input)
        || !isDeepStrictEqual(existing.sourcePhaseAuthority, authority)
        || ('prepared' in request && request.prepared !== undefined
          && !isDeepStrictEqual(existing.prepared, request.prepared)))) {
        throw Object.assign(new Error('Source phase does not match the retained operation'), { code: 'workspace_sync_operation_conflict' });
      }
      if (request.phase === 'prepare') {
        const prepared = await adapter.prepare({ ...request.input, ...(signal ? { signal } : {}) }, authority, context);
        const operation = getPrepared(request.input.operationId);
        if (operation) setPrepared(request.input.operationId, { ...operation,
          ...(authority ? { sourcePhaseAuthority: authority } : {}),
          ...(context ? { sourcePhaseContext: context } : {}) });
        return { v: 1, phase: 'prepared', prepared };
      }
      if (!existing) {
        if (request.phase === 'abort') return { v: 1, phase: 'aborted' };
        throw Object.assign(new Error('Source preparation is unavailable'), { code: 'workspace_sync_prepare_missing' });
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
      if (!deps.prepareBetween) {
        throw Object.assign(new Error('Linked workspace preparation is unavailable'), { code: 'workspace_sync_unavailable' });
      }
      signal?.throwIfAborted();
      return await deps.prepareBetween(request, signal, context);
    },
    async prepare(input: PrepareWorkspaceSyncHandoffInput, authority?: WorkspaceSyncHandoffSourcePhaseAuthority,
      context?: RpcHandlerContext): Promise<WorkspaceSyncHandoffPrepared> {
      input.signal?.throwIfAborted();
      const existingOperation = getPrepared(input.operationId);
      if (existingOperation) {
        const existingInput = existingOperation.admittedInput;
        const matches = sameAdmittedInput(existingInput, input);
        if (!matches) {
          throw Object.assign(new Error('Workspace sync operation identity is already in use'), {
            code: 'workspace_sync_operation_conflict',
          });
        }
        return existingOperation.prepared;
      }
      if (input.action.kind !== 'none' && (!input.sourceRootPath.trim() || !input.targetRootPath.trim())) {
        throw Object.assign(new Error('workspace_root_unsafe'), { code: 'workspace_root_unsafe' });
      }
      if (input.action.kind === 'copy_once') validateWorkspaceSyncContentPolicy(input.action.contentPolicy);
      const admittedInput = input;
      const execution = input.action.kind !== 'none' ? await deps.resolveExecutionInput?.(input, authority, context) : undefined;
      if (execution) input = execution.input;
      if ((input.action.kind === 'copy_once' || input.action.kind === 'create_relationship')
        && admittedInput.sourceMachineId !== input.sourceMachineId
        && deps.localMachineId !== undefined && input.sourceMachineId !== deps.localMachineId
        && !sameExecutionWorkspace(input)) {
        const remoteSource = { machineId: input.sourceMachineId, input: sourcePhaseInput(admittedInput) };
        const result = await callSourcePhase({ admittedInput, remoteSource }, { v: 1, phase: 'prepare', input: remoteSource.input }, input.signal);
        if (result.phase !== 'prepared' || result.prepared.operationId !== input.operationId
          || !isDeepStrictEqual(result.prepared.action, input.action)) {
          throw Object.assign(new Error('Physical source preparation is invalid'), { code: 'workspace_sync_operation_conflict' });
        }
        setPrepared(input.operationId, { prepared: result.prepared, admittedInput, executionInput: input,
          remoteSource });
        return result.prepared;
      }
      const relationshipOwner = await deps.resolveRelationshipOwner?.(input, context) ?? deps.relationshipOwner;
      if (input.action.kind === 'create_relationship') {
        if (!relationshipOwner) {
          throw Object.assign(new Error('Workspace relationship owner is unavailable'), { code: 'workspace_sync_unavailable' });
        }
        const accountServerId = input.accountServerId?.trim();
        if (!accountServerId) {
          throw Object.assign(new Error('Workspace relationship Account Home is unavailable'), { code: 'workspace_ref_not_ready' });
        }
        const relationshipTransaction = await relationshipOwner.prepareCreate({
          operationId: input.operationId,
          serverId: accountServerId,
          sourceMachineId: input.sourceMachineId,
          sourceRootPath: input.sourceRootPath,
          targetMachineId: input.targetMachineId,
          targetRootPath: input.targetRootPath,
          ...(input.sourceWorkspaceRefId ? { sourceWorkspaceRefId: input.sourceWorkspaceRefId } : {}),
          ...(input.targetWorkspaceRefId ? { targetWorkspaceRefId: input.targetWorkspaceRefId } : {}),
          mode: input.action.mode,
          contentPolicy: validateWorkspaceSyncContentPolicy(input.action.contentPolicy),
          // Bootstrap mechanics are daemon-owned. New targets are inspected
          // under target custody; a non-empty replacement still fails closed
          // until the canonical Action approval is replayed.
          targetBootstrap: 'materialize_from_source_workspace',
          ...(input.targetReplacementApproval ? { targetReplacementApproval: input.targetReplacementApproval } : {}),
          ...(input.targetReplacementApprovalReceiptId ? {
            targetReplacementApprovalReceiptId: input.targetReplacementApprovalReceiptId,
            targetReplacementApprovalActionInput: input.targetReplacementApprovalActionInput,
          } : {}),
          flushBeforeCommit: true,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        let preparedStatus: WorkspaceSyncStatusV1;
        try {
          preparedStatus = assertWorkspaceSyncStatusClean(relationshipTransaction.status);
        } catch (error) {
          try {
            await relationshipTransaction.abort();
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              'Workspace relationship preparation failed and cleanup is pending',
            );
          }
          throw error;
        }
        const prepared: WorkspaceSyncHandoffPrepared = {
          kind: input.action.kind,
          operationId: input.operationId,
          relationshipId: relationshipTransaction.relationship.relationshipId,
          relationshipCreated: !relationshipTransaction.reused,
          action: input.action,
          status: preparedStatus,
        };
        setPrepared(input.operationId, { prepared, admittedInput, executionInput: input, relationshipTransaction });
        return prepared;
      }
      let effectiveInput = input;
      if (input.action.kind === 'copy_once' && (!input.sourceWorkspaceRefId || !input.targetWorkspaceRefId)) {
        const accountServerId = input.accountServerId?.trim();
        if (!relationshipOwner || !accountServerId) {
          throw Object.assign(new Error('Workspace copy Account Home is unavailable'), { code: 'workspace_ref_not_ready' });
        }
        const endpoints = await relationshipOwner.materializeEndpoints({
          serverId: accountServerId,
          sourceMachineId: input.sourceMachineId,
          sourceRootPath: input.sourceRootPath,
          targetMachineId: input.targetMachineId,
          targetRootPath: input.targetRootPath,
          ...(input.sourceWorkspaceRefId ? { sourceWorkspaceRefId: input.sourceWorkspaceRefId } : {}),
          ...(input.targetWorkspaceRefId ? { targetWorkspaceRefId: input.targetWorkspaceRefId } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        effectiveInput = {
          ...input,
          sourceWorkspaceRefId: endpoints.source.id,
          targetWorkspaceRefId: endpoints.target.id,
        };
      }
      if (input.action.kind !== 'none' && typeof deps.bootstrap !== 'function') {
        throw Object.assign(new Error('Workspace sync bootstrap authority is unavailable'), { code: 'workspace_sync_unavailable' });
      }
      const sameWorkspace = (input.action.kind === 'linked_workspace' || input.action.kind === 'copy_once')
        && sameExecutionWorkspace(input);
      const fence = input.action.kind === 'none' || sameWorkspace ? undefined
        : await deps.bootstrap(effectiveInput, admittedInput, authority, context, execution?.targetPreflight);
      try {
        if (input.action.kind === 'copy_once' && fence?.targetWorkspace) {
          const target = fence.targetWorkspace;
          effectiveInput = { ...effectiveInput, targetWorkspaceRefId: target.id,
            targetMachineId: target.machineId, targetRootPath: target.rootPath };
        }
        let status: WorkspaceSyncStatusV1 | undefined;
        let traversed: WorkspaceSyncHandoffPrepared['traversed'];
        if (input.action.kind === 'relationship') {
          // Initial materialization/readiness occurs while the source session
          // is still active. The coordinator performs finalize only after the
          // source has been quiesced.
          status = await prepareWorkspaceSyncRelationship(relationshipController, input.action.relationshipId, input.signal);
        } else if (input.action.kind === 'linked_workspace') {
          // Route barriers retain the actual aliases so native currentness is re-read at every flush.
          traversed = await prepareLinkedRoute(deps, admittedInput, context);
        }
        const prepared: WorkspaceSyncHandoffPrepared = {
          kind: input.action.kind,
          operationId: input.operationId,
          action: input.action,
          ...(input.action.kind === 'relationship'
            ? { relationshipId: input.action.relationshipId, relationshipCreated: false }
            : {}),
          ...(status === undefined ? {} : { status }),
          ...(traversed === undefined ? {} : { traversed }),
        };
        setPrepared(input.operationId, { prepared, admittedInput, executionInput: effectiveInput,
          ...(fence ? { fence } : {}),
          ...(context ? { sourcePhaseContext: context } : {}) });
        return prepared;
      } catch (error) {
        await fence?.release('abort');
        throw error;
      }
    },

    async finalize(input: FinalizeWorkspaceSyncHandoffInput): Promise<WorkspaceSyncHandoffFinalized> {
      input.signal?.throwIfAborted();
      const operation = getPrepared(input.operationId);
      if (!operation && input.prepared.action.kind !== 'none') {
        throw Object.assign(new Error('Workspace sync preparation authority is unavailable'), { code: 'workspace_sync_prepare_missing' });
      }
      const prepared = operation?.prepared ?? input.prepared;
      const preparedInput = operation?.executionInput;
      try {
        if (operation?.remoteSource) {
          const result = await callSourcePhase(operation, { v: 1, phase: 'finalize', input: operation.remoteSource.input,
            prepared: operation.prepared }, input.signal);
          if (result.phase !== 'finalized') throw new Error('Source finalization response mismatch');
          setPrepared(input.operationId, { ...operation, finalized: true,
            finalizedStatus: result.result.status, finalizedRoute: result.result.traversed });
          return result.result;
        }
        let status = prepared.status;
        let traversed = prepared.traversed;
        if (prepared.action.kind === 'copy_once') {
          if (!preparedInput) throw Object.assign(new Error('Workspace sync preparation authority is unavailable'), { code: 'workspace_sync_prepare_missing' });
          if (!sameExecutionWorkspace(preparedInput)) {
            status = assertWorkspaceSyncStatusClean(
              await deps.sync.copyOnce(copyOnceInput(preparedInput), input.signal, operation?.fence?.ownershipHandles),
            );
          }
        } else if (prepared.action.kind === 'relationship' && prepared.action.flushBeforeCommit) {
          status = await prepareWorkspaceSyncRelationship(relationshipController, prepared.action.relationshipId, input.signal);
        } else if (prepared.action.kind === 'create_relationship' && prepared.relationshipId) {
          // prepareCreate's first flush proves the relationship is ready while
          // the source is live; this second flush captures the final delta only
          // after the handoff coordinator has quiesced that source. Account
          // Settings already carries disabled intent, while the daemon-local
          // transient engine remains the only active runtime until final READY.
          status = await prepareWorkspaceSyncRelationship(deps.sync, prepared.relationshipId, input.signal);
        } else if (prepared.action.kind === 'linked_workspace') {
          if (!preparedInput) throw Object.assign(new Error('Workspace sync preparation authority is unavailable'), { code: 'workspace_sync_prepare_missing' });
          traversed = await prepareLinkedRoute(deps, operation!.admittedInput, operation!.sourcePhaseContext);
        }
        // After the final source-quiesced flush, the transaction publishes target
        // READY and settles replacement custody before enabling and reconciling
        // the durable relationship. The later adapter commit is cleanup-only.
        await operation?.relationshipTransaction?.commit();
        if (operation) setPrepared(input.operationId, { ...operation, finalized: true, finalizedStatus: status, finalizedRoute: traversed });
        return {
          kind: prepared.action.kind,
          operationId: input.operationId,
          ...(prepared.action.kind === 'relationship'
            ? { relationshipId: prepared.action.relationshipId, relationshipCreated: false }
            : prepared.action.kind === 'create_relationship' && prepared.relationshipId
              ? { relationshipId: prepared.relationshipId, relationshipCreated: prepared.relationshipCreated ?? true }
              : {}),
          ...(status === undefined ? {} : { status }),
          ...(traversed === undefined ? {} : { traversed }),
        };
      } finally {
        // Finalization ends the containing finite Open even when publication
        // loses its acknowledgement. Retained work admits its next transfer.
        const retained = preparedByOperation.get(input.operationId)?.privateExecution;
        if (retained?.relationshipId) {
          await adapter.bindPrivateExecutionRelationship!(input.operationId, retained.relationshipId, 'relationship');
        }
      }
    },

    async commit(input: CommitWorkspaceSyncHandoffInput): Promise<WorkspaceSyncHandoffCommitted> {
      input.signal?.throwIfAborted();
      const operation = getPrepared(input.operationId);
      const prepared = operation?.prepared ?? input.prepared;
      const action = prepared.action;
      if (action.kind !== 'none' && !operation) {
        throw Object.assign(new Error('Workspace sync preparation authority is unavailable'), { code: 'workspace_sync_prepare_missing' });
      }
      if (action.kind !== 'none' && !operation?.finalized) {
        throw Object.assign(new Error('Workspace sync finalization is required before target resume'), { code: 'workspace_sync_finalize_missing' });
      }
      if (operation?.remoteSource) {
        const result = await callSourcePhase(operation, { v: 1, phase: 'commit', input: operation.remoteSource.input,
          prepared: operation.prepared }, input.signal);
        if (result.phase !== 'committed') throw new Error('Source commit response mismatch');
        if (result.result.relationshipId) await adapter.bindPrivateExecutionRelationship!(input.operationId, result.result.relationshipId, 'relationship');
        deletePrepared(input.operationId);
        return result.result;
      }
      const status = operation?.finalizedStatus ?? prepared.status;
      const traversed = operation?.finalizedRoute ?? prepared.traversed;
      // Target custody is already committed. This phase releases only the
      // prepare fence; durable relationship publication happened in finalize.
      // Keep prepared authority until release succeeds so cleanup is retryable.
      await operation?.fence?.release('commit');
      if (prepared.relationshipId) await adapter.bindPrivateExecutionRelationship!(input.operationId, prepared.relationshipId, 'relationship');
      else await adapter.releasePrivateExecution!(input.operationId);
      deletePrepared(input.operationId);
      return {
        kind: action.kind,
        operationId: input.operationId,
        ...(action.kind === 'relationship'
          ? { relationshipId: action.relationshipId, relationshipCreated: false }
          : action.kind === 'create_relationship' && prepared.relationshipId
            ? { relationshipId: prepared.relationshipId, relationshipCreated: prepared.relationshipCreated ?? true }
            : {}),
        ...(status === undefined ? {} : { status }),
        ...(traversed === undefined ? {} : { traversed }),
      };
    },

    async abort(input: AbortWorkspaceSyncHandoffInput): Promise<void> {
      const operation = getPrepared(input.operationId);
      if (operation?.remoteSource) {
        await callSourcePhase(operation, { v: 1, phase: 'abort', input: operation.remoteSource.input, prepared: operation.prepared });
        await adapter.releasePrivateExecution!(input.operationId);
        deletePrepared(input.operationId);
        return;
      }
      const cleanup = await Promise.allSettled([
        ...(operation?.prepared.action.kind === 'copy_once'
          && !sameExecutionWorkspace(operation.executionInput)
          ? [deps.sync.terminate(input.operationId)]
          : []),
        ...(operation?.relationshipTransaction
          ? [operation.relationshipTransaction.abort()]
          : []),
        ...(operation?.fence
          ? [operation.fence.release('abort')]
          : []),
      ]);
      const failures = cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Workspace handoff abort cleanup failed');
      }
      await adapter.releasePrivateExecution!(input.operationId);
      deletePrepared(input.operationId);
    },
  };
  return adapter;
}
