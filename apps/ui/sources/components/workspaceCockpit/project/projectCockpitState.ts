import type { ProjectRouteSegment } from '@/components/projects/detail/projectRouteState';

export type ProjectMobileSurface = 'overview' | 'browse' | 'git' | 'tabs' | 'terminal' | 'browser' | 'services';
export type ProjectLegacyRouteKind = 'index' | 'files' | 'git' | 'details' | 'terminal';
type ProjectRightTabId = 'git' | 'files' | 'browser' | 'services';

/**
 * The one place a surface-shaped string becomes a `ProjectMobileSurface`. Callers that hold a
 * value from a wider vocabulary — the shared right-sidebar mobile surface union, which also
 * carries session-only and plugin surfaces — narrow through here instead of enumerating the
 * project surfaces again.
 */
export function normalizeProjectMobileSurface(
    value: string | null | undefined,
): ProjectMobileSurface | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (
        normalized === 'overview'
        || normalized === 'browse'
        || normalized === 'git'
        || normalized === 'tabs'
        || normalized === 'terminal'
        || normalized === 'browser'
        || normalized === 'services'
    ) {
        return normalized;
    }
    return null;
}

export function migrateProjectRouteSegmentToMobileSurface(
    persistedSelection: string | null | undefined,
): ProjectMobileSurface | null {
    const normalized = typeof persistedSelection === 'string' ? persistedSelection.trim() : '';
    if (normalized === 'files') {
        return 'browse';
    }
    if (normalized === 'details') {
        return 'tabs';
    }
    return normalizeProjectMobileSurface(normalized);
}

export function resolveProjectRouteSegmentFromMobileSurface(surface: ProjectMobileSurface): ProjectRouteSegment {
    if (surface === 'git') {
        return 'git';
    }
    if (surface === 'browse') {
        return 'files';
    }
    if (surface === 'browser' || surface === 'services') {
        return 'details';
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
    if (surface === 'browser') {
        return 'browser';
    }
    if (surface === 'services') {
        return 'services';
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
    const explicitSurfaceHint = migrateProjectRouteSegmentToMobileSurface(input.explicitSurfaceHint);
    if (input.routeKind === 'files') {
        if (explicitSurfaceHint === 'browser' || explicitSurfaceHint === 'services') {
            return explicitSurfaceHint;
        }
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
    if (input.activeRightTabId === 'browser') {
        return 'browser';
    }
    if (input.activeRightTabId === 'services') {
        return 'services';
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
        if (input.surface === 'overview' || input.surface === 'browser' || input.surface === 'services') {
            searchParams.set('mobileSurface', input.surface);
        }
        const query = searchParams.toString();
        return query.length > 0 ? `${basePath}?${query}` : basePath;
    }
    searchParams.set('worktreeId', trimmedWorktreeId);
    if (input.surface === 'overview' || input.surface === 'browser' || input.surface === 'services') {
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
    const pathWithoutQuery = normalizedPathname.split(/[?#]/, 1)[0]?.replace(/\/+$/, '') ?? '';
    const match = /^\/projects\/([^/]+?)(?:\/(files|git|details|terminal))?$/.exec(pathWithoutQuery);
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
            explicitSurfaceHint: explicitRootSurfaceHint,
        }),
    };
}
