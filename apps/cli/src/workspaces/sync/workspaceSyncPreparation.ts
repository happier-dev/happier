import { areWorkspaceSyncRelationshipDefinitionsEqual } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { deriveWorkspaceSyncTopology, resolveWorkspaceSyncEndpoint, resolveWorkspaceSyncTransferRoute,
  type WorkspaceSyncChildMachineFacts } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { WorkspaceRefV1, WorkspaceSyncPrepareBetweenResultV1, WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol';
import type { WorkspaceSyncStatusV1 } from './workspaceSyncTypes';
import type { StoredCredentials } from '@/persistence';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { readWorkspaceSyncRootObjectIdentity } from './workspaceSyncRootIdentity';
import { readWorkspaceSyncChildMachineFacts } from './workspaceSyncTargetAuthority';
import { managedDevcontainerChildProjectionsEqualV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';

/** Only the incumbent new-operation prerequisite may produce this refusal, before Sync effects. */
export class WorkspaceSyncInitialPreparationRefusal extends Error {
  readonly code: string | undefined;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Workspace Sync preparation is unavailable', { cause });
    this.name = 'WorkspaceSyncInitialPreparationRefusal';
    this.code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
  }
}

/** The finite requester transport cannot own persistent or remote-source bootstrap effects. */
export function assertWorkspaceSyncRequesterBootstrapSupported(input: Readonly<{
  authorization?: ExternalActionExecutionAuthorizationV1;
  ownerKind: 'copy_once' | 'relationship';
  targetReplacement?: boolean;
  materializesRemoteSource?: boolean;
}>): void {
  if (input.authorization && (input.ownerKind !== 'copy_once'
    || input.targetReplacement || input.materializesRemoteSource)) {
    throw Object.assign(new Error('The original requester bootstrap effect owner is unavailable'), {
      code: 'workspace_sync_update_required',
    });
  }
}

export type WorkspaceSyncWorkerTargetBasis = Readonly<{
  source: WorkspaceRefV1;
  target: WorkspaceRefV1;
  workspaceRefs: readonly WorkspaceRefV1[];
  relationships: readonly WorkspaceSyncRelationshipV1[];
  childMachines?: readonly WorkspaceSyncChildMachineFacts[];
}>;

/** Installed finite and service consumers share the same exact route and clean preparation. */
export function createWorkspaceSyncWorkerPreparation(input: Readonly<{
  serverId: string;
  serverHttpBaseUrl: string;
  targetMachineId: string;
  credentials: StoredCredentials;
  isCurrent(): Promise<boolean>;
  prepareBetween(request: Readonly<{ sourceWorkspaceRefId: string; targetWorkspaceRefId: string }>, signal: AbortSignal): Promise<WorkspaceSyncPrepareBetweenResultV1>;
}>) {
  const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
  const readCurrent = async (signal: AbortSignal, sourceWorkspaceRefId: string) => await runWithServerHttpBaseUrl(input.serverHttpBaseUrl,
    async () => {
      const snapshot = await readProjectAccountRows({ credentials: input.credentials, serverId: input.serverId, signal });
      const childMachines = await readWorkspaceSyncChildMachineFacts({ ...input, signal,
        machineIds: snapshot.workspaceRefs.filter(ref => ref.serverId === input.serverId
          && (ref.id === sourceWorkspaceRefId || ref.machineId === input.targetMachineId)).map(ref => ref.machineId) });
      return { ...snapshot, childMachines };
    });
  return {
    resolveWorkerTarget: async ({ source, signal }: Readonly<{ source: WorkspaceRefV1; signal: AbortSignal }>): Promise<WorkspaceSyncWorkerTargetBasis> => {
      if (!await input.isCurrent()) fail('project_requester_credentials_unavailable');
      const snapshot = await readCurrent(signal, source.id);
      const basis = resolveWorkspaceSyncWorkerTarget({ serverId: input.serverId,
        sourceWorkspaceRefId: source.id, targetMachineId: input.targetMachineId,
        workspaceRefs: snapshot.workspaceRefs, relationships: snapshot.relationships, childMachines: snapshot.childMachines });
      if (!basis.ok) return fail(basis.errorCode);
      if (basis.source.machineId !== source.machineId || basis.source.rootPath !== source.rootPath
        || basis.source.projectKey !== source.projectKey || basis.target.projectKey !== source.projectKey) fail('project_workspace_changed');
      await readWorkspaceSyncRootObjectIdentity(basis.target.rootPath);
      return basis;
    },
    prepareDequeue: async ({ choice, basis, signal }: Readonly<{
      workspace: WorkspaceRefV1; choice: ProjectExecutionChoiceV1; basis?: WorkspaceSyncWorkerTargetBasis; signal: AbortSignal;
    }>): Promise<Extract<WorkspaceSyncPrepareBetweenResultV1, { ok: true }> | void> => {
      if (!await input.isCurrent()) fail('project_requester_credentials_unavailable');
      if (choice.kind !== 'workers') return;
      if (!basis) return fail('workspace_sync_source_unavailable');
      assertWorkspaceSyncWorkerTargetCurrent(basis, { ...await readCurrent(signal, basis.source.id), serverId: input.serverId });
      await readWorkspaceSyncRootObjectIdentity(basis.target.rootPath);
      const prepared = await input.prepareBetween({ sourceWorkspaceRefId: basis.source.id, targetWorkspaceRefId: basis.target.id }, signal);
      if (!prepared.ok) return fail(prepared.errorCode);
      assertWorkspaceSyncWorkerTargetCurrent(basis, { ...await readCurrent(signal, basis.source.id), serverId: input.serverId });
      if (!await input.isCurrent()) fail('project_requester_credentials_unavailable');
      return prepared;
    },
  };
}

/** Exact-Machine resolution within Sync's supported component, without effects or alternate selection. */
export function resolveWorkspaceSyncWorkerTarget(input: Readonly<{
  serverId: string;
  sourceWorkspaceRefId: string;
  targetMachineId: string;
  workspaceRefs: readonly WorkspaceRefV1[];
  relationships: readonly WorkspaceSyncRelationshipV1[];
  childMachines?: readonly WorkspaceSyncChildMachineFacts[];
}>): (WorkspaceSyncWorkerTargetBasis & Readonly<{ ok: true }>) | Readonly<{ ok: false; errorCode: string }> {
  const source = resolveWorkspaceRefV1(input.workspaceRefs, { serverId: input.serverId, id: input.sourceWorkspaceRefId });
  if (source.kind !== 'resolved') return { ok: false, errorCode: 'workspace_ref_not_ready' };
  if (source.ref.machineId === input.targetMachineId) {
    return { ok: true, source: source.ref, target: source.ref, workspaceRefs: [source.ref], relationships: [] };
  }
  const sourceEndpoint = resolveWorkspaceSyncEndpoint({ ...input, workspace: source.ref });
  if (!sourceEndpoint.ok) return { ok: false, errorCode: sourceEndpoint.code };
  const topology = deriveWorkspaceSyncTopology(input);
  if (topology.issues.some(issue => issue.workspaceRefIds.includes(source.ref.id))) {
    return { ok: false, errorCode: 'topology_invalid' };
  }
  const component = topology.sets.find(set => set.relationships.some(relationship =>
    relationship.alphaWorkspaceRefId === sourceEndpoint.endpoint.id || relationship.betaWorkspaceRefId === sourceEndpoint.endpoint.id));
  if (!component) return { ok: false, errorCode: 'route_not_found' };
  const endpointIds = new Set(component.relationships.flatMap(relationship =>
    [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId]));
  const targets = input.workspaceRefs.filter(ref => ref.serverId === input.serverId
    && ref.machineId === input.targetMachineId && (() => {
      const resolved = resolveWorkspaceSyncEndpoint({ ...input, workspace: ref });
      return resolved.ok && endpointIds.has(resolved.endpoint.id);
    })());
  if (targets.length !== 1) return { ok: false,
    errorCode: targets.length ? 'workspace_sync_target_ambiguous' : 'workspace_ref_not_ready' };
  const target = targets[0]!;
  const route = resolveWorkspaceSyncTransferRoute({ ...input, targetWorkspaceRefId: target.id });
  if (!route.ok) return { ok: false, errorCode: route.code };
  const routeRefs = new Set(route.relationships.flatMap(relationship =>
    [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId]));
  return { ok: true, source: source.ref, target,
    workspaceRefs: input.workspaceRefs.filter(ref => ref.serverId === input.serverId
      && (routeRefs.has(ref.id) || ref.id === source.ref.id || ref.id === target.id)),
    relationships: route.relationships, ...(input.childMachines ? { childMachines: input.childMachines } : {}) };
}

/** Retain physical addresses and ordered edge custody; dequeue uses current approved Sync policy. */
export function assertWorkspaceSyncWorkerTargetCurrent(basis: WorkspaceSyncWorkerTargetBasis, current: Readonly<{
  serverId: string;
  workspaceRefs: readonly WorkspaceRefV1[];
  relationships: readonly WorkspaceSyncRelationshipV1[];
  childMachines?: readonly WorkspaceSyncChildMachineFacts[];
}>): void {
  const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
  for (const accepted of basis.childMachines ?? []) {
    const matches = current.childMachines?.filter(fact => fact.serverId === accepted.serverId && fact.machineId === accepted.machineId) ?? [];
    if (matches.length !== 1 || matches[0]!.installationId !== accepted.installationId
      || !managedDevcontainerChildProjectionsEqualV1(matches[0]!.projection, accepted.projection)) fail('workspace_sync_child_unavailable');
  }
  for (const accepted of basis.workspaceRefs) {
    const ref = resolveWorkspaceRefV1(current.workspaceRefs, { serverId: current.serverId, id: accepted.id });
    if (ref.kind !== 'resolved' || ref.ref.machineId !== accepted.machineId
      || ref.ref.rootPath !== accepted.rootPath || ref.ref.projectKey !== accepted.projectKey) fail('workspace_ref_changed');
  }
  const route = resolveWorkspaceSyncTransferRoute({ ...current,
    sourceWorkspaceRefId: basis.source.id, targetWorkspaceRefId: basis.target.id });
  if (!route.ok && route.code === 'workspace_sync_child_unavailable') fail(route.code);
  if (!route.ok || route.relationships.length !== basis.relationships.length
    || route.relationships.some((relationship, index) => {
      const accepted = basis.relationships[index]!;
      return relationship.relationshipId !== accepted.relationshipId
        || relationship.controllerMachineId !== accepted.controllerMachineId
        || relationship.alphaWorkspaceRefId !== accepted.alphaWorkspaceRefId
        || relationship.betaWorkspaceRefId !== accepted.betaWorkspaceRefId;
    })) fail('relationship_changed');
}

/** A queued spoke-to-spoke operation can depend on either edge while running on a third Machine. */
export function resolveWorkspaceSyncRelationshipDependencyMachines(input: Readonly<{
  serverId: string;
  relationshipId: string;
  workspaceRefs: readonly WorkspaceRefV1[];
  relationships: readonly WorkspaceSyncRelationshipV1[];
}>): string[] {
  const component = deriveWorkspaceSyncTopology(input).sets
    .find(set => set.relationships.some(relationship => relationship.relationshipId === input.relationshipId));
  if (!component) throw Object.assign(new Error('workspace_sync_dependencies_unavailable'), { code: 'workspace_sync_dependencies_unavailable' });
  const endpointIds = new Set(component.relationships.flatMap(relationship =>
    [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId]));
  return [...new Set(input.workspaceRefs.filter(ref => ref.serverId === input.serverId && endpointIds.has(ref.id))
    .map(ref => ref.machineId))];
}

export function isWorkspaceSyncStatusClean(status: WorkspaceSyncStatusV1): boolean {
  const { alpha, beta } = status.endpointStates;
  return alpha !== null
    && beta !== null
    && alpha.connected
    && beta.connected
    && alpha.scanned
    && beta.scanned
    && alpha.scanProblemCount === 0
    && beta.scanProblemCount === 0
    && alpha.transitionProblemCount === 0
    && beta.transitionProblemCount === 0
    && status.conflictCount === 0
    && status.state !== 'paused'
    && status.state !== 'disconnected'
    && status.state !== 'conflicted'
    && status.state !== 'controller_unavailable'
    && status.state !== 'error'
    && status.state !== 'stopped';
}

export function assertWorkspaceSyncStatusClean(status: WorkspaceSyncStatusV1): WorkspaceSyncStatusV1 {
  if (!isWorkspaceSyncStatusClean(status)) {
    throw Object.assign(new Error('Workspace synchronization did not complete cleanly'), {
      code: 'workspace_sync_not_clean',
      status,
    });
  }
  return status;
}

export async function prepareWorkspaceSyncRelationship(
  sync: Readonly<{ flush(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> }>,
  relationshipId: string,
  signal?: AbortSignal,
): Promise<WorkspaceSyncStatusV1> {
  return assertWorkspaceSyncStatusClean(await sync.flush(relationshipId, signal));
}

function errorCode(error: unknown, fallback: string): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : fallback;
}

/** Ordered, ephemeral pair/star barrier. Current settings are re-read before
 * every effect; no route cursor or successful-link rollback is created. */
export async function prepareWorkspaceSyncBetween(input: Readonly<{
  serverId?: string;
  sourceWorkspaceRefId: string;
  targetWorkspaceRefId: string;
  readCurrent(): Promise<Readonly<{
    workspaceRefs: readonly WorkspaceRefV1[];
    relationships: readonly WorkspaceSyncRelationshipV1[];
    childMachines?: readonly WorkspaceSyncChildMachineFacts[];
  }>>;
  flush(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  signal?: AbortSignal;
}>): Promise<WorkspaceSyncPrepareBetweenResultV1> {
  const initial = await input.readCurrent();
  const route = resolveWorkspaceSyncTransferRoute({
    ...initial,
    serverId: input.serverId,
    sourceWorkspaceRefId: input.sourceWorkspaceRefId,
    targetWorkspaceRefId: input.targetWorkspaceRefId,
  });
  if (!route.ok) return { ok: false, errorCode: route.code, completed: [], ...('relationshipId' in route ? { blockedRelationshipId: route.relationshipId } : {}) };
  if (route.kind === 'same_workspace') return { ok: true, traversed: [] };

  const completed: Extract<WorkspaceSyncPrepareBetweenResultV1, { ok: true }>['traversed'][number][] = [];
  for (const relationship of route.relationships) {
    input.signal?.throwIfAborted();
    const current = await input.readCurrent();
    if ((initial.childMachines?.length ?? 0) !== (current.childMachines?.length ?? 0)
      || initial.childMachines?.some(accepted => {
        const now = current.childMachines?.find(fact => fact.serverId === accepted.serverId && fact.machineId === accepted.machineId);
        return !now || now.installationId !== accepted.installationId
          || !managedDevcontainerChildProjectionsEqualV1(now.projection, accepted.projection);
      })) {
      return { ok: false, errorCode: 'workspace_sync_child_unavailable', completed, blockedRelationshipId: relationship.relationshipId };
    }
    const currentRoute = resolveWorkspaceSyncTransferRoute({
      ...current,
      serverId: input.serverId,
      sourceWorkspaceRefId: input.sourceWorkspaceRefId,
      targetWorkspaceRefId: input.targetWorkspaceRefId,
    });
    if (!currentRoute.ok && currentRoute.code === 'workspace_sync_child_unavailable') {
      return { ok: false, errorCode: currentRoute.code, completed, blockedRelationshipId: relationship.relationshipId };
    }
    const currentRelationship = currentRoute.ok && currentRoute.kind !== 'same_workspace'
      ? currentRoute.relationships.find((candidate) => candidate.relationshipId === relationship.relationshipId)
      : undefined;
    if (!currentRelationship || !areWorkspaceSyncRelationshipDefinitionsEqual(currentRelationship, relationship)) {
      return {
        ok: false,
        errorCode: 'relationship_changed',
        completed,
        blockedRelationshipId: relationship.relationshipId,
      };
    }
    try {
      const status = await input.flush(relationship.relationshipId, input.signal);
      assertWorkspaceSyncStatusClean(status);
      completed.push({
        relationshipId: relationship.relationshipId,
        policyDigest: relationship.contentPolicy.policyDigest,
        status,
      });
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'status' in error
        ? error.status as WorkspaceSyncStatusV1
        : undefined;
      return {
        ok: false,
        errorCode: errorCode(error, 'workspace_sync_prepare_failed'),
        completed,
        blockedRelationshipId: relationship.relationshipId,
        ...(status ? { blockedStatus: status } : {}),
      };
    }
  }
  return { ok: true, traversed: completed };
}
