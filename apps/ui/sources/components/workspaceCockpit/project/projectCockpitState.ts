export const PROJECT_PAGES = ['overview', 'code', 'changes', 'scripts', 'services', 'context'] as const;
export type ProjectPageV1 = typeof PROJECT_PAGES[number];
/** Companion ids are retained registry selections, never alternate Project page routes. */
export type ProjectMobileSurface = ProjectPageV1 | 'browse' | 'git' | 'tabs' | 'terminal' | 'browser';
export type ProjectRouteKind = ProjectPageV1 | 'index' | 'terminal';

export function normalizeProjectPage(value: string | null | undefined): ProjectPageV1 | null {
    const normalized = value?.trim() ?? '';
    return PROJECT_PAGES.find(page => page === normalized) ?? null;
}

export function normalizeProjectMobileSurface(value: string | null | undefined): ProjectMobileSurface | null {
    const page = normalizeProjectPage(value);
    if (page) return page;
    const normalized = value?.trim() ?? '';
    return normalized === 'browse' || normalized === 'git' || normalized === 'tabs'
        || normalized === 'terminal' || normalized === 'browser' ? normalized : null;
}

export function resolveProjectPageForSurface(surface: ProjectMobileSurface): ProjectPageV1 {
    return normalizeProjectPage(surface) ?? (surface === 'browse' ? 'code' : surface === 'git' ? 'changes' : 'overview');
}

export function resolveProjectRightTabIdForSurface(surface: ProjectMobileSurface): string | null {
    if (surface === 'code' || surface === 'browse') return 'files';
    if (surface === 'changes' || surface === 'git') return 'git';
    if (surface === 'browser' || surface === 'services' || surface === 'scripts' || surface === 'terminal') return surface;
    return null;
}

export function resolveProjectMobileSurfaceIntent(input: Readonly<{
    routeKind: ProjectRouteKind;
    activeRightTabId?: string | null;
    detailsTargetPresent?: boolean;
    overviewVisible?: boolean;
    persistedSurface?: string | null;
    explicitSurfaceHint?: string | null;
}>): ProjectMobileSurface {
    const explicit = normalizeProjectMobileSurface(input.explicitSurfaceHint);
    if (input.routeKind !== 'index') {
        // The pathname owns the page. A hint may only project a companion on that page.
        return explicit ?? input.routeKind;
    }
    return explicit ?? normalizeProjectMobileSurface(input.persistedSurface)
        ?? (input.overviewVisible ? 'overview'
            : input.activeRightTabId === 'files' ? 'browse'
                : input.activeRightTabId === 'git' ? 'git'
                    : input.activeRightTabId === 'browser' ? 'browser'
                    : input.activeRightTabId === 'services' ? 'services'
                        : input.activeRightTabId === 'scripts' ? 'scripts'
                            : input.activeRightTabId === 'terminal' ? 'terminal'
                            : input.detailsTargetPresent ? 'tabs' : 'overview');
}

export type ProjectRouteContext = Readonly<{
    serverId?: string | null;
    layoutId?: string | null;
    /** Selection references a Source attachment; its owner/surface are read from the Artifact. */
    attachedDashboard?: ProjectAttachedDashboardSelection | null;
    comparisonId?: string | null;
    routeParams?: Readonly<Record<string, string | string[] | undefined>>;
}>;
export type ProjectAttachedDashboardSelection = Readonly<{ sourceId: string; artifactId: string }>;

export function resolveProjectRoutePathForSurface(input: Readonly<{
    workspaceRefId: string;
    surface: ProjectMobileSurface;
    page?: ProjectPageV1;
    rawWorktreeId?: string | null;
    rawActiveRootPath?: string | null;
}> & ProjectRouteContext): string {
    const page = input.page ?? resolveProjectPageForSurface(input.surface);
    const basePath = `/projects/${encodeURIComponent(input.workspaceRefId)}/${page}`;
    const searchParams = new URLSearchParams();
    for (const [key, raw] of Object.entries(input.routeParams ?? {})) {
        if (key === 'workspaceRefId' || key === 'pageId' || key === 'worktreeId' || key === 'activeRootPath' || key === 'mobileSurface') continue;
        const value = Array.isArray(raw) ? raw[0] : raw;
        if (value !== undefined) searchParams.set(key, value);
    }
    if (input.rawWorktreeId?.trim()) searchParams.set('worktreeId', input.rawWorktreeId.trim());
    else if (input.rawActiveRootPath?.trim()) searchParams.set('activeRootPath', input.rawActiveRootPath.trim());
    for (const key of ['serverId', 'layoutId', 'comparisonId'] as const) {
        if (input[key] === null) searchParams.delete(key);
        const value = input[key]?.trim();
        if (value) searchParams.set(key, value);
    }
    if (input.attachedDashboard !== undefined) {
        searchParams.delete('dashboardSourceId');
        searchParams.delete('dashboardArtifactId');
        if (input.attachedDashboard) {
            searchParams.delete('layoutId');
            searchParams.set('dashboardSourceId', input.attachedDashboard.sourceId);
            searchParams.set('dashboardArtifactId', input.attachedDashboard.artifactId);
        }
    }
    if (input.surface !== page) searchParams.set('mobileSurface', input.surface);
    const query = searchParams.toString();
    return query ? `${basePath}?${query}` : basePath;
}

export function resolveProjectCockpitRouteFromPathname(
    pathname: string | null | undefined,
    persistedSurface?: string | null,
    explicitSurfaceHint?: string | null,
): Readonly<{ workspaceRefId: string; page: ProjectPageV1; surface: ProjectMobileSurface }> | null {
    let url: URL;
    try { url = new URL(pathname ?? '', 'https://happier.invalid'); } catch { return null; }
    const match = /^\/projects\/([^/]+)(?:\/(overview|code|changes|scripts|services|context|terminal))?\/?$/.exec(url.pathname);
    if (!match) return null;
    let workspaceRefId: string;
    try { workspaceRefId = decodeURIComponent(match[1]!); } catch { return null; }
    // Static selection flows precede checkout acceptance and have no cockpit.
    if (workspaceRefId === 'open' || workspaceRefId === 'sources') return null;
    const routeKind = match[2] as ProjectRouteKind | undefined;
    const surface = resolveProjectMobileSurfaceIntent({ routeKind: routeKind ?? 'index', persistedSurface,
        explicitSurfaceHint: explicitSurfaceHint ?? url.searchParams.get('mobileSurface') });
    return { workspaceRefId, page: normalizeProjectPage(routeKind) ?? resolveProjectPageForSurface(surface), surface };
}
