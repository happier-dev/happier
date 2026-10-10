import { deriveWorkspaceSyncTopology, resolveWorkspaceSyncTransferRoute } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { WorkspaceSyncRelationshipV1Schema, type WorkspaceSyncRelationshipV1, type WorkspaceSyncStatusV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import {
    normalizeWorkspaceScopeBase,
    type WorkspaceScopeBase,
} from '@/sync/domains/workspaces/workspaceScope';
import { resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';
import { resolveWorkspaceRefById, workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';

export type WorkspaceSyncRelationshipModel = Readonly<{
    all: readonly WorkspaceSyncRelationshipV1[];
    enabled: readonly WorkspaceSyncRelationshipV1[];
    byId: ReadonlyMap<string, WorkspaceSyncRelationshipV1>;
    invalidCount: number;
}>;

export type WorkspaceSyncRelationshipEndpoint = Readonly<{
    workspaceRefId: string;
    workspaceRef: WorkspaceRefV1 | null;
    label: string;
    machineName: string | null;
}>;

export type WorkspaceSyncRelationshipSummary = Readonly<{
    serverId?: string;
    relationshipId: string;
    relationship: WorkspaceSyncRelationshipV1;
    alpha: WorkspaceSyncRelationshipEndpoint;
    beta: WorkspaceSyncRelationshipEndpoint;
    status: WorkspaceSyncStatusV1 | null;
}>;

export type WorkspaceSyncLinkedHandoffChoice = Readonly<{
    sourceWorkspaceRefId: string;
    targetWorkspaceRefId: string;
    hubMachineName: string;
    routeLabel: string;
    relationshipIds: readonly string[];
}>;

const EMPTY_RELATIONSHIPS: readonly unknown[] = [];

function workspaceRefsForSummaries(summaries: readonly WorkspaceSyncRelationshipSummary[]): WorkspaceRefV1[] {
    // Repeated observations reuse the resolved ref; different candidates must never be collapsed by id.
    return [...new Set(summaries.flatMap(summary => [summary.alpha.workspaceRef, summary.beta.workspaceRef])
        .filter((ref): ref is WorkspaceRefV1 => ref !== null))];
}

function containingHomeForSummaries(summaries: readonly WorkspaceSyncRelationshipSummary[]): string | undefined {
    const serverId = summaries[0]?.serverId;
    return serverId && summaries.every(summary => summary.serverId === serverId) ? serverId : undefined;
}

/**
 * Single fail-closed projection for persisted relationship definitions.
 * Runtime status remains daemon-owned and must not be inferred here.
 */
export function projectWorkspaceSyncRelationships(raw: unknown): WorkspaceSyncRelationshipModel {
    const entries = Array.isArray(raw) ? raw : EMPTY_RELATIONSHIPS;
    const byId = new Map<string, WorkspaceSyncRelationshipV1>();
    const all: WorkspaceSyncRelationshipV1[] = [];
    let invalidCount = 0;

    for (const entry of entries) {
        const parsed = WorkspaceSyncRelationshipV1Schema.safeParse(entry);
        if (!parsed.success) {
            invalidCount += 1;
            continue;
        }
        all.push(parsed.data);
        byId.set(parsed.data.relationshipId, parsed.data);
    }

    return {
        all,
        enabled: all.filter((relationship) => relationship.enabled),
        byId,
        invalidCount,
    };
}

function endpointFor(
    workspaceRefId: string,
    workspaceRefs: readonly WorkspaceRefV1[],
    machineNamesById: Readonly<Record<string, string>>,
    serverId?: string,
): WorkspaceSyncRelationshipEndpoint {
    const resolution = resolveWorkspaceRefById(workspaceRefs, workspaceRefId, serverId);
    const workspaceRef = resolution.kind === 'resolved' ? resolution.ref : null;
    const machineId = workspaceRef?.machineId ?? '';
    const machineName = machineId ? machineNamesById[machineId]?.trim() || null : null;
    return {
        workspaceRefId,
        workspaceRef,
        label: workspaceRef?.label?.trim() || workspaceRef?.rootPath || workspaceRefId,
        machineName,
    };
}

/**
 * Canonical UI projection for endpoint identity and daemon-owned status. Repeated
 * status observations are collapsed by relationship instead of becoming rows.
 */
export function projectWorkspaceSyncRelationshipSummaries(input: Readonly<{
    relationships: WorkspaceSyncRelationshipModel;
    workspaceRefs: readonly WorkspaceRefV1[];
    statuses: readonly WorkspaceSyncStatusV1[];
    machineNamesById?: Readonly<Record<string, string>>;
    serverId?: string;
}>): readonly WorkspaceSyncRelationshipSummary[] {
    const statusesByRelationshipId = new Map(
        input.statuses.map((status) => [status.relationshipId, status]),
    );

    return input.relationships.all.map((relationship) => ({
        ...(input.serverId ? { serverId: input.serverId } : {}),
        relationshipId: relationship.relationshipId,
        relationship,
        alpha: endpointFor(relationship.alphaWorkspaceRefId, input.workspaceRefs, input.machineNamesById ?? {}, input.serverId),
        beta: endpointFor(relationship.betaWorkspaceRefId, input.workspaceRefs, input.machineNamesById ?? {}, input.serverId),
        status: statusesByRelationshipId.get(relationship.relationshipId) ?? null,
    }));
}

function endpointMatchesScope(
    endpoint: WorkspaceSyncRelationshipEndpoint,
    scope: WorkspaceScopeBase,
    options?: Readonly<{ allowScopeDescendantOfEndpointRoot?: boolean }>,
): boolean {
    const endpointScope = endpoint.workspaceRef
        ? normalizeWorkspaceScopeBase(endpoint.workspaceRef)
        : null;
    return endpointScope !== null
        && endpointScope.serverId === scope.serverId
        && endpointScope.machineId === scope.machineId
        && (
            options?.allowScopeDescendantOfEndpointRoot
                ? resolvePathRelativeToRoot({ path: scope.rootPath, root: endpointScope.rootPath }) !== null
                : endpointScope.rootPath === scope.rootPath
        );
}

/**
 * Existing handoff choices must match both concrete endpoints. A Git worktree
 * source session may run below its WorkspaceRef root; all-files sources and the
 * requested target root remain exact. One-way modes preserve their alpha-to-beta
 * direction; only the bidirectional mode can be selected with source and target reversed.
 */
export function selectWorkspaceSyncRelationshipSummariesForHandoff(
    summaries: readonly WorkspaceSyncRelationshipSummary[],
    scopes: Readonly<{ source: WorkspaceScopeBase; target: WorkspaceScopeBase }>,
): readonly WorkspaceSyncRelationshipSummary[] {
    const source = normalizeWorkspaceScopeBase(scopes.source);
    const target = normalizeWorkspaceScopeBase(scopes.target);
    if (!source || !target) return [];

    return summaries.filter((summary) => {
        if (!summary.relationship.enabled) return false;
        if (!summary.alpha.workspaceRef || !summary.beta.workspaceRef) return false;
        const allowSourceDescendant = summary.relationship.contentPolicy.selection === 'git_worktree';

        const forward = endpointMatchesScope(summary.alpha, source, { allowScopeDescendantOfEndpointRoot: allowSourceDescendant })
            && endpointMatchesScope(summary.beta, target);
        if (forward) return true;

        return summary.relationship.mode === 'keep_both_in_sync'
            && endpointMatchesScope(summary.beta, source, { allowScopeDescendantOfEndpointRoot: allowSourceDescendant })
            && endpointMatchesScope(summary.alpha, target);
    });
}

/** Uses the Protocol topology owner for the linked route; this UI projection
 * only maps the selected Machine/path scopes to exact current WorkspaceRefs. */
export function selectWorkspaceSyncLinkedHandoffChoice(
    summaries: readonly WorkspaceSyncRelationshipSummary[],
    scopes: Readonly<{ source: WorkspaceScopeBase; target: WorkspaceScopeBase }>,
): WorkspaceSyncLinkedHandoffChoice | null {
    const source = normalizeWorkspaceScopeBase(scopes.source);
    const target = normalizeWorkspaceScopeBase(scopes.target);
    if (!source || !target || source.serverId !== target.serverId) return null;
    const endpoints = [...new Map(summaries.flatMap((summary) => [summary.alpha, summary.beta])
        .filter((endpoint) => endpoint.workspaceRef !== null
            && normalizeWorkspaceScopeBase(endpoint.workspaceRef)?.serverId === source.serverId)
        .map((endpoint) => [endpoint.workspaceRefId, endpoint] as const)).values()];
    const sourceEndpoints = endpoints.filter((endpoint) => endpointMatchesScope(endpoint, source, { allowScopeDescendantOfEndpointRoot: true }));
    const targetEndpoints = endpoints.filter((endpoint) => endpointMatchesScope(endpoint, target));
    const relationships = [...new Map(summaries.map((summary) => [summary.relationshipId, summary.relationship] as const)).values()];
    const workspaceRefs = endpoints.flatMap((endpoint) => endpoint.workspaceRef ? [endpoint.workspaceRef] : []);
    const choices = sourceEndpoints.flatMap((sourceEndpoint) => targetEndpoints.flatMap((targetEndpoint) => {
        const route = resolveWorkspaceSyncTransferRoute({
            context: workspaceRefResolutionContextV1,
            serverId: source.serverId,
            workspaceRefs,
            relationships,
            sourceWorkspaceRefId: sourceEndpoint.workspaceRefId,
            targetWorkspaceRefId: targetEndpoint.workspaceRefId,
        });
        if (!route.ok || route.kind !== 'via_hub') return [];
        const hub = endpoints.find((endpoint) => endpoint.workspaceRefId === route.hubWorkspaceRefId);
        return [{
            sourceWorkspaceRefId: sourceEndpoint.workspaceRefId,
            targetWorkspaceRefId: targetEndpoint.workspaceRefId,
            hubMachineName: hub?.machineName ?? hub?.label ?? route.controllerMachineId,
            routeLabel: [sourceEndpoint.label, hub?.label ?? route.hubWorkspaceRefId, targetEndpoint.label].join(' → '),
            relationshipIds: route.relationships.map(({ relationshipId }) => relationshipId),
        }];
    }));
    return choices.length === 1 ? choices[0]! : null;
}

export type WorkspaceSyncSetAttention = Readonly<{
    conflictedLinkCount: number;
    unknownLinkCount: number;
}>;

const EMPTY_SET_ATTENTION: WorkspaceSyncSetAttention = Object.freeze({ conflictedLinkCount: 0, unknownLinkCount: 0 });

function projectWorkspaceSyncLinkAttention(summary: WorkspaceSyncRelationshipSummary): WorkspaceSyncSetAttention {
    if (!summary.relationship.enabled) return EMPTY_SET_ATTENTION;
    const status = summary.status;
    return {
        conflictedLinkCount: status && (status.conflictCount > 0 || status.state === 'conflicted') ? 1 : 0,
        unknownLinkCount: !status || status.state === 'controller_unavailable'
            || status.state === 'disconnected' || status.state === 'error' || status.state === 'stopped'
            || status.endpointStates.alpha === null || status.endpointStates.beta === null ? 1 : 0,
    };
}

/** One Protocol topology projection feeds all closed-row attention badges. */
export function projectWorkspaceSyncSetAttentionByWorkspaceRefId(
    summaries: readonly WorkspaceSyncRelationshipSummary[],
): ReadonlyMap<string, WorkspaceSyncSetAttention> {
    const summariesById = new Map(summaries.map((summary) => [summary.relationshipId, summary] as const));
    const topology = deriveWorkspaceSyncTopology({
        context: workspaceRefResolutionContextV1,
        workspaceRefs: workspaceRefsForSummaries(summaries),
        serverId: containingHomeForSummaries(summaries),
        relationships: summaries.map((summary) => summary.relationship),
    });
    const result = new Map<string, WorkspaceSyncSetAttention>();
    for (const set of topology.sets) {
        let conflictedLinkCount = 0;
        let unknownLinkCount = 0;
        for (const relationship of set.relationships) {
            const summary = summariesById.get(relationship.relationshipId);
            if (!summary) continue;
            const attention = projectWorkspaceSyncLinkAttention(summary);
            conflictedLinkCount += attention.conflictedLinkCount;
            unknownLinkCount += attention.unknownLinkCount;
        }
        const attention = { conflictedLinkCount, unknownLinkCount };
        for (const relationship of set.relationships) {
            result.set(relationship.alphaWorkspaceRefId, attention);
            result.set(relationship.betaWorkspaceRefId, attention);
        }
    }
    return result;
}

/** The Protocol topology owner decides which saved links share this WorkspaceRef. */
export function resolveWorkspaceSyncSetSummaries(
    summaries: readonly WorkspaceSyncRelationshipSummary[],
    workspaceRefId: string,
): readonly WorkspaceSyncRelationshipSummary[] {
    const topology = deriveWorkspaceSyncTopology({
        context: workspaceRefResolutionContextV1,
        workspaceRefs: workspaceRefsForSummaries(summaries),
        serverId: containingHomeForSummaries(summaries),
        relationships: summaries.map((summary) => summary.relationship),
    });
    const set = topology.sets.find((candidate) => candidate.hubWorkspaceRefId === workspaceRefId
        || candidate.relationships.some((relationship) => relationship.alphaWorkspaceRefId === workspaceRefId
            || relationship.betaWorkspaceRefId === workspaceRefId));
    if (!set) return [];
    const relationshipIds = new Set(set.relationships.map((relationship) => relationship.relationshipId));
    return summaries.filter((summary) => relationshipIds.has(summary.relationshipId));
}

/** Select the source shown by Add machine from the current link set. */
export function selectWorkspaceSyncAddMachineHub(
    summaries: readonly WorkspaceSyncRelationshipSummary[],
    workspaceRefId: string,
): WorkspaceRefV1 | null {
    const refs = workspaceRefsForSummaries(summaries);
    const serverId = containingHomeForSummaries(summaries);
    const set = deriveWorkspaceSyncTopology({
        context: workspaceRefResolutionContextV1,
        workspaceRefs: refs,
        serverId,
        relationships: summaries.map((summary) => summary.relationship),
    }).sets.find((candidate) => candidate.relationships.some((relationship) => (
        relationship.alphaWorkspaceRefId === workspaceRefId || relationship.betaWorkspaceRefId === workspaceRefId
    )));
    if (!set) return null;
    const resolution = resolveWorkspaceRefById(refs, set.hubWorkspaceRefId, serverId);
    return resolution.kind === 'resolved' ? resolution.ref : null;
}

export function resolveWorkspaceSyncSetAttention(
    summaries: readonly WorkspaceSyncRelationshipSummary[],
    workspaceRefId: string,
): WorkspaceSyncSetAttention {
    return projectWorkspaceSyncSetAttentionByWorkspaceRefId(summaries).get(workspaceRefId) ?? EMPTY_SET_ATTENTION;
}
