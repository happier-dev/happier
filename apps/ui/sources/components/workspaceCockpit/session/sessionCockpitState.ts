export type SessionMobileSurface = 'chat' | 'browse' | 'git' | 'tabs' | 'terminal';
export type SessionLegacyRouteKind = 'index' | 'files' | 'git' | 'details' | 'terminal';

type SessionRightTabId = 'git' | 'files' | 'terminal';
type SessionRoutePathQueryValue = string | number | boolean | null | undefined;

type SessionRoutePathOptions = Readonly<{
    serverId?: string | null;
    query?: Readonly<Record<string, SessionRoutePathQueryValue>>;
}>;

function normalizeSessionMobileSurface(value: string | null | undefined): SessionMobileSurface | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized === 'chat' || normalized === 'browse' || normalized === 'git' || normalized === 'tabs' || normalized === 'terminal') {
        return normalized;
    }
    return null;
}

function normalizeRouteQueryValue(value: unknown): string | null {
    if (typeof value !== 'string') {
        if (typeof value === 'number' || typeof value === 'boolean') {
            return String(value);
        }
        return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function appendRouteSearchParams(basePath: string, params: URLSearchParams): string {
    const search = params.toString();
    return search.length > 0 ? `${basePath}?${search}` : basePath;
}

export function resolveSessionRightTabIdForSurface(
    surface: SessionMobileSurface,
    terminalTabAvailable: boolean,
): SessionRightTabId | null {
    if (surface === 'browse') {
        return 'files';
    }
    if (surface === 'git') {
        return 'git';
    }
    if (surface === 'terminal' && terminalTabAvailable) {
        return 'terminal';
    }
    return null;
}

export function resolveSessionMobileSurfaceIntent(input: Readonly<{
    routeKind: SessionLegacyRouteKind;
    activeRightTabId?: string | null;
    detailsTargetPresent?: boolean;
    persistedSurface?: string | null;
    terminalTabAvailable?: boolean;
}>): SessionMobileSurface {
    if (input.routeKind === 'files') {
        return 'browse';
    }
    if (input.routeKind === 'git') {
        return 'git';
    }
    if (input.routeKind === 'details') {
        return 'tabs';
    }
    if (input.routeKind === 'terminal') {
        return input.terminalTabAvailable === true ? 'terminal' : 'chat';
    }

    const persistedSurface = normalizeSessionMobileSurface(input.persistedSurface);
    if (persistedSurface) {
        if (persistedSurface === 'terminal' && input.terminalTabAvailable !== true) {
            return 'chat';
        }
        return persistedSurface;
    }

    if (input.activeRightTabId === 'git') {
        return 'git';
    }
    if (input.activeRightTabId === 'files') {
        return 'browse';
    }
    if (input.activeRightTabId === 'terminal' && input.terminalTabAvailable === true) {
        return 'terminal';
    }
    if (input.detailsTargetPresent === true) {
        return 'tabs';
    }

    return 'chat';
}

export function resolveSessionRoutePathForSurface(
    sessionId: string,
    surface: SessionMobileSurface,
    options?: SessionRoutePathOptions,
): string {
    const encodedSessionId = encodeURIComponent(sessionId);
    const searchParams = new URLSearchParams();
    if (surface === 'chat') {
        searchParams.set('mobileSurface', surface);
    }
    const serverId = normalizeRouteQueryValue(options?.serverId);
    if (serverId) {
        searchParams.set('serverId', serverId);
    }
    for (const [key, value] of Object.entries(options?.query ?? {})) {
        if (key === 'serverId' || key === 'mobileSurface') {
            continue;
        }
        const normalized = normalizeRouteQueryValue(value);
        if (normalized) {
            searchParams.set(key, normalized);
        }
    }

    if (surface === 'browse') {
        return appendRouteSearchParams(`/session/${encodedSessionId}/files`, searchParams);
    }
    if (surface === 'git') {
        return appendRouteSearchParams(`/session/${encodedSessionId}/git`, searchParams);
    }
    if (surface === 'tabs') {
        return appendRouteSearchParams(`/session/${encodedSessionId}/details`, searchParams);
    }
    if (surface === 'terminal') {
        return appendRouteSearchParams(`/session/${encodedSessionId}/terminal`, searchParams);
    }
    return appendRouteSearchParams(`/session/${encodedSessionId}`, searchParams);
}

export function resolveSessionCockpitRouteFromPathname(
    pathname: string | null | undefined,
    persistedSurface?: string | null,
    terminalTabAvailable: boolean = true,
    explicitRootSurfaceHint?: string | null,
): Readonly<{ sessionId: string; surface: SessionMobileSurface }> | null {
    const normalizedPathname = typeof pathname === 'string' ? pathname.trim() : '';
    const pathWithoutQuery = normalizedPathname.split(/[?#]/, 1)[0]?.replace(/\/+$/, '') ?? '';
    const match = /^\/session\/([^/]+)(?:\/([^/]+)(?:\/.*)?)?$/.exec(pathWithoutQuery);
    if (!match) {
        return null;
    }

    const [, encodedSessionId, routeSegment] = match;
    const sessionId = decodeURIComponent(encodedSessionId);
    let routeKind: SessionLegacyRouteKind = 'index';
    if (
        routeSegment === 'files'
        || routeSegment === 'git'
        || routeSegment === 'details'
        || routeSegment === 'terminal'
    ) {
        routeKind = routeSegment;
    } else if (typeof routeSegment === 'string') {
        return null;
    }

    const normalizedExplicitRootSurfaceHint = normalizeSessionMobileSurface(explicitRootSurfaceHint);

    return {
        sessionId,
        surface: resolveSessionMobileSurfaceIntent({
            routeKind,
            persistedSurface: routeKind === 'index' && normalizedExplicitRootSurfaceHint
                ? normalizedExplicitRootSurfaceHint
                : persistedSurface,
            terminalTabAvailable,
        }),
    };
}
