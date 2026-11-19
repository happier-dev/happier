import { areWorkspaceSyncWorkerCopyProvenancesEqual,
  getWorkspaceSyncWorkerCopyV1, WorkspaceSyncStatusV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { deriveWorkspaceSyncTopology, resolveWorkspaceSyncEndpoint, resolveWorkspaceSyncTransferRoute,
  type WorkspaceSyncChildMachineFacts } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { projectWorkspaceRefV1, resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { WorkspaceRefV1, WorkspaceSyncPrepareBetweenResultV1, WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol';
import type { WorkspaceSyncFlushExpectation, WorkspaceSyncStatusV1 } from './workspaceSyncTypes';
import type { StoredCredentials } from '@/persistence';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readProjectAccountRows, type ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { readWorkspaceSyncRootObjectIdentity } from './workspaceSyncRootIdentity';
import { readWorkspaceSyncChildMachineFacts } from './workspaceSyncTargetAuthority';
import { managedDevcontainerChildProjectionsEqualV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { readWebLatencyTracePoint, timeWebLatencyPhase, withWebLatencyTrace } from '@/daemon/externalActions/webLatencyTrace';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';

export type WorkspaceSyncWorkerTargetBasis = Readonly<{
  source: WorkspaceRefV1;
  target: WorkspaceRefV1;
  workspaceRefs: readonly WorkspaceRefV1[];
  relationships: readonly WorkspaceSyncRelationshipV1[];
  childMachines?: readonly WorkspaceSyncChildMachineFacts[];
}>;

/** Graph observations also serve exact routes already selected before approval. */
export async function readWorkspaceSyncWorkerRouteSnapshot(input: Readonly<{
  serverId: string;
  serverHttpBaseUrl: string;
  targetMachineId: string;
  sourceWorkspaceRefId: string;
  credentials: StoredCredentials;
  authorization?: ExternalActionExecutionAuthorizationV1;
  signal?: AbortSignal;
}>): Promise<ActiveProjectAccountRowsSnapshot & Readonly<{
  childMachines: readonly WorkspaceSyncChildMachineFacts[];
}>> {
  return await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, async () => {
    const snapshot = await readProjectAccountRows({ serverId: input.serverId, signal: input.signal,
      selection: { kinds: ['workspace-ref', 'relationship-graph'] },
      ...(input.authorization ? { authorization: input.authorization, effectActionId: input.authorization.binding.actionId }
        : { credentials: input.credentials }) });
    const childMachines = await readWorkspaceSyncChildMachineFacts({ ...input,
      relationshipId: input.authorization?.binding.workspaceSyncAdmission?.relationshipId,
      machineIds: snapshot.workspaceRefs.filter(ref => ref.serverId === input.serverId
        && (ref.id === input.sourceWorkspaceRefId || ref.machineId === input.targetMachineId)).map(ref => ref.machineId) });
    return { ...snapshot, childMachines };
  });
}

/** Every new target selection observes native usability, regardless of its entry. */
export async function readWorkspaceSyncWorkerTargetSnapshot(input: Parameters<typeof readWorkspaceSyncWorkerRouteSnapshot>[0] & Readonly<{
  readRelationshipStatuses?: (controllerMachineId: string) => Promise<readonly WorkspaceSyncStatusV1[]>;
}>): Promise<Awaited<ReturnType<typeof readWorkspaceSyncWorkerRouteSnapshot>> & Readonly<{
  relationshipStatuses: readonly WorkspaceSyncStatusV1[];
}>> {
  const snapshot = await readWorkspaceSyncWorkerRouteSnapshot(input);
  const source = resolveWorkspaceRefV1(snapshot.workspaceRefs, { serverId: input.serverId, id: input.sourceWorkspaceRefId });
  const endpoint = source.kind === 'resolved'
    ? resolveWorkspaceSyncEndpoint({ ...snapshot, workspace: source.ref }) : null;
  const component = endpoint?.ok ? deriveWorkspaceSyncTopology({ ...snapshot, serverId: input.serverId }).sets.find(set =>
    set.relationships.some(relationship => relationship.alphaWorkspaceRefId === endpoint.endpoint.id
      || relationship.betaWorkspaceRefId === endpoint.endpoint.id)) : undefined;
  const controller = source.kind === 'resolved' && source.ref.machineId !== input.targetMachineId
    ? component?.controllerMachineId : undefined;
  if (!controller) return { ...snapshot, relationshipStatuses: [] };
  const readStatuses = input.readRelationshipStatuses ?? (async (machineId: string) => {
    const { callMachineRpc } = await import('@/session/transport/rpc/machineRpc');
    const response = readMachineActionRpcResult(await callMachineRpc({ credentials: input.credentials, serverUrl: input.serverHttpBaseUrl,
      machineId, method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST, request: {}, signal: input.signal }));
    return typeof response === 'object' && response !== null && 'statuses' in response && Array.isArray(response.statuses)
      ? response.statuses : [];
  });
  const relationshipStatuses = (await readStatuses(controller)).flatMap(value => {
    const parsed = WorkspaceSyncStatusV1Schema.safeParse(value);
    return parsed.success && parsed.data.controllerMachineId === controller ? [parsed.data] : [];
  });
  return { ...snapshot, relationshipStatuses };
}

/** Installed finite and service consumers share the same exact route and clean preparation. */
export function createWorkspaceSyncWorkerPreparation(input: Readonly<{
  serverId: string;
  serverHttpBaseUrl: string;
  targetMachineId: string;
  credentials: StoredCredentials;
  authorization?: ExternalActionExecutionAuthorizationV1;
  prepareBetween(request: Readonly<{ sourceWorkspaceRefId: string; targetWorkspaceRefId: string }>, signal: AbortSignal): Promise<WorkspaceSyncPrepareBetweenResultV1>;
}>) {
  const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
  const readCurrent = async (signal: AbortSignal, source: WorkspaceRefV1) => {
    if (!await isServerProfileHomeIdentity(input.serverId, source.serverId)) fail('target_mismatch');
    return await readWorkspaceSyncWorkerTargetSnapshot({ ...input, serverId: source.serverId,
      signal, sourceWorkspaceRefId: source.id });
  };
  return {
    resolveWorkerTarget: async ({ source, signal }: Readonly<{ source: WorkspaceRefV1; signal: AbortSignal }>): Promise<WorkspaceSyncWorkerTargetBasis> => {
      signal.throwIfAborted();
      const snapshot = await readCurrent(signal, source);
      const basis = resolveWorkspaceSyncWorkerTarget({ serverId: source.serverId,
        sourceWorkspaceRefId: source.id, targetMachineId: input.targetMachineId,
        workspaceRefs: snapshot.workspaceRefs, relationships: snapshot.relationships, childMachines: snapshot.childMachines,
        relationshipStatuses: snapshot.relationshipStatuses });
      if (!basis.ok) return fail(basis.errorCode);
      if (basis.source.machineId !== source.machineId || basis.source.rootPath !== source.rootPath
        || basis.source.projectKey !== source.projectKey
        || projectWorkspaceRefV1(basis.target).projectKey !== projectWorkspaceRefV1(source).projectKey) fail('project_workspace_changed');
      await readWorkspaceSyncRootObjectIdentity(basis.target.rootPath);
      return basis;
    },
    prepareDequeue: async ({ choice, basis, signal }: Readonly<{
      workspace: WorkspaceRefV1; choice: ProjectExecutionChoiceV1; basis?: WorkspaceSyncWorkerTargetBasis; signal: AbortSignal;
    }>): Promise<Extract<WorkspaceSyncPrepareBetweenResultV1, { ok: true }> | void> => withWebLatencyTrace(
      readWebLatencyTracePoint()?.requestId ?? input.authorization?.binding.requestId,
      () => timeWebLatencyPhase('workspaceSync.worker.prepareDequeue', async () => {
        signal.throwIfAborted();
        if (choice.kind !== 'workers') return;
        if (!basis) return fail('workspace_sync_source_unavailable');
        assertWorkspaceSyncWorkerTargetCurrent(basis, { ...await readCurrent(signal, basis.source), serverId: basis.source.serverId });
        await readWorkspaceSyncRootObjectIdentity(basis.target.rootPath);
        const prepared = await input.prepareBetween({ sourceWorkspaceRefId: basis.source.id, targetWorkspaceRefId: basis.target.id }, signal);
        if (!prepared.ok) return fail(prepared.errorCode);
        signal.throwIfAborted();
        return prepared;
      })),
  };
}

/** Exact-Machine resolution within Sync's supported component, without effects or alternate selection. */
export function resolveWorkspaceSyncWorkerTarget(input: Readonly<{
  serverId: string;
  sourceWorkspaceRefId: string;
  targetMachineId: string;
  /** An exact workspace already chosen by the parent's admitted child plan. */
  targetWorkspaceRefId?: string;
  workspaceRefs: readonly WorkspaceRefV1[];
  relationships: readonly WorkspaceSyncRelationshipV1[];
  childMachines?: readonly WorkspaceSyncChildMachineFacts[];
  relationshipStatuses: readonly WorkspaceSyncStatusV1[];
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
  if (!component) return { ok: false, errorCode: 'worker_copy_missing' };
  const statuses = new Map(input.relationshipStatuses.map(status => [status.relationshipId, status]));
  const targets = input.workspaceRefs.filter(ref => ref.serverId === input.serverId
    && (input.targetWorkspaceRefId === undefined || ref.id === input.targetWorkspaceRefId)
    && ref.machineId === input.targetMachineId && (() => {
      const resolved = resolveWorkspaceSyncEndpoint({ ...input, workspace: ref });
      if (!resolved.ok || !component.relationships.some(relationship =>
        relationship.enabled && getWorkspaceSyncWorkerCopyV1(relationship)?.targetWorkspaceRefId === resolved.endpoint.id)) return false;
      // The parent already admitted this exact copy; replay consumes its route.
      if (input.targetWorkspaceRefId !== undefined) return true;
      const route = resolveWorkspaceSyncTransferRoute({ ...input, targetWorkspaceRefId: ref.id });
      if (!route.ok) return route.code !== 'relationship_paused';
      return route.relationships.every(relationship => {
        const status = statuses.get(relationship.relationshipId);
        return status?.controllerMachineId === relationship.controllerMachineId
          && (status.state === 'starting' || status.state === 'watching' || status.state === 'flushing');
      });
    })());
  if (targets.length !== 1) return { ok: false,
    errorCode: targets.length ? 'workspace_sync_target_ambiguous' : 'worker_copy_missing' };
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
        || relationship.betaWorkspaceRefId !== accepted.betaWorkspaceRefId
        || !areWorkspaceSyncWorkerCopyProvenancesEqual(relationship, accepted);
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
  return readRpcErrorCode(error) ?? (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : fallback);
}

type WorkspaceSyncPreparationSnapshot = Readonly<{
  workspaceRefs: readonly WorkspaceRefV1[];
  relationships: readonly WorkspaceSyncRelationshipV1[];
  childMachines?: readonly WorkspaceSyncChildMachineFacts[];
}>;

/** Ordered, ephemeral pair/star barrier. Execute the admitted route and endpoints;
 * withdrawals apply to the next admission, while local cancellation stops this one. */
export async function prepareWorkspaceSyncBetween(input: Readonly<{
  serverId?: string;
  sourceWorkspaceRefId: string;
  targetWorkspaceRefId: string;
  /** A controller may supply the observation it just admitted, before any effect. */
  initial?: WorkspaceSyncPreparationSnapshot;
  readCurrent(): Promise<WorkspaceSyncPreparationSnapshot>;
  flush(relationshipId: string, signal: AbortSignal | undefined, admitted: WorkspaceSyncFlushExpectation): Promise<WorkspaceSyncStatusV1>;
  signal?: AbortSignal;
}>): Promise<WorkspaceSyncPrepareBetweenResultV1> {
  const initial = input.initial ?? await input.readCurrent();
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
    try {
      const status = await input.flush(relationship.relationshipId, input.signal, {
        relationship,
        workspaceRefs: initial.workspaceRefs.filter(ref => ref.id === relationship.alphaWorkspaceRefId || ref.id === relationship.betaWorkspaceRefId),
      });
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
