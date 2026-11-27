import { isDeepStrictEqual } from 'node:util';
import type { WorkspaceRefV1 } from '@happier-dev/protocol';
import type { ManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import {
  normalizeWorkspaceRootPathV1,
  resolveWorkspaceRefV1,
  workspaceAddressFromRefV2,
} from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { resolveWorkspaceRefById } from '@/workspaces/workspaceRefsV1';
import type {
  PrepareWorkspaceSyncHandoffInput,
  RetainedWorkspaceSyncPrivateExecution,
  WorkspaceSyncPrivateExecution,
  WorkspaceSyncPrivateWorkspaceResolution,
} from './workspaceSyncHandoffAdapter';

export function sameAdmittedHandoffInput(
  left: PrepareWorkspaceSyncHandoffInput,
  right: PrepareWorkspaceSyncHandoffInput,
): boolean {
  return (['operationId', 'accountServerId', 'sourceSessionId', 'sourceMachineId', 'targetMachineId',
    'sourceWorkspaceRefId', 'targetWorkspaceRefId', 'sourceRootPath', 'targetRootPath',
    'targetReplacementApprovalReceiptId'] as const).every(field => left[field] === right[field])
    && isDeepStrictEqual(left.action, right.action)
    && isDeepStrictEqual(left.managedCopySource, right.managedCopySource)
    && isDeepStrictEqual(left.targetManaged, right.targetManaged)
    && isDeepStrictEqual(left.targetReplacementApproval, right.targetReplacementApproval)
    && isDeepStrictEqual(left.targetReplacementApprovalActionInput, right.targetReplacementApprovalActionInput);
}

export type RetainWorkspaceSyncExecutionInput = Readonly<{
  input: PrepareWorkspaceSyncHandoffInput;
  execution: WorkspaceSyncPrivateExecution;
  relationshipId?: string;
  phase?: RetainedWorkspaceSyncPrivateExecution['phase'];
}>;

export type ManagedTargetQuery = ManagedWorkspaceRefV2 | Readonly<{
  serverId: string; managedId: string; controller: ManagedWorkspaceRefV2['controller']; rootPath: string; id?: string;
}>;

export interface WorkspaceSyncExecutionRegistry {
  hasOperation(operationId: string): boolean;
  getByOperationId(operationId: string): RetainedWorkspaceSyncPrivateExecution | null;
  findByRelationshipId(relationshipId: string): RetainedWorkspaceSyncPrivateExecution | null;
  findByOperationOrRelationship(id: string): RetainedWorkspaceSyncPrivateExecution | null;
  findForRequester(relationshipId: string, accountId: string | undefined, serverId?: string): RetainedWorkspaceSyncPrivateExecution | null;
  findByRootPath(rootPath: string): readonly RetainedWorkspaceSyncPrivateExecution[];
  findByManagedTarget(target: ManagedTargetQuery, filter?: Readonly<{ accountId?: string; serverId?: string }>): RetainedWorkspaceSyncPrivateExecution | null;
  findManagedByEndpoint(relationshipId: string, workspaceRefId: string): RetainedWorkspaceSyncPrivateExecution | null;
  retain(request: RetainWorkspaceSyncExecutionInput): void;
  bindRelationship(operationId: string, relationshipId: string, settledPhase?: 'relationship'): Promise<void>;
  resolve(request: Readonly<{ operationId?: string; relationshipId?: string }>): RetainedWorkspaceSyncPrivateExecution | null;
  list(): readonly RetainedWorkspaceSyncPrivateExecution[];
  resolveWorkspaceRef(workspaceRefId: string, serverId: string): WorkspaceSyncPrivateWorkspaceResolution;
  release(operationId: string): Promise<void>;
  releaseAll(): Promise<void>;
}

const managedTargetKey = (t: Pick<ManagedWorkspaceRefV2, 'serverId' | 'managedId' | 'controller' | 'rootPath'>) =>
  JSON.stringify([t.serverId, t.managedId, t.controller.machineId, t.controller.installationId, normalizeWorkspaceRootPathV1(t.rootPath)]);

const toggleBucket = (map: Map<string, Set<string>>, key: string, opId: string, add: boolean) => {
  if (add) {
    let bucket = map.get(key);
    if (!bucket) { bucket = new Set(); map.set(key, bucket); }
    bucket.add(opId);
  } else {
    const bucket = map.get(key);
    if (!bucket) return;
    bucket.delete(opId);
    if (bucket.size === 0) map.delete(key);
  }
};

/**
 * Canonical owner for retained private and managed Workspace Sync executions,
 * indexed by operationId, relationshipId, rootPath, and managedTarget.
 */
export function createWorkspaceSyncExecutionRegistry(): WorkspaceSyncExecutionRegistry {
  const byOperationId = new Map<string, RetainedWorkspaceSyncPrivateExecution>();
  const byRelationshipId = new Map<string, Set<string>>();
  const byRootPath = new Map<string, Set<string>>();
  const byManagedTarget = new Map<string, Set<string>>();

  const updateIndices = (entry: RetainedWorkspaceSyncPrivateExecution, add: boolean): void => {
    const opId = entry.input.operationId;
    if (entry.relationshipId) toggleBucket(byRelationshipId, entry.relationshipId, opId, add);
    const roots = new Set<string>();
    if (entry.input.sourceRootPath) roots.add(entry.input.sourceRootPath);
    if (entry.input.targetRootPath) roots.add(entry.input.targetRootPath);
    if (entry.execution.managedTarget) roots.add(entry.execution.managedTarget.workspace.rootPath);
    for (const root of roots) toggleBucket(byRootPath, root, opId, add);
    if (entry.execution.managedTarget) {
      toggleBucket(byManagedTarget, managedTargetKey(entry.execution.managedTarget.workspace), opId, add);
    }
  };

  const withBinder = (entry: RetainedWorkspaceSyncPrivateExecution): RetainedWorkspaceSyncPrivateExecution => ({
    ...entry,
    bindRelationship: (relationshipId, settledPhase) =>
      registry.bindRelationship(entry.input.operationId, relationshipId, settledPhase),
  });

  const readByOp = (opId: string | undefined) => {
    const entry = opId !== undefined ? byOperationId.get(opId) : undefined;
    return entry ? withBinder(entry) : null;
  };

  const firstRelationshipOp = (relationshipId: string): string | undefined =>
    byRelationshipId.get(relationshipId)?.values().next().value;

  const registry: WorkspaceSyncExecutionRegistry = {
    hasOperation: operationId => byOperationId.has(operationId),
    getByOperationId: operationId => readByOp(operationId),
    findByRelationshipId: relationshipId => readByOp(firstRelationshipOp(relationshipId)),
    findByOperationOrRelationship: id => readByOp(id) ?? readByOp(firstRelationshipOp(id)),
    findForRequester: (relationshipId, accountId, serverId) => {
      if (!accountId) return null;
      for (const opId of byRelationshipId.get(relationshipId) ?? []) {
        const entry = byOperationId.get(opId);
        if (!entry || entry.execution.accountRowsCustody.accountId !== accountId) continue;
        if (serverId !== undefined && entry.execution.accountRowsCustody.serverId !== serverId) continue;
        return withBinder(entry);
      }
      return null;
    },
    findByRootPath: rootPath => {
      const ops = byRootPath.get(rootPath);
      return ops ? [...ops].flatMap(opId => { const e = readByOp(opId); return e ? [e] : []; }) : [];
    },
    findByManagedTarget: (target, filter) => {
      const ops = byManagedTarget.get(managedTargetKey(target));
      if (!ops) return null;
      const address = 'id' in target && target.id ? workspaceAddressFromRefV2(target as ManagedWorkspaceRefV2) : null;
      for (const opId of ops) {
        const entry = byOperationId.get(opId);
        const workspace = entry?.execution.managedTarget?.workspace;
        if (!entry || !workspace) continue;
        if (filter?.accountId && entry.execution.accountRowsCustody.accountId !== filter.accountId) continue;
        if (filter?.serverId && entry.execution.accountRowsCustody.serverId !== filter.serverId) continue;
        const matched = address
          ? resolveWorkspaceRefV1([workspace], address).kind === 'resolved'
          : workspace.serverId === target.serverId && workspace.managedId === target.managedId
            && isDeepStrictEqual(workspace.controller, target.controller) && normalizeWorkspaceRootPathV1(workspace.rootPath) === normalizeWorkspaceRootPathV1(target.rootPath);
        if (matched) return withBinder(entry);
      }
      return null;
    },
    findManagedByEndpoint: (relationshipId, workspaceRefId) => {
      for (const opId of byRelationshipId.get(relationshipId) ?? []) {
        const entry = byOperationId.get(opId);
        if (entry?.execution.managedTarget?.workspace.id === workspaceRefId) return withBinder(entry);
      }
      const direct = registry.getByOperationId(relationshipId);
      return direct?.execution.managedTarget?.workspace.id === workspaceRefId ? direct : null;
    },
    retain(request) {
      const previous = byOperationId.get(request.input.operationId);
      if (previous && (!sameAdmittedHandoffInput(previous.input, request.input) || previous.execution !== request.execution)) {
        throw Object.assign(new Error('Private Sync operation identity is already in use'), { code: 'workspace_sync_operation_conflict' });
      }
      const next: RetainedWorkspaceSyncPrivateExecution = { ...previous, ...request, phase: request.phase ?? previous?.phase ?? 'open' };
      byOperationId.set(request.input.operationId, next);
      if (!previous) {
        updateIndices(next, true);
      } else if (previous.relationshipId !== next.relationshipId) {
        if (previous.relationshipId) toggleBucket(byRelationshipId, previous.relationshipId, request.input.operationId, false);
        if (next.relationshipId) toggleBucket(byRelationshipId, next.relationshipId, request.input.operationId, true);
      }
    },
    async bindRelationship(operationId, relationshipId, settledPhase) {
      const current = byOperationId.get(operationId);
      if (!current) return;
      if (current.relationshipId && current.relationshipId !== relationshipId) {
        throw Object.assign(new Error('Private Sync relationship identity changed'), { code: 'workspace_sync_operation_conflict' });
      }
      if (current.relationshipId !== relationshipId) {
        await current.execution.retainRelationship?.(relationshipId);
        if (current.relationshipId) toggleBucket(byRelationshipId, current.relationshipId, operationId, false);
        toggleBucket(byRelationshipId, relationshipId, operationId, true);
      }
      const next: RetainedWorkspaceSyncPrivateExecution = { ...current, relationshipId, phase: settledPhase ?? current.phase };
      byOperationId.set(operationId, next);
    },
    resolve({ operationId, relationshipId }) {
      if (operationId === undefined && relationshipId === undefined) return null;
      const entry = operationId !== undefined ? byOperationId.get(operationId) : byOperationId.get(firstRelationshipOp(relationshipId!) ?? '');
      if (!entry || (relationshipId !== undefined && entry.relationshipId !== relationshipId)) return null;
      return withBinder(entry);
    },
    list: () => [...byOperationId.values()],
    resolveWorkspaceRef(workspaceRefId, serverId) {
      const endpoints = new Set<string>();
      const unique: WorkspaceRefV1[] = [];
      for (const { execution } of byOperationId.values()) {
        for (const workspace of execution.getSnapshot?.()?.workspaceRefs ?? []) {
          if (workspace.id !== workspaceRefId) continue;
          const key = JSON.stringify([execution.accountRowsCustody.accountId, workspace.serverId, workspace.id, workspace.machineId, workspace.rootPath]);
          if (endpoints.has(key)) continue;
          endpoints.add(key);
          unique.push(workspace);
        }
      }
      if (!unique.length) return { kind: 'unowned' };
      const workspace: WorkspaceRefV1 | null = resolveWorkspaceRefById(unique, workspaceRefId, serverId);
      return workspace ? { kind: 'resolved', workspace } : { kind: 'unavailable' };
    },
    async release(operationId) {
      const retained = byOperationId.get(operationId);
      await retained?.execution.release();
      if (retained) { updateIndices(retained, false); byOperationId.delete(operationId); }
    },
    async releaseAll() {
      const results = await Promise.allSettled([...byOperationId.keys()].map(opId => registry.release(opId)));
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'Private Sync cleanup failed');
    },
  };

  return registry;
}
