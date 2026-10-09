import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol';
import { buildProjectAccountRowPhysicalKeyV1, type ProjectAccountOrganizationV1, type ProjectAccountRowKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { StoreGet, StoreSet } from './_shared';

export type ProjectAccountRowsStatus = 'idle' | 'loading' | 'ready' | 'error' | 'locked' | 'refused';
export type ProjectOrganizationRow = Readonly<{
    key: Extract<ProjectAccountRowKeyV1, { kind: 'project-organization' }>;
    revision: number;
    value: ProjectAccountOrganizationV1;
}>;
export type ProjectAccountRowsSnapshot = Readonly<{
    scope: ServerAccountScope;
    status: ProjectAccountRowsStatus;
    coverage: 'unknown' | 'partial' | 'complete';
    workspaceRefs: readonly WorkspaceRefV1[];
    relationships: readonly WorkspaceSyncRelationshipV1[];
    organizations: readonly ProjectOrganizationRow[];
    revisionsByPhysicalKey: Readonly<Record<string, number>>;
}>;
export type ProjectAccountRowsDomain = {
    projectAccountRows: ProjectAccountRowsSnapshot | null;
    pinnedWorkspaceRefIds: readonly string[];
    activateProjectAccountRowsScope(scope: ServerAccountScope): void;
    applyProjectAccountRowsForScope(scope: ServerAccountScope, snapshot: ProjectAccountRowsSnapshot): void;
    setProjectAccountRowsStatusForScope(scope: ServerAccountScope, status: ProjectAccountRowsStatus): void;
    clearProjectAccountRowsScope(): void;
};
export const EMPTY_PINNED_WORKSPACE_REF_IDS: readonly string[] = Object.freeze([]);
export const EMPTY_WORKSPACE_REFS: readonly WorkspaceRefV1[] = Object.freeze([]);
export const EMPTY_WORKSPACE_RELATIONSHIPS: readonly WorkspaceSyncRelationshipV1[] = Object.freeze([]);
export const EMPTY_PROJECT_ORGANIZATIONS: readonly ProjectOrganizationRow[] = Object.freeze([]);

function reconcileRows<T>(previous: readonly T[], incoming: readonly T[], keyOf: (row: T) => string,
    previousRevisions: Readonly<Record<string, number>>, incomingRevisions: Readonly<Record<string, number>>, complete: boolean): readonly T[] {
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

export function readCurrentProjectAccountRows(state: Pick<ProjectAccountRowsDomain, 'projectAccountRows'> & { profileScope?: ServerAccountScope | null }): ProjectAccountRowsSnapshot | null {
    if ('profileScope' in state && !areServerAccountScopesEqual(state.profileScope, state.projectAccountRows?.scope)) return null;
    return state.projectAccountRows;
}

export function readProjectWorkspaceRefs(state: Parameters<typeof readCurrentProjectAccountRows>[0]): readonly WorkspaceRefV1[] {
    return readCurrentProjectAccountRows(state)?.workspaceRefs ?? EMPTY_WORKSPACE_REFS;
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
        applyProjectAccountRowsForScope: (scope, incoming) => set((state) => {
            const previous = state.projectAccountRows;
            if (!previous || !areServerAccountScopesEqual(previous.scope, scope) || !areServerAccountScopesEqual(incoming.scope, scope)) return state;
            // Failure/status results cannot replace an opened, authorized census with fabricated absence.
            if (incoming.status !== 'ready') {
                return previous.status === incoming.status ? state : { projectAccountRows: { ...previous, status: incoming.status } } as Partial<S>;
            }
            const incomingRevisions = { ...incoming.revisionsByPhysicalKey };
            for (const row of incoming.organizations) incomingRevisions[buildProjectAccountRowPhysicalKeyV1(row.key)] = row.revision;
            const complete = incoming.coverage === 'complete';
            const workspaceRefs = reconcileRows(previous.workspaceRefs, incoming.workspaceRefs,
                ref => buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId: ref.serverId, id: ref.id }), previous.revisionsByPhysicalKey, incomingRevisions, complete);
            const organizations = reconcileRows(previous.organizations, incoming.organizations,
                row => buildProjectAccountRowPhysicalKeyV1(row.key), previous.revisionsByPhysicalKey, incomingRevisions, complete);
            const graphKey = buildProjectAccountRowPhysicalKeyV1({ kind: 'relationship-graph' });
            const hasGraph = incomingRevisions[graphKey] !== undefined || incoming.relationships.length > 0 || complete;
            const relationships = !hasGraph || (incomingRevisions[graphKey] ?? -1) < (previous.revisionsByPhysicalKey[graphKey] ?? -1)
                ? previous.relationships : reconcileRows(previous.relationships, incoming.relationships, relationship => relationship.relationshipId, {}, {}, true);
            const mergedRevisions = { ...previous.revisionsByPhysicalKey };
            for (const [key, revision] of Object.entries(incomingRevisions)) mergedRevisions[key] = Math.max(revision, mergedRevisions[key] ?? -1);
            const revisionsByPhysicalKey = areAccountSettingsJsonValuesEqual(previous.revisionsByPhysicalKey, mergedRevisions)
                ? previous.revisionsByPhysicalKey : mergedRevisions;
            if (previous.status === incoming.status && previous.coverage === incoming.coverage && workspaceRefs === previous.workspaceRefs
                && relationships === previous.relationships && organizations === previous.organizations && revisionsByPhysicalKey === previous.revisionsByPhysicalKey) return state;
            let pinnedWorkspaceRefIds = state.pinnedWorkspaceRefIds;
            if (workspaceRefs !== previous.workspaceRefs || organizations !== previous.organizations) {
                const pinnedProjects = new Set(organizations.filter(row => row.value.pinned === true).map(row => buildProjectAccountRowPhysicalKeyV1(row.key)));
                const nextPins = workspaceRefs.filter(ref => pinnedProjects.has(buildProjectAccountRowPhysicalKeyV1({ kind: 'project-organization',
                    serverId: ref.serverId, projectKey: ref.projectKey ?? ref.id }))).map(ref => ref.id);
                if (!areAccountSettingsJsonValuesEqual(nextPins, pinnedWorkspaceRefIds)) pinnedWorkspaceRefIds = nextPins;
            }
            return { projectAccountRows: { ...incoming, scope: previous.scope, workspaceRefs, relationships, organizations, revisionsByPhysicalKey }, pinnedWorkspaceRefIds } as Partial<S>;
        }),
        setProjectAccountRowsStatusForScope: (scope, status) => set(state => !areServerAccountScopesEqual(state.projectAccountRows?.scope, scope)
            || state.projectAccountRows?.status === status ? state : { projectAccountRows: { ...state.projectAccountRows!, status } } as Partial<S>),
        clearProjectAccountRowsScope: () => set(state => state.projectAccountRows === null ? state : { projectAccountRows: null, pinnedWorkspaceRefIds: EMPTY_PINNED_WORKSPACE_REF_IDS } as Partial<S>),
    };
}
