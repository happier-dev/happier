import {
  computeWorkspaceSyncPolicyDigest,
  type WorkspaceContentPolicyV1,
  type WorkspaceSyncCopyOnceV1,
} from './workspaceSyncTypes';

/**
 * Handoff's only workspace integration seam.  The adapter deliberately knows
 * about product actions and lifecycle, while ManagedWorkspaceSync owns all
 * Mutagen/session mechanics.
 */

export type WorkspaceSyncContentPolicy = Readonly<{
  v: 1;
  selection: string;
  extraIgnorePatterns: readonly string[];
  extraIncludePatterns: readonly string[];
  includeGitDirectory: boolean;
  policyDigest?: string;
}>;

export type WorkspaceSyncHandoffAction =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'copy_once'; contentPolicy: WorkspaceSyncContentPolicy }>
  | Readonly<{ kind: 'relationship'; relationshipId: string; flushBeforeCommit: boolean }>;

export type PrepareWorkspaceSyncHandoffInput = Readonly<{
  operationId: string;
  action: WorkspaceSyncHandoffAction;
  sourceMachineId: string;
  targetMachineId: string;
  sourceWorkspaceRefId: string;
  targetWorkspaceRefId: string;
  sourceRootPath: string;
  targetRootPath: string;
  controllerMachineId?: string;
  mode?: string;
  contentPolicy?: WorkspaceSyncContentPolicy;
  signal?: AbortSignal;
}>;

export type WorkspaceSyncHandoffPrepared = Readonly<{
  kind: WorkspaceSyncHandoffAction['kind'];
  operationId: string;
  relationshipId?: string;
  action: WorkspaceSyncHandoffAction;
  status?: unknown;
}>;

export type CommitWorkspaceSyncHandoffInput = Readonly<{
  operationId: string;
  prepared: WorkspaceSyncHandoffPrepared;
  signal?: AbortSignal;
}>;

export type WorkspaceSyncHandoffCommitted = Readonly<{
  kind: WorkspaceSyncHandoffAction['kind'];
  operationId: string;
  relationshipId?: string;
  status?: unknown;
}>;

export type AbortWorkspaceSyncHandoffInput = Readonly<{
  operationId: string;
  prepared?: WorkspaceSyncHandoffPrepared;
  signal?: AbortSignal;
}>;

export type ManagedWorkspaceSyncLike = object;

export type WorkspaceSyncHandoffAdapterDeps = Readonly<{
  sync: ManagedWorkspaceSyncLike;
  bootstrap?: (input: PrepareWorkspaceSyncHandoffInput) => Promise<void>;
}>;

export interface WorkspaceSyncHandoffAdapter {
  prepare(input: PrepareWorkspaceSyncHandoffInput): Promise<WorkspaceSyncHandoffPrepared>;
  commit(input: CommitWorkspaceSyncHandoffInput): Promise<WorkspaceSyncHandoffCommitted>;
  abort(input: AbortWorkspaceSyncHandoffInput): Promise<void>;
}

type PreparedOperation = Readonly<{
  prepared: WorkspaceSyncHandoffPrepared;
  input: PrepareWorkspaceSyncHandoffInput;
  relationshipExisted: boolean;
}>;

function requireMethod(sync: ManagedWorkspaceSyncLike, method: string): (...args: readonly unknown[]) => Promise<unknown> {
  const fn = (sync as Readonly<Record<string, unknown>>)[method];
  if (typeof fn !== 'function') throw new Error(`workspace_sync_${String(method)}_unavailable`);
  return fn as (...args: readonly unknown[]) => Promise<unknown>;
}

function relationshipDefinition(input: PrepareWorkspaceSyncHandoffInput): Readonly<Record<string, unknown>> {
  if (input.action.kind !== 'relationship') throw new Error('workspace_sync_relationship_action_required');
  const policy = normalizePolicy(input.contentPolicy);
  return {
    v: 1,
    relationshipId: input.action.relationshipId,
    controllerMachineId: input.controllerMachineId ?? input.sourceMachineId,
    alphaWorkspaceRefId: input.sourceWorkspaceRefId,
    betaWorkspaceRefId: input.targetWorkspaceRefId,
    mode: input.mode ?? 'keep_synced',
    contentPolicy: policy,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

function normalizePolicy(policy: WorkspaceSyncContentPolicy | undefined): WorkspaceContentPolicyV1 {
  const base = {
    v: 1 as const,
    selection: (policy?.selection === 'git_worktree' ? 'git_worktree' : 'all_files') as WorkspaceContentPolicyV1['selection'],
    extraIgnorePatterns: [...(policy?.extraIgnorePatterns ?? [])],
    extraIncludePatterns: [...(policy?.extraIncludePatterns ?? [])],
    includeGitDirectory: policy?.includeGitDirectory === true,
  };
  return { ...base, policyDigest: policy?.policyDigest ?? computeWorkspaceSyncPolicyDigest(base) };
}

export function createWorkspaceSyncHandoffAdapter(deps: WorkspaceSyncHandoffAdapterDeps): WorkspaceSyncHandoffAdapter {
  const preparedByOperation = new Map<string, PreparedOperation>();

  return {
    async prepare(input: PrepareWorkspaceSyncHandoffInput): Promise<WorkspaceSyncHandoffPrepared> {
      input.signal?.throwIfAborted();
      if (input.action.kind !== 'none' && (!input.sourceRootPath.trim() || !input.targetRootPath.trim())) {
        throw Object.assign(new Error('workspace_root_unsafe'), { code: 'workspace_root_unsafe' });
      }
      await deps.bootstrap?.(input);
      let status: unknown;
      let relationshipExisted = false;
      if (input.action.kind === 'relationship') {
        const get = (deps.sync as Readonly<Record<string, unknown>>).get;
        if (typeof get === 'function') {
          const existing = await (get as (id: string, signal?: AbortSignal) => Promise<unknown>)(input.action.relationshipId, input.signal);
          relationshipExisted = existing !== null;
          if (existing !== null) status = existing;
        }
        if (!relationshipExisted) {
          status = await requireMethod(deps.sync, 'ensure')(relationshipDefinition(input), input.signal);
        }
      }
      const prepared: WorkspaceSyncHandoffPrepared = {
        kind: input.action.kind,
        operationId: input.operationId,
        action: input.action,
        ...(input.action.kind === 'relationship' ? { relationshipId: input.action.relationshipId } : {}),
        ...(status === undefined ? {} : { status }),
      };
      preparedByOperation.set(input.operationId, { prepared, input, relationshipExisted });
      return prepared;
    },

    async commit(input: CommitWorkspaceSyncHandoffInput): Promise<WorkspaceSyncHandoffCommitted> {
      input.signal?.throwIfAborted();
      const operation = preparedByOperation.get(input.operationId);
      const prepared = operation?.prepared ?? input.prepared;
      const preparedInput = operation?.input;
      const action = prepared.action;
      let status: unknown;
      if (action.kind === 'copy_once') {
        const copyInput: WorkspaceSyncCopyOnceV1 = {
          v: 1,
          operationId: input.operationId,
          controllerMachineId: preparedInput?.sourceMachineId ?? '',
          alphaWorkspaceRefId: preparedInput?.sourceWorkspaceRefId ?? '',
          betaWorkspaceRefId: preparedInput?.targetWorkspaceRefId ?? '',
          contentPolicy: normalizePolicy(action.contentPolicy),
        };
        status = await requireMethod(deps.sync, 'copyOnce')(copyInput, input.signal);
      } else if (action.kind === 'relationship' && action.flushBeforeCommit) {
        status = await requireMethod(deps.sync, 'flush')(action.relationshipId, input.signal);
      }
      preparedByOperation.delete(input.operationId);
      return {
        kind: action.kind,
        operationId: input.operationId,
        ...(action.kind === 'relationship' ? { relationshipId: action.relationshipId } : {}),
        ...(status === undefined ? {} : { status }),
      };
    },

    async abort(input: AbortWorkspaceSyncHandoffInput): Promise<void> {
      input.signal?.throwIfAborted();
      const operation = preparedByOperation.get(input.operationId);
      const prepared = operation?.prepared ?? input.prepared;
      preparedByOperation.delete(input.operationId);
      if (prepared?.action.kind === 'relationship' && prepared.action.relationshipId && operation?.relationshipExisted === false) {
        await requireMethod(deps.sync, 'terminate')(prepared.action.relationshipId, input.signal);
      }
    },
  };
}
