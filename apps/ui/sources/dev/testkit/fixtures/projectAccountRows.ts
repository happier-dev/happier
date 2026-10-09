import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ProjectAccountRowsSnapshot } from '@/sync/store/domains/projectAccountRows';
import type { StorageState } from '@/sync/store/types';
import { buildProjectAccountRowPhysicalKeyV1, ProjectAccountRowListResponseV1Schema, ProjectAccountWorkspaceRefV1Schema, type ProjectAccountRowListResponseV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';

export function createProjectAccountRowsFixture(scope: ServerAccountScope, overrides: Partial<Omit<ProjectAccountRowsSnapshot, 'scope'>> = {}): ProjectAccountRowsSnapshot {
    const revisionsByPhysicalKey = { ...Object.fromEntries((overrides.workspaceRefs ?? []).map(ref => [
        buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId: ref.serverId, id: ref.id }), 0,
    ])), [buildProjectAccountRowPhysicalKeyV1({ kind: 'relationship-graph' })]: 0 };
    return { scope, status: 'ready', coverage: 'complete', workspaceRefs: [], relationships: [], organizations: [], revisionsByPhysicalKey, ...overrides };
}

/** Home HTTP census for plain Accounts; the real row decoder and projection stay in the path. */
export function createPlainProjectAccountRowListFixture(overrides: Pick<Partial<ProjectAccountRowsSnapshot>, 'workspaceRefs' | 'relationships' | 'organizations'> = {}): ProjectAccountRowListResponseV1 {
    return ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: [
        ...(overrides.workspaceRefs ?? []).map(({ lastOpenedAtMs: _recency, ...ref }) => {
            const key = { kind: 'workspace-ref', serverId: ref.serverId, id: ref.id };
            return { key, revision: 0, content: { t: 'plain', v: { key, value: ProjectAccountWorkspaceRefV1Schema.parse(ref) } } };
        }),
        { key: { kind: 'relationship-graph' }, revision: 0,
            content: { t: 'plain', v: { key: { kind: 'relationship-graph' }, value: { relationships: overrides.relationships ?? [] } } } },
        ...(overrides.organizations ?? []).map(({ key, revision, value }) => ({ key, revision, content: { t: 'plain', v: { key, value } } })),
    ] });
}

export function applyProjectAccountRowsFixture(store: { getState(): Pick<StorageState, 'profileScope' | 'activateProjectAccountRowsScope' | 'applyProjectAccountRowsForScope'> }, overrides: Partial<Omit<ProjectAccountRowsSnapshot, 'scope'>> = {}): void {
    const scope = store.getState().profileScope;
    if (!scope) throw new Error('Expected admitted Account realm');
    store.getState().activateProjectAccountRowsScope(scope);
    store.getState().applyProjectAccountRowsForScope(scope, createProjectAccountRowsFixture(scope, overrides));
}
