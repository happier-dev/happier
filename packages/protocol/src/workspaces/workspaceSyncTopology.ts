import type { WorkspaceSyncRelationshipV1 } from '../sessions/control/handoff/workspaceSyncSchemas.js';
import type { WorkspaceRefV1 } from './workspaceRefV1.js';
import { normalizeWorkspaceRootPathV1, resolveWorkspaceRefV1, type WorkspaceRefResolutionContextV1 } from './workspaceRefResolutionV1.js';
import { isManagedDevcontainerChildProjectionCurrentV1,
  type DevcontainerChildProjectionV1 } from '../machines/managed/devcontainerV1.js';
import type { ManagedMachineV1 } from '../machines/managed/managedMachineV1.js';

/** Current reads of the existing managed row and ordinary Machine projection, never stored mapping state. */
export type WorkspaceSyncChildMachineFacts = Readonly<{
  serverId: string;
  machineId: string;
  installationId: string;
  projection: DevcontainerChildProjectionV1;
  managedMachine: ManagedMachineV1;
  controller: Readonly<{ machineId: string; installationId: string; available: boolean }>;
}>;

type WorkspaceSyncEndpointContext = Readonly<{
  workspaceRefs: readonly WorkspaceRefV1[];
  childMachines?: readonly WorkspaceSyncChildMachineFacts[];
  context?: WorkspaceRefResolutionContextV1;
  /** Pre-purpose addressing only; effect owners still require physical_sync. */
  purpose?: 'physical_sync' | 'admitted_mapping';
}>;
type WorkspaceSyncEndpointUnavailable = Readonly<{ ok: false; code: 'workspace_sync_child_unavailable' }>;
type WorkspaceSyncNamespace = Pick<WorkspaceRefV1, 'serverId' | 'machineId' | 'rootPath' | 'projectKey'>;

/** One current retained bind decision, shared by transport addressing and physical-ref resolution. */
function readCurrentWorkspaceSyncChild(input: Readonly<{
  namespace: WorkspaceSyncNamespace;
  workspace?: WorkspaceRefV1;
  childMachines?: readonly WorkspaceSyncChildMachineFacts[];
  context?: WorkspaceRefResolutionContextV1;
}>): Readonly<{ ok: true; fact?: WorkspaceSyncChildMachineFacts }> | WorkspaceSyncEndpointUnavailable {
  const workspace = input.namespace;
  const unavailable = { ok: false as const, code: 'workspace_sync_child_unavailable' as const };
  const facts = input.childMachines?.filter(fact => fact.serverId === workspace.serverId && fact.machineId === workspace.machineId) ?? [];
  if (facts.length === 0) return { ok: true };
  if (facts.length !== 1) return unavailable;
  const fact = facts[0]!;
  const { observation } = fact.projection;
  const row = fact.managedMachine;
  const normalizeRoot = input.context?.normalizeRootPath ?? normalizeWorkspaceRootPathV1;
  const actualRoot = normalizeRoot(workspace.rootPath, input.workspace);
  const nativeRoot = normalizeRoot(observation.workspaceFolder);
  if (!fact.installationId || !isManagedDevcontainerChildProjectionCurrentV1({ homeId: workspace.serverId,
      machineId: workspace.machineId, managedMachine: row, projection: fact.projection })
    || !actualRoot || !nativeRoot || !(input.context?.rootsEqual
      ? input.context.rootsEqual(actualRoot, nativeRoot) : actualRoot === nativeRoot)) return unavailable;
  if (observation.storage.kind === 'bind' && (fact.controller.machineId !== row.controller.machineId
    || fact.controller.installationId !== row.controller.installationId)) return unavailable;
  return { ok: true, fact };
}

/** Admitted addressing selects an installed RPC recipient, never a WorkspaceRef or filesystem authority. */
export function resolveWorkspaceSyncTransportAddress(input: Readonly<{
  namespace: WorkspaceSyncNamespace;
  childMachines?: readonly WorkspaceSyncChildMachineFacts[];
  context?: WorkspaceRefResolutionContextV1;
}>): Readonly<{ ok: true; address: Readonly<{ machineId: string; installationId?: string }> }> | WorkspaceSyncEndpointUnavailable {
  const current = readCurrentWorkspaceSyncChild(input);
  if (!current.ok) return current;
  const fact = current.fact;
  return { ok: true, address: fact?.projection.observation.storage.kind === 'bind'
    ? { machineId: fact.controller.machineId, installationId: fact.controller.installationId }
    : { machineId: input.namespace.machineId, ...(fact ? { installationId: fact.installationId } : {}) } };
}

/** Copy/flush custody follows native bind storage; every execution consumer keeps workspace itself. */
export function resolveWorkspaceSyncEndpoint(input: WorkspaceSyncEndpointContext & Readonly<{ workspace: WorkspaceRefV1 }>):
  Readonly<{ ok: true; workspace: WorkspaceRefV1; endpoint: WorkspaceRefV1 }> | WorkspaceSyncEndpointUnavailable;
/** Admitted native namespaces need no logical row in the physical writer's Account graph. */
export function resolveWorkspaceSyncEndpoint(input: WorkspaceSyncEndpointContext & Readonly<{
  namespace: WorkspaceSyncNamespace;
}>): Readonly<{ ok: true; endpoint: WorkspaceRefV1 }> | WorkspaceSyncEndpointUnavailable;
export function resolveWorkspaceSyncEndpoint(input: WorkspaceSyncEndpointContext & (
  Readonly<{ workspace: WorkspaceRefV1 }> | Readonly<{ namespace: WorkspaceSyncNamespace }>
)): Readonly<{ ok: true; workspace?: WorkspaceRefV1; endpoint: WorkspaceRefV1 }> | WorkspaceSyncEndpointUnavailable {
  const workspace = 'workspace' in input ? input.workspace : input.namespace;
  const unavailable = { ok: false as const, code: 'workspace_sync_child_unavailable' as const };
  const unchanged = 'workspace' in input ? { ok: true as const, workspace: input.workspace, endpoint: input.workspace } : unavailable;
  const current = readCurrentWorkspaceSyncChild({ namespace: workspace, childMachines: input.childMachines, context: input.context,
    ...('workspace' in input ? { workspace: input.workspace } : {}) });
  if (!current.ok) return current;
  const fact = current.fact;
  if (!fact) return unchanged;
  const { observation } = fact.projection;
  const row = fact.managedMachine;
  if (observation.storage.kind === 'child') return unchanged;
  if (input.purpose !== 'admitted_mapping' && !fact.controller.available) return unavailable;
  const parent = resolveWorkspaceRefV1(input.workspaceRefs, { serverId: workspace.serverId,
    machineId: row.controller.machineId, rootPath: observation.storage.hostPath }, input.context);
  if (parent.kind !== 'resolved' || ('workspace' in input && parent.ref.id === input.workspace.id)
    || (parent.ref.projectKey && workspace.projectKey && parent.ref.projectKey !== workspace.projectKey)) return unavailable;
  return { ok: true, ...('workspace' in input ? { workspace: input.workspace } : {}), endpoint: parent.ref };
}

export type WorkspaceSyncEndpointRole = 'alpha' | 'beta';

export type WorkspaceSyncRelationshipEndpointRoles = Readonly<{
  sourceEndpointRole: WorkspaceSyncEndpointRole;
  targetEndpointRole: WorkspaceSyncEndpointRole;
}>;

export type WorkspaceSyncTransferDirection = Readonly<{
  sourceEndpointRole: WorkspaceSyncEndpointRole;
  targetEndpointRole: WorkspaceSyncEndpointRole;
}>;

export type DerivedWorkspaceSyncSet = Readonly<{
  hubWorkspaceRefId: string;
  controllerMachineId: string;
  relationships: readonly WorkspaceSyncRelationshipV1[];
}>;

export type WorkspaceSyncTopologyIssue = Readonly<{
  code: 'missing_workspace_ref' | 'ambiguous_workspace_ref' | 'invalid_workspace_ref' | 'invalid_controller' | 'duplicate_endpoint_pair' | 'unsupported_component';
  relationshipIds: readonly string[];
  workspaceRefIds: readonly string[];
}>;

export type WorkspaceSyncTopology = Readonly<{
  sets: readonly DerivedWorkspaceSyncSet[];
  issues: readonly WorkspaceSyncTopologyIssue[];
}>;

export type WorkspaceSyncTransferRoute =
  | Readonly<{ ok: true; kind: 'same_workspace'; relationships: readonly [] }>
  | Readonly<{
      ok: true;
      kind: 'direct' | 'via_hub';
      hubWorkspaceRefId: string;
      controllerMachineId: string;
      relationships: readonly WorkspaceSyncRelationshipV1[];
    }>
  | Readonly<{
      ok: false;
      code: 'workspace_ref_not_ready' | 'route_not_found' | 'topology_invalid' | 'workspace_sync_child_unavailable';
      workspaceRefId?: string;
    }>
  | Readonly<{
      ok: false;
      code: 'relationship_paused' | 'direction_mismatch';
      relationshipId: string;
    }>;

export function resolveWorkspaceSyncRelationshipEndpointRoles(input: Readonly<{
  mode: WorkspaceSyncRelationshipV1['mode'];
  controllerMachineId: string;
  alphaMachineId: string;
  betaMachineId: string;
}>): WorkspaceSyncRelationshipEndpointRoles | null {
  const controllerMachineId = input.controllerMachineId.trim();
  const alphaMachineId = input.alphaMachineId.trim();
  const betaMachineId = input.betaMachineId.trim();
  if (input.mode !== 'keep_both_in_sync') {
    return alphaMachineId === controllerMachineId
      ? { sourceEndpointRole: 'alpha', targetEndpointRole: 'beta' }
      : null;
  }
  // A same-Machine pair retains the established alpha-source convention.
  if (alphaMachineId === controllerMachineId) {
    return { sourceEndpointRole: 'alpha', targetEndpointRole: 'beta' };
  }
  if (betaMachineId === controllerMachineId) {
    return { sourceEndpointRole: 'beta', targetEndpointRole: 'alpha' };
  }
  return null;
}

export function resolveWorkspaceSyncRelationshipTransferDirection(input: Readonly<{
  relationship: WorkspaceSyncRelationshipV1;
  sourceWorkspaceRefId: string;
  targetWorkspaceRefId: string;
}>): WorkspaceSyncTransferDirection | null {
  const { relationship, sourceWorkspaceRefId, targetWorkspaceRefId } = input;
  if (sourceWorkspaceRefId === targetWorkspaceRefId) return null;
  const forward = sourceWorkspaceRefId === relationship.alphaWorkspaceRefId
    && targetWorkspaceRefId === relationship.betaWorkspaceRefId;
  if (forward) return { sourceEndpointRole: 'alpha', targetEndpointRole: 'beta' };
  const reverse = sourceWorkspaceRefId === relationship.betaWorkspaceRefId
    && targetWorkspaceRefId === relationship.alphaWorkspaceRefId;
  if (reverse && relationship.mode === 'keep_both_in_sync') {
    return { sourceEndpointRole: 'beta', targetEndpointRole: 'alpha' };
  }
  return null;
}

function componentRelationships(
  relationships: readonly WorkspaceSyncRelationshipV1[],
): readonly (readonly WorkspaceSyncRelationshipV1[])[] {
  const byRef = new Map<string, WorkspaceSyncRelationshipV1[]>();
  for (const relationship of relationships) {
    for (const refId of [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId]) {
      const entries = byRef.get(refId) ?? [];
      entries.push(relationship);
      byRef.set(refId, entries);
    }
  }
  const visited = new Set<string>();
  const components: WorkspaceSyncRelationshipV1[][] = [];
  for (const relationship of relationships) {
    if (visited.has(relationship.relationshipId)) continue;
    const component: WorkspaceSyncRelationshipV1[] = [];
    const pending = [relationship];
    visited.add(relationship.relationshipId);
    while (pending.length > 0) {
      const current = pending.shift()!;
      component.push(current);
      for (const refId of [current.alphaWorkspaceRefId, current.betaWorkspaceRefId]) {
        for (const adjacent of byRef.get(refId) ?? []) {
          if (visited.has(adjacent.relationshipId)) continue;
          visited.add(adjacent.relationshipId);
          pending.push(adjacent);
        }
      }
    }
    components.push(component);
  }
  return components;
}

export function deriveWorkspaceSyncTopology(input: Readonly<{
  serverId?: string;
  context?: WorkspaceRefResolutionContextV1;
  workspaceRefs: readonly WorkspaceRefV1[];
  relationships: readonly WorkspaceSyncRelationshipV1[];
}>): WorkspaceSyncTopology {
  const refs = new Map<string, WorkspaceRefV1>();
  const unresolvedRefs = new Map<string, 'missing' | 'ambiguous' | 'invalid'>();
  const endpointIds = new Set(input.relationships.flatMap((relationship) => [
    relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId,
  ]));
  for (const id of endpointIds) {
    const resolution = resolveWorkspaceRefV1(input.workspaceRefs, { id, serverId: input.serverId }, input.context);
    if (resolution.kind === 'resolved') refs.set(id, resolution.ref);
    else unresolvedRefs.set(id, resolution.kind);
  }
  const issues: WorkspaceSyncTopologyIssue[] = [];
  const sets: DerivedWorkspaceSyncSet[] = [];
  const seenPairs = new Map<string, WorkspaceSyncRelationshipV1>();

  for (const relationship of input.relationships) {
    const missing = [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId]
      .filter((refId) => !refs.has(refId));
    if (missing.length > 0) continue;
    const pair = [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId].sort().join('\u0000');
    const previous = seenPairs.get(pair);
    if (previous) {
      issues.push({
        code: 'duplicate_endpoint_pair',
        relationshipIds: [previous.relationshipId, relationship.relationshipId],
        workspaceRefIds: [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId],
      });
    } else {
      seenPairs.set(pair, relationship);
    }
  }

  for (const component of componentRelationships(input.relationships)) {
    const relationshipIds = component.map(({ relationshipId }) => relationshipId);
    const workspaceRefIds = [...new Set(component.flatMap((relationship) => [
      relationship.alphaWorkspaceRefId,
      relationship.betaWorkspaceRefId,
    ]))];
    for (const kind of ['missing', 'ambiguous', 'invalid'] as const) {
      const unresolvedWorkspaceRefIds = workspaceRefIds.filter((id) => unresolvedRefs.get(id) === kind);
      if (unresolvedWorkspaceRefIds.length > 0) {
        issues.push({
          code: `${kind}_workspace_ref`,
          relationshipIds,
          workspaceRefIds: unresolvedWorkspaceRefIds,
        });
      }
    }
    if (workspaceRefIds.some((id) => unresolvedRefs.has(id))) continue;
    const resolved = component.map((relationship) => {
      const alpha = refs.get(relationship.alphaWorkspaceRefId);
      const beta = refs.get(relationship.betaWorkspaceRefId);
      const roles = resolveWorkspaceSyncRelationshipEndpointRoles({
        mode: relationship.mode,
        controllerMachineId: relationship.controllerMachineId,
        alphaMachineId: alpha!.machineId,
        betaMachineId: beta!.machineId,
      });
      return { relationship, roles };
    });
    const invalidControllers = resolved.filter(({ roles }) => roles === null);
    for (const { relationship } of invalidControllers) {
      issues.push({
        code: 'invalid_controller',
        relationshipIds,
        workspaceRefIds: [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId],
      });
    }
    if (invalidControllers.length > 0) continue;

    const hubs = new Set(resolved.map(({ relationship, roles }) => (
      roles!.sourceEndpointRole === 'alpha'
        ? relationship.alphaWorkspaceRefId
        : relationship.betaWorkspaceRefId
    )));
    const controllers = new Set(component.map(({ controllerMachineId }) => controllerMachineId));
    if (hubs.size !== 1 || controllers.size !== 1) {
      issues.push({ code: 'unsupported_component', relationshipIds, workspaceRefIds });
      continue;
    }
    const hubWorkspaceRefId = [...hubs][0]!;
    const spokes = resolved.map(({ relationship, roles }) => (
      roles!.targetEndpointRole === 'alpha'
        ? relationship.alphaWorkspaceRefId
        : relationship.betaWorkspaceRefId
    ));
    if (new Set(spokes).size !== spokes.length || spokes.includes(hubWorkspaceRefId)) {
      issues.push({ code: 'unsupported_component', relationshipIds, workspaceRefIds });
      continue;
    }
    sets.push({
      hubWorkspaceRefId,
      controllerMachineId: [...controllers][0]!,
      relationships: component,
    });
  }

  return { sets, issues };
}

function relationshipContainsRef(relationship: WorkspaceSyncRelationshipV1, workspaceRefId: string): boolean {
  return relationship.alphaWorkspaceRefId === workspaceRefId
    || relationship.betaWorkspaceRefId === workspaceRefId;
}

/**
 * Derives the only supported transfer route from the current pair/star
 * definitions. It never searches for an alternate route after selecting a
 * component, rewrites endpoint ids, or relaxes one-way direction.
 */
export function resolveWorkspaceSyncTransferRoute(input: Readonly<{
  serverId?: string;
  context?: WorkspaceRefResolutionContextV1;
  workspaceRefs: readonly WorkspaceRefV1[];
  relationships: readonly WorkspaceSyncRelationshipV1[];
  sourceWorkspaceRefId: string;
  targetWorkspaceRefId: string;
  childMachines?: readonly WorkspaceSyncChildMachineFacts[];
}>): WorkspaceSyncTransferRoute {
  let sourceWorkspaceRefId = input.sourceWorkspaceRefId.trim();
  let targetWorkspaceRefId = input.targetWorkspaceRefId.trim();
  const source = resolveWorkspaceRefV1(input.workspaceRefs, { id: sourceWorkspaceRefId, serverId: input.serverId }, input.context);
  if (source.kind !== 'resolved') {
    return { ok: false, code: 'workspace_ref_not_ready', workspaceRefId: sourceWorkspaceRefId };
  }
  const target = resolveWorkspaceRefV1(input.workspaceRefs, { id: targetWorkspaceRefId, serverId: input.serverId }, input.context);
  if (target.kind !== 'resolved') {
    return { ok: false, code: 'workspace_ref_not_ready', workspaceRefId: targetWorkspaceRefId };
  }
  const sourceEndpoint = resolveWorkspaceSyncEndpoint({ ...input, workspace: source.ref });
  const targetEndpoint = resolveWorkspaceSyncEndpoint({ ...input, workspace: target.ref });
  if (!sourceEndpoint.ok) return sourceEndpoint;
  if (!targetEndpoint.ok) return targetEndpoint;
  sourceWorkspaceRefId = sourceEndpoint.endpoint.id;
  targetWorkspaceRefId = targetEndpoint.endpoint.id;
  if (sourceWorkspaceRefId === targetWorkspaceRefId) {
    return { ok: true, kind: 'same_workspace', relationships: [] };
  }

  const topology = deriveWorkspaceSyncTopology({
    serverId: input.serverId,
    context: input.context,
    workspaceRefs: input.workspaceRefs,
    relationships: input.relationships,
  });
  const issue = topology.issues.find((candidate) => (
    candidate.workspaceRefIds.includes(sourceWorkspaceRefId)
    || candidate.workspaceRefIds.includes(targetWorkspaceRefId)
    || candidate.relationshipIds.some((relationshipId) => {
      const relationship = input.relationships.find((entry) => entry.relationshipId === relationshipId);
      return relationship !== undefined
        && relationshipContainsRef(relationship, sourceWorkspaceRefId)
        && relationshipContainsRef(relationship, targetWorkspaceRefId);
    })
  ));
  if (issue) return { ok: false, code: 'topology_invalid' };

  const set = topology.sets.find((candidate) => {
    const memberIds = new Set(candidate.relationships.flatMap((relationship) => [
      relationship.alphaWorkspaceRefId,
      relationship.betaWorkspaceRefId,
    ]));
    return memberIds.has(sourceWorkspaceRefId) && memberIds.has(targetWorkspaceRefId);
  });
  if (!set) return { ok: false, code: 'route_not_found' };

  const direct = set.relationships.find((relationship) => (
    relationshipContainsRef(relationship, sourceWorkspaceRefId)
    && relationshipContainsRef(relationship, targetWorkspaceRefId)
  ));
  const relationships = direct
    ? [direct]
    : [
        set.relationships.find((relationship) => (
          relationshipContainsRef(relationship, sourceWorkspaceRefId)
          && relationshipContainsRef(relationship, set.hubWorkspaceRefId)
        )),
        set.relationships.find((relationship) => (
          relationshipContainsRef(relationship, set.hubWorkspaceRefId)
          && relationshipContainsRef(relationship, targetWorkspaceRefId)
        )),
      ];
  if (relationships.some((relationship) => relationship === undefined)) {
    return { ok: false, code: 'route_not_found' };
  }
  const ordered = relationships as readonly WorkspaceSyncRelationshipV1[];
  let from = sourceWorkspaceRefId;
  for (const relationship of ordered) {
    if (!relationship.enabled) {
      return { ok: false, code: 'relationship_paused', relationshipId: relationship.relationshipId };
    }
    const to = relationshipContainsRef(relationship, targetWorkspaceRefId)
      ? targetWorkspaceRefId
      : set.hubWorkspaceRefId;
    if (!resolveWorkspaceSyncRelationshipTransferDirection({
      relationship,
      sourceWorkspaceRefId: from,
      targetWorkspaceRefId: to,
    })) {
      return { ok: false, code: 'direction_mismatch', relationshipId: relationship.relationshipId };
    }
    from = to;
  }
  return {
    ok: true,
    kind: direct ? 'direct' : 'via_hub',
    hubWorkspaceRefId: set.hubWorkspaceRefId,
    controllerMachineId: set.controllerMachineId,
    relationships: ordered,
  };
}
