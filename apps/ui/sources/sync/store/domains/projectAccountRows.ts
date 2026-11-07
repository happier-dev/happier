import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createSessionProjectKeyResolverV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import type { WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { getWorkspaceSyncWorkerCopyV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { buildProjectAccountRowPhysicalKeyV1, type ProjectAccountOrganizationV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { StoreGet, StoreSet } from './_shared';
import { advanceWorkerCopyStatusRevisions } from '@/sync/domains/workspaces/workerCopyStatus';

import { readCurrentProjectAccountRows, type ProjectAccountRowsStatus, type ProjectAccountRowsSnapshot, type ProjectOrganizationRow, type ProjectAccountRowsMaterialization } from '@/sync/domains/workspaces/projectAccountRows';
export { readCurrentProjectAccountRows, type ProjectAccountRowsStatus, type ProjectAccountRowsSnapshot, type ProjectOrganizationRow, type ProjectAccountRowsMaterialization } from '@/sync/domains/workspaces/projectAccountRows';
export type ProjectAccountRowsDomain = {
    projectAccountRows: ProjectAccountRowsSnapshot | null;
    pinnedWorkspaceRefIds: readonly string[];
    activateProjectAccountRowsScope(scope: ServerAccountScope): void;
    applyProjectAccountRowsForScope(scope: ServerAccountScope, snapshot: ProjectAccountRowsSnapshot, source?: 'census' | 'projection', materialization?: ProjectAccountRowsMaterialization): void;
    setProjectAccountRowsStatusForScope(scope: ServerAccountScope, status: ProjectAccountRowsStatus): void;
    clearProjectAccountRowsScope(): void;
};
export const EMPTY_PINNED_WORKSPACE_REF_IDS: readonly string[] = Object.freeze([]);
export const EMPTY_WORKSPACE_REFS: readonly WorkspaceRefV1[] = Object.freeze([]);
export const EMPTY_WORKSPACE_RELATIONSHIPS: readonly WorkspaceSyncRelationshipV1[] = Object.freeze([]);
export const EMPTY_PROJECT_ORGANIZATIONS: readonly ProjectOrganizationRow[] = Object.freeze([]);

function reconcileRows<T>(previous: readonly T[], incoming: readonly T[], keyOf: (row: T) => string,
    previousRevisions: Readonly<Record<string, number>>, incomingRevisions: Readonly<Record<string, number>>, complete: boolean, absentKeys?: ReadonlySet<string>): readonly T[] {
    const previousByKey = new Map(previous.map(row => [keyOf(row), row]));
    const incomingByKey = new Map(incoming.map(row => [keyOf(row), row]));
    const acceptedByKey = new Map<string, T>();
    for (const [key, row] of incomingByKey) {
        const retained = previousByKey.get(key);
        if ((incomingRevisions[key] ?? -1) < (previousRevisions[key] ?? -1)) {
            if (retained) acceptedByKey.set(key, retained);
        } else {
            acceptedByKey.set(key, retained && areAccountSettingsJsonValuesEqual(retained, row) ? retained : row);
        }
    }
    for (const [key, row] of previousByKey) {
        if (incomingByKey.has(key)) continue;
        if (absentKeys?.has(key)) continue;
        // An explicit absent row revision is a tombstone, not an omitted page entry.
        const incomingRevision = incomingRevisions[key];
        if (incomingRevision !== undefined && incomingRevision >= (previousRevisions[key] ?? -1)) continue;
        if (!complete || previousRevisions[key] !== undefined) acceptedByKey.set(key, row);
    }
    const order = complete ? [...incomingByKey.keys(), ...previousByKey.keys()] : [...previousByKey.keys(), ...incomingByKey.keys()];
    const next: T[] = [];
    for (const key of new Set(order)) {
        const row = acceptedByKey.get(key);
        if (row !== undefined) next.push(row);
    }
    return next.length === previous.length && next.every((row, index) => row === previous[index]) ? previous : next;
}

/**
 * Whether the opened census can say a checkout is absent: an authorized, complete read. While rows
 * are loading, failed, locked or partial, a ref that is not listed is unconfirmed, never "gone".
 */
export function isProjectAccountRowsCensusComplete(snapshot: Pick<ProjectAccountRowsSnapshot, 'status' | 'coverage'> | null | undefined): boolean {
    return snapshot?.status === 'ready' && snapshot.coverage === 'complete';
}

export function readProjectWorkspaceRefs(state: Parameters<typeof readCurrentProjectAccountRows>[0]): readonly WorkspaceRefV1[] {
    return readCurrentProjectAccountRows(state)?.workspaceRefs ?? EMPTY_WORKSPACE_REFS;
}

export function readProjectAtmosphere(state: Parameters<typeof readCurrentProjectAccountRows>[0],
    project: Readonly<{ serverId: string; projectKey: string }>): ProjectAccountOrganizationV1['atmosphere'] {
    return readCurrentProjectAccountRows(state)?.organizations.find(row => row.key.serverId === project.serverId
        && row.key.projectKey === project.projectKey)?.value.atmosphere;
}

export type MachineFreshCopyRow = Readonly<{
    relationship: WorkspaceSyncRelationshipV1;
    source: WorkspaceRefV1;
    target: WorkspaceRefV1;
}>;

/** Null is an unknown census, not evidence that this Machine has no worker copies. */
export function readMachineFreshCopies(
    state: Parameters<typeof readCurrentProjectAccountRows>[0],
    input: Readonly<{ scope: ServerAccountScope; machineId: string }>,
): readonly MachineFreshCopyRow[] | null {
    const rows = readCurrentProjectAccountRows(state);
    if (!rows || rows.status !== 'ready' || rows.coverage !== 'complete'
        || !areServerAccountScopesEqual(rows.scope, input.scope)) return null;
    const refs = new Map<string, WorkspaceRefV1>();
    for (const ref of rows.workspaceRefs) {
        if (ref.serverId !== rows.scope.serverId) continue;
        if (refs.has(ref.id)) return null;
        refs.set(ref.id, ref);
    }
    const copies: MachineFreshCopyRow[] = [];
    for (const relationship of rows.relationships) {
        const provenance = getWorkspaceSyncWorkerCopyV1(relationship);
        if (!provenance) continue;
        const target = refs.get(provenance.targetWorkspaceRefId);
        if (!target) return null;
        if (target.machineId !== input.machineId) continue;
        const source = refs.get(provenance.sourceWorkspaceRefId);
        if (!source) return null;
        copies.push({ relationship, source, target });
    }
    return copies;
}

export function createProjectAccountRowsDomain<S extends ProjectAccountRowsDomain>({ set }: { set: StoreSet<S>; get: StoreGet<S> }): ProjectAccountRowsDomain {
    return {
        projectAccountRows: null,
        pinnedWorkspaceRefIds: EMPTY_PINNED_WORKSPACE_REF_IDS,
        activateProjectAccountRowsScope: (scope) => set((state) => {
            if (areServerAccountScopesEqual(state.projectAccountRows?.scope, scope)) return state;
            return { projectAccountRows: { scope, status: 'idle', coverage: 'unknown', workspaceRefs: EMPTY_WORKSPACE_REFS,
                relationships: EMPTY_WORKSPACE_RELATIONSHIPS, organizations: EMPTY_PROJECT_ORGANIZATIONS, revisionsByPhysicalKey: {} }, pinnedWorkspaceRefIds: EMPTY_PINNED_WORKSPACE_REF_IDS } as Partial<S>;
        }),
        applyProjectAccountRowsForScope: (scope, incoming, source = 'census', materialization) => set((state) => {
            const previous = state.projectAccountRows;
            if (!previous || !areServerAccountScopesEqual(previous.scope, scope) || !areServerAccountScopesEqual(incoming.scope, scope)) return state;
            // Failure/status results cannot replace an opened, authorized census with fabricated absence.
            if (source === 'census' && incoming.status !== 'ready') {
                return previous.status === incoming.status ? state : { projectAccountRows: { ...previous, status: incoming.status } } as Partial<S>;
            }
            // Successful exact reads can recover readiness; only a census proves coverage/freshness.
            const status = source === 'projection' && !materialization?.refreshSucceeded ? previous.status : incoming.status;
            const coverage = source === 'projection' ? previous.coverage : incoming.coverage;
            const absentKeys = new Set(materialization?.absentPhysicalKeys);
            const incomingRevisions = { ...incoming.revisionsByPhysicalKey };
            for (const row of incoming.organizations) incomingRevisions[buildProjectAccountRowPhysicalKeyV1(row.key)] = row.revision;
            const complete = coverage === 'complete';
            const workspaceRefs = reconcileRows(previous.workspaceRefs, incoming.workspaceRefs,
                ref => buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId: ref.serverId, id: ref.id }), previous.revisionsByPhysicalKey, incomingRevisions, complete, absentKeys);
            const sessionProjectKeyResolver = workspaceRefs === previous.workspaceRefs && previous.sessionProjectKeyResolver
                ? previous.sessionProjectKeyResolver
                : createSessionProjectKeyResolverV1(workspaceRefs, workspaceRefResolutionContextV1());
            const organizations = reconcileRows(previous.organizations, incoming.organizations,
                row => buildProjectAccountRowPhysicalKeyV1(row.key), previous.revisionsByPhysicalKey, incomingRevisions, complete, absentKeys);
            const graphKey = buildProjectAccountRowPhysicalKeyV1({ kind: 'relationship-graph' });
            const hasGraph = incomingRevisions[graphKey] !== undefined || incoming.relationships.length > 0 || complete;
            const relationships = !absentKeys.has(graphKey) && (!hasGraph || (incomingRevisions[graphKey] ?? -1) < (previous.revisionsByPhysicalKey[graphKey] ?? -1))
                ? previous.relationships : reconcileRows(previous.relationships, incoming.relationships, relationship => relationship.relationshipId, {}, {}, true);
            const mergedRevisions = { ...previous.revisionsByPhysicalKey };
            for (const [key, revision] of Object.entries(incomingRevisions)) mergedRevisions[key] = Math.max(revision, mergedRevisions[key] ?? -1);
            for (const key of absentKeys) delete mergedRevisions[key];
            const revisionsByPhysicalKey = areAccountSettingsJsonValuesEqual(previous.revisionsByPhysicalKey, mergedRevisions)
                ? previous.revisionsByPhysicalKey : mergedRevisions;
            const mergedAuthoring = { ...previous.authoringSessionsByPhysicalKey };
            const liveRefKeys = new Set(workspaceRefs.map(ref => buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId: ref.serverId, id: ref.id })));
            for (const key of new Set([...Object.keys(mergedAuthoring), ...Object.keys(incoming.authoringSessionsByPhysicalKey ?? {})])) {
                const revision = incomingRevisions[key];
                if (revision === undefined) continue;
                if (revision < (previous.revisionsByPhysicalKey[key] ?? -1)) continue;
                const authoring = incoming.authoringSessionsByPhysicalKey?.[key];
                if (authoring) mergedAuthoring[key] = authoring;
                // Tombstones retire the relationship with its checkout.
                else if (!liveRefKeys.has(key)) delete mergedAuthoring[key];
            }
            for (const key of absentKeys) delete mergedAuthoring[key];
            const authoringSessionsByPhysicalKey = areAccountSettingsJsonValuesEqual(previous.authoringSessionsByPhysicalKey ?? {}, mergedAuthoring)
                ? previous.authoringSessionsByPhysicalKey : mergedAuthoring;
            if (previous.status === status && previous.coverage === coverage && workspaceRefs === previous.workspaceRefs
                && sessionProjectKeyResolver === previous.sessionProjectKeyResolver && relationships === previous.relationships
                && organizations === previous.organizations && revisionsByPhysicalKey === previous.revisionsByPhysicalKey
                && authoringSessionsByPhysicalKey === previous.authoringSessionsByPhysicalKey) return state;
            let pinnedWorkspaceRefIds = state.pinnedWorkspaceRefIds;
            if (workspaceRefs !== previous.workspaceRefs || organizations !== previous.organizations) {
                const pinnedProjects = new Set(organizations.filter(row => row.value.pinned === true).map(row => buildProjectAccountRowPhysicalKeyV1(row.key)));
                const nextPins = workspaceRefs.filter(ref => pinnedProjects.has(buildProjectAccountRowPhysicalKeyV1({ kind: 'project-organization',
                    serverId: ref.serverId, projectKey: ref.projectKey ?? ref.id }))).map(ref => ref.id);
                if (!areAccountSettingsJsonValuesEqual(nextPins, pinnedWorkspaceRefIds)) pinnedWorkspaceRefIds = nextPins;
            }
            const workerCopyStatusRevisions = advanceWorkerCopyStatusRevisions(previous, { scope: previous.scope, workspaceRefs, relationships });
            return { projectAccountRows: { ...incoming, scope: previous.scope, status, coverage, workspaceRefs, sessionProjectKeyResolver, workerCopyStatusRevisions,
                relationships, organizations, revisionsByPhysicalKey, authoringSessionsByPhysicalKey,
                lastReadyAtMs: source === 'projection' ? previous.lastReadyAtMs : Date.now() }, pinnedWorkspaceRefIds } as Partial<S>;
        }),
        setProjectAccountRowsStatusForScope: (scope, status) => set(state => !areServerAccountScopesEqual(state.projectAccountRows?.scope, scope)
            || state.projectAccountRows?.status === status ? state : { projectAccountRows: { ...state.projectAccountRows!, status } } as Partial<S>),
        clearProjectAccountRowsScope: () => set(state => state.projectAccountRows === null ? state : { projectAccountRows: null, pinnedWorkspaceRefIds: EMPTY_PINNED_WORKSPACE_REF_IDS } as Partial<S>),
    };
}
