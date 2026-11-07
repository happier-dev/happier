import * as React from 'react';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useDestinationGlobalParamsSelector } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readProjectAccountWorkspaceRefs, useProjectAccountRows, type ProjectAccountRowsSnapshot } from '@/sync/domains/workspaces/projectAccountRows';
import { readStoreProjectRoute, storeProjectRouteParams } from './pluginsSurfaceRoutes';

/** Admission is over the current Account's held census, never a fetch or a remembered selection. */
export function resolveStoreProjectRef(project: QualifiedProjectKeyV1 | null, rows: ProjectAccountRowsSnapshot | null,
    scope: ServerAccountScope | null) {
    if (!project || !scope || !areServerAccountScopesEqual(rows?.scope, scope)
        || !areServerProfileIdentifiersEquivalent(project.serverId, scope.serverId)) return null;
    return readProjectAccountWorkspaceRefs({ projectAccountRows: rows })?.find(candidate =>
        areServerProfileIdentifiersEquivalent(candidate.serverId, project.serverId)
        && projectWorkspaceRefV1(candidate).projectKey === project.projectKey) ?? null;
}

export function useAdmittedStoreProject(project: QualifiedProjectKeyV1 | null) {
    const lifetime = useActiveServerAccountScopeLifetime();
    const ref = useProjectAccountRows(rows => resolveStoreProjectRef(project, rows, lifetime?.isCurrent() ? lifetime.scope : null), project !== null);
    return React.useMemo(() => ({ project: ref ? projectWorkspaceRefV1(ref) : null, workspaceRef: ref }), [ref]);
}

/** Route-owned scope. Every reader uses the same decoder and current Account admission. */
const selectProjectParam = (params: Readonly<Record<string, unknown>>) => params.project;

export function useStoreProjectScope() {
    const project = useDestinationGlobalParamsSelector(selectProjectParam);
    const requested = React.useMemo(() => readStoreProjectRoute({ project }), [project]);
    const admitted = useAdmittedStoreProject(requested);
    const router = useRouter();
    const setProject = React.useCallback((next: QualifiedProjectKeyV1 | null) => {
        router.setParams(storeProjectRouteParams(next));
    }, [router]);
    return { ...admitted, setProject };
}
