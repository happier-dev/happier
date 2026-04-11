import type { ProjectRouteSegment } from '@/components/projects/detail/projectRouteState';

export type ProjectMobileSurface = 'overview' | 'browse' | 'git' | 'tabs' | 'terminal';
export type ProjectLegacyRouteKind = 'index' | 'files' | 'git' | 'details' | 'terminal';
type ProjectRightTabId = 'git' | 'files';

export function migrateProjectRouteSegmentToMobileSurface(
    persistedSelection: string | null | undefined,
): ProjectMobileSurface | null {
    const normalized = typeof persistedSelection === 'string' ? persistedSelection.trim() : '';
    if (normalized === 'overview' || normalized === 'browse' || normalized === 'git' || normalized === 'tabs' || normalized === 'terminal') {
        return normalized;
    }
    if (normalized === 'files') {
        return 'browse';
    }
    if (normalized === 'details') {
        return 'tabs';
    }
    return null;
}

export function resolveProjectRouteSegmentFromMobileSurface(surface: ProjectMobileSurface): ProjectRouteSegment {
    if (surface === 'git') {
        return 'git';
    }
    if (surface === 'browse') {
        return 'files';
    }
    return 'details';
}

export function resolveProjectLegacyRouteSegmentFromState(
    activeTabId: string | null | undefined,
    persistedSelection?: string | null,
): ProjectRouteSegment {
    if (activeTabId === 'git' || activeTabId === 'files') {
        return activeTabId;
    }
    const migratedSurface = migrateProjectRouteSegmentToMobileSurface(persistedSelection);
    if (migratedSurface) {
        return resolveProjectRouteSegmentFromMobileSurface(migratedSurface);
    }
    return 'files';
}

export function resolveProjectRightTabIdForSurface(surface: ProjectMobileSurface): ProjectRightTabId | null {
    if (surface === 'git') {
        return 'git';
    }
    if (surface === 'browse') {
        return 'files';
    }
    return null;
}

export function resolveProjectMobileSurfaceIntent(input: Readonly<{
    routeKind: ProjectLegacyRouteKind;
    activeRightTabId?: string | null;
    detailsTargetPresent?: boolean;
    overviewVisible?: boolean;
    persistedSurface?: string | null;
    explicitSurfaceHint?: string | null;
}>): ProjectMobileSurface {
    if (input.routeKind === 'files') {
        return 'browse';
    }
    if (input.routeKind === 'git') {
        return 'git';
    }
    if (input.routeKind === 'terminal') {
        return 'terminal';
    }
    if (input.routeKind === 'details') {
        return input.overviewVisible === true ? 'overview' : 'tabs';
    }

    const explicitSurfaceHint = migrateProjectRouteSegmentToMobileSurface(input.explicitSurfaceHint);
    if (explicitSurfaceHint) {
        return explicitSurfaceHint;
    }
    if (input.overviewVisible === true) {
        return 'overview';
    }
    const persistedSurface = migrateProjectRouteSegmentToMobileSurface(input.persistedSurface);
    if (persistedSurface) {
        return persistedSurface;
    }
    if (input.activeRightTabId === 'git') {
        return 'git';
    }
    if (input.activeRightTabId === 'files') {
        return 'browse';
    }
    if (input.detailsTargetPresent === true) {
        return 'tabs';
    }
    return 'overview';
}

export function resolveProjectRoutePathForSurface(input: Readonly<{
    workspaceRefId: string;
    surface: ProjectMobileSurface;
    rawWorktreeId?: string | null;
    rawActiveRootPath?: string | null;
}>): string {
    const encodedWorkspaceRefId = encodeURIComponent(input.workspaceRefId);
    const basePath = input.surface === 'browse'
        ? `/projects/${encodedWorkspaceRefId}/files`
        : input.surface === 'git'
            ? `/projects/${encodedWorkspaceRefId}/git`
            : input.surface === 'tabs'
                ? `/projects/${encodedWorkspaceRefId}/details`
                : input.surface === 'terminal'
                    ? `/projects/${encodedWorkspaceRefId}/terminal`
                    : `/projects/${encodedWorkspaceRefId}`;
    const searchParams = new URLSearchParams();
    const trimmedWorktreeId = typeof input.rawWorktreeId === 'string' ? input.rawWorktreeId.trim() : '';
    const trimmedActiveRootPath = typeof input.rawActiveRootPath === 'string' ? input.rawActiveRootPath.trim() : '';
    if (!trimmedWorktreeId) {
        if (trimmedActiveRootPath) {
            searchParams.set('activeRootPath', trimmedActiveRootPath);
        }
        if (input.surface === 'overview') {
            searchParams.set('mobileSurface', input.surface);
        }
        const query = searchParams.toString();
        return query.length > 0 ? `${basePath}?${query}` : basePath;
    }
    searchParams.set('worktreeId', trimmedWorktreeId);
    if (input.surface === 'overview') {
        searchParams.set('mobileSurface', input.surface);
    }
    return `${basePath}?${searchParams.toString()}`;
}

export function resolveProjectCockpitRouteFromPathname(
    pathname: string | null | undefined,
    persistedSurface?: string | null,
    explicitRootSurfaceHint?: string | null,
): Readonly<{ workspaceRefId: string; surface: ProjectMobileSurface }> | null {
    const normalizedPathname = typeof pathname === 'string' ? pathname.trim() : '';
    const match = /^\/projects\/([^/]+?)(?:\/(files|git|details|terminal))?$/.exec(normalizedPathname);
    if (!match) {
        return null;
    }

    const [, encodedWorkspaceRefId, routeSegment] = match;
    const workspaceRefId = decodeURIComponent(encodedWorkspaceRefId);
    const routeKind: ProjectLegacyRouteKind =
        routeSegment === 'files'
            ? 'files'
            : routeSegment === 'git'
                ? 'git'
                : routeSegment === 'details'
                    ? 'details'
                    : routeSegment === 'terminal'
                        ? 'terminal'
                        : 'index';

    return {
        workspaceRefId,
        surface: resolveProjectMobileSurfaceIntent({
            routeKind,
            persistedSurface,
            explicitSurfaceHint: routeKind === 'index' ? explicitRootSurfaceHint : null,
        }),
    };
}
