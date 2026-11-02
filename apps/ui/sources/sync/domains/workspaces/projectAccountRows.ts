import { useStoreWithEqualityFn } from 'zustand/traditional';
import type { StoreApi } from 'zustand/vanilla';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WorkspaceRefResolutionContextV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol';
import type { ProjectAccountAuthoringSessionV1, ProjectAccountOrganizationV1, ProjectAccountRowKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readRegisteredStorageState, subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { resolveWorkspaceRefById } from './workspaceRefs';

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
    /** When the rows were last read successfully; a failed refresh labels the retained rows with it. */
    lastReadyAtMs?: number;
    workspaceRefs: readonly WorkspaceRefV1[];
    /** Producer-owned index over these exact refs; status/Account admission remains with readers. */
    sessionProjectKeyResolver?: WorkspaceRefResolutionContextV1['sessionProjectKeyResolver'];
    relationships: readonly WorkspaceSyncRelationshipV1[];
    organizations: readonly ProjectOrganizationRow[];
    /** Server-owned display relationships; absence retains the older hydrated-Session fallback. */
    authoringSessionsByPhysicalKey?: Readonly<Record<string, ProjectAccountAuthoringSessionV1>>;
    revisionsByPhysicalKey: Readonly<Record<string, number>>;
}>;

export function readCurrentProjectAccountRows(state: Readonly<{
    projectAccountRows: ProjectAccountRowsSnapshot | null; profileScope?: ServerAccountScope | null;
}>): ProjectAccountRowsSnapshot | null {
    if ('profileScope' in state && !areServerAccountScopesEqual(state.profileScope, state.projectAccountRows?.scope)) return null;
    return state.projectAccountRows;
}

const read = () => {
    const state = readRegisteredStorageState();
    return state ? readCurrentProjectAccountRows(state) : null;
};
type ProjectRowsReader = Pick<StoreApi<ProjectAccountRowsSnapshot | null>, 'getState' | 'getInitialState' | 'subscribe'>;
// Select from the producer's stable Project snapshot, not the changing storage root.
// Zustand's standard selector owns selection; this bridge retains the single storage subscription path.
const projectRowsReader: ProjectRowsReader = {
    getState: read,
    getInitialState: read,
    subscribe: listener => subscribeRegisteredStorageState((state, previous) => listener(
        readCurrentProjectAccountRows(state), previous ? readCurrentProjectAccountRows(previous) : null,
    )) ?? (() => {}),
};
const unavailableProjectRowsReader: ProjectRowsReader = {
    getState: () => null,
    getInitialState: () => null,
    subscribe: () => () => {},
};
/** Select demanded facts from the opened Account/Home; disabled readers own no subscription. */
export function useProjectAccountRows(): ProjectAccountRowsSnapshot | null;
export function useProjectAccountRows<T>(select: (rows: ProjectAccountRowsSnapshot | null) => T, enabled?: boolean): T;
export function useProjectAccountRows<T>(select?: (rows: ProjectAccountRowsSnapshot | null) => T, enabled = true) {
    return useStoreWithEqualityFn(enabled ? projectRowsReader : unavailableProjectRowsReader,
        rows => select ? select(rows) : rows);
}

/** The complete opened checkout census, shared by subscriptions and pure projections. */
export function readProjectAccountWorkspaceRefs(state: Parameters<typeof readCurrentProjectAccountRows>[0]): readonly WorkspaceRefV1[] | undefined {
    const rows = readCurrentProjectAccountRows(state);
    // The producer retains complete rows only during refresh or a known transient failure;
    // authority/mode failures revoke that snapshot rather than being cached by this reader.
    return rows?.coverage === 'complete' && (rows.status === 'ready' || rows.status === 'loading' || rows.status === 'error')
        ? rows.workspaceRefs : undefined;
}
/** Demand only the opened checkout facts; unrelated Project records retain the selected identity. */
export function useProjectAccountWorkspaceRefs(enabled: boolean): readonly WorkspaceRefV1[] | undefined {
    return useProjectAccountRows(rows => readProjectAccountWorkspaceRefs({ projectAccountRows: rows }), enabled);
}

/** Exact checkout demand uses the same qualified, ambiguity-preserving resolver as the census. */
export function useProjectAccountWorkspaceRef(id: string | null, serverId?: string): WorkspaceRefV1 | null {
    return useProjectAccountRows(rows => {
        if (!id || !rows) return null;
        const result = resolveWorkspaceRefById(rows.workspaceRefs, id, serverId);
        return result.kind === 'resolved' ? result.ref : null;
    }, id !== null);
}
