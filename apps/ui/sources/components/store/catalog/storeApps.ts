import * as React from 'react';
import type { DeploymentEnvironmentReadCollectionV1, DeploymentReadFailureV1 } from '@happier-dev/deployments';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { useDeploymentInventory } from '@/components/projects/deployments/useDeploymentProject';
import { buildDeploymentEnvironmentHref } from '@/components/projects/deployments/deploymentNavigation';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useProjectAccountRows, type ProjectAccountRowsSnapshot } from '@/sync/domains/workspaces/projectAccountRows';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { InstalledFamilyResult, StoreDemand, StoreInstalledInput } from './storeKinds';
import type { InstalledScopeAdmission } from './storeAccountAdmission';

export type InstalledAppRow = Readonly<{
    kind: 'app'; key: string; scope: ServerAccountScope;
    native: DeploymentEnvironmentReadCollectionV1['items'][number];
    projectKeys: readonly string[] | null;
    home: string;
}>;
type NativeRead = ReturnType<typeof useDeploymentInventory>;
type NativeReason = NonNullable<InstalledScopeAdmission['failure']> | DeploymentReadFailureV1
    | NativeRead['snapshot'] | DeploymentEnvironmentReadCollectionV1 | ProjectAccountRowsSnapshot;
export type InstalledAppsResult = InstalledFamilyResult<InstalledAppRow, NativeReason, NativeRead['nextPage'] | NativeRead['refresh']>
    & Readonly<{ navigation: Pick<NativeRead, 'hasNextPage' | 'hasPreviousPage' | 'nextPage' | 'previousPage' | 'refresh'> }>;
const EMPTY_ROWS: readonly InstalledAppRow[] = Object.freeze([]);

/** One native page: membership, runtime placement, freshness and paging remain deployment-owned. */
export function useInstalledApps(input: StoreInstalledInput, demand: StoreDemand,
    admitted: InstalledScopeAdmission): InstalledAppsResult {
    const selectProjects = React.useCallback((rows: ProjectAccountRowsSnapshot | null) => rows && admitted.scope
        && rows.scope.accountId === admitted.scope.accountId
        && areServerProfileIdentifiersEquivalent(rows.scope.serverId, admitted.scope.serverId) ? rows : null, [admitted.scope]);
    const projects = useProjectAccountRows(selectProjects, demand.presented && admitted.scope !== null);
    const projectKeysBySource = React.useMemo(() => {
        const index = new Map<string, Set<string>>();
        for (const ref of projects?.workspaceRefs ?? []) {
            if (!ref.source || !admitted.scope || !areServerProfileIdentifiersEquivalent(ref.serverId, admitted.scope.serverId)) continue;
            const keys = index.get(ref.source.sourceId) ?? new Set<string>();
            keys.add(projectWorkspaceRefV1(ref).projectKey);
            index.set(ref.source.sourceId, keys);
        }
        return index;
    }, [projects?.workspaceRefs, admitted.scope]);
    const sources = React.useMemo(() => input.projectKey
        ? [...projectKeysBySource].filter(([, keys]) => keys.has(input.projectKey!)).map(([id]) => id) : null,
    [projectKeysBySource, input.projectKey]);
    const nativeDemand = React.useMemo(() => ({ mounted: demand.presented, visible: demand.presented, focused: demand.presented }), [demand.presented]);
    const read = useDeploymentInventory(sources?.length === 0 ? null : admitted.binding, nativeDemand,
        { machineId: input.machine?.machineId, ...(sources?.length === 1 ? { projectSourceId: sources[0] } : {}) });
    const navigation = React.useMemo(() => ({ hasNextPage: read.hasNextPage, hasPreviousPage: read.hasPreviousPage,
        nextPage: read.nextPage, previousPage: read.previousPage, refresh: read.refresh }),
    [read.hasNextPage, read.hasPreviousPage, read.nextPage, read.previousPage, read.refresh]);
    const previousRows = React.useRef(EMPTY_ROWS);
    const rows = React.useMemo<readonly InstalledAppRow[]>(() => {
        const scope = admitted.scope;
        if (!scope || !demand.presented) { previousRows.current = EMPTY_ROWS; return EMPTY_ROWS; }
        // Preserve the native producer's unchanged-item identities through this presentation projection.
        const previous = new Map(previousRows.current.map(row => [row.native, row]));
        const next = (read.snapshot.value?.items ?? [])
            .filter(native => !sources || sources.includes(native.environment.projectSourceId)).map((native): InstalledAppRow => {
                const retained = previous.get(native);
                const projectKeys = projectKeysBySource.has(native.environment.projectSourceId)
                    ? [...projectKeysBySource.get(native.environment.projectSourceId)!] : null;
                if (retained?.scope === scope && (retained.projectKeys === projectKeys || retained.projectKeys && projectKeys
                    && retained.projectKeys.length === projectKeys.length && retained.projectKeys.every((key, index) => key === projectKeys[index]))) return retained;
                return { kind: 'app', key: serverAccountScopedResourceKey(scope, 'app', native.environment.id), scope, native, projectKeys,
                    home: buildDeploymentEnvironmentHref({ serverId: native.environment.serverId,
                        projectSourceId: native.environment.projectSourceId, environmentId: native.environment.id }) };
            });
        if (next.length === previousRows.current.length && next.every((row, index) => row === previousRows.current[index])) return previousRows.current;
        previousRows.current = next;
        return next;
    }, [admitted.scope, demand.presented, read.snapshot.value?.items, sources, projectKeysBySource]);
    return React.useMemo<InstalledAppsResult>(() => {
        if (!admitted.scope) return { rows: EMPTY_ROWS, coverage: admitted.coverage, navigation };
        if (!demand.presented) return { rows: EMPTY_ROWS, coverage: 'loading', navigation };
        if (input.projectKey && !projects) return { rows: EMPTY_ROWS, coverage: 'loading', navigation };
        if (sources?.length === 0) return { rows: EMPTY_ROWS, navigation,
            coverage: projects?.status === 'ready' && projects.coverage === 'complete' ? 'available' : { partial: projects! } };
        const { snapshot } = read;
        if (snapshot.status === 'unavailable') return { rows, navigation,
            coverage: { unavailable: snapshot.failure ?? snapshot }, continuation: read.refresh };
        if (snapshot.status !== 'ready' || !snapshot.value) return { rows, coverage: 'loading', navigation };
        if (input.projectKey && projects && (projects.status !== 'ready' || projects.coverage !== 'complete')) {
            return { rows, coverage: { partial: projects }, navigation,
                ...(read.hasNextPage ? { continuation: read.nextPage } : {}) };
        }
        return { rows, navigation, coverage: snapshot.value.coverage === 'complete' && !read.hasNextPage && !read.hasPreviousPage
            ? 'available' : { partial: snapshot.value }, ...(read.hasNextPage ? { continuation: read.nextPage } : {}) };
    }, [admitted.scope, admitted.coverage, demand.presented, input.projectKey, projects, sources, rows, read.snapshot, navigation,
        read.hasNextPage, read.hasPreviousPage, read.nextPage, read.refresh]);
}
