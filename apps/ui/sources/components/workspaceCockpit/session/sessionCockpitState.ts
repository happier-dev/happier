import type { SessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';

export type SessionPluginMobileSurface = `plugin:${string}:${string}`;
export type SessionMobileSurface =
    | 'chat'
    | 'browse'
    | 'git'
    | 'navigation'
    | 'companion'
    | 'board'
    | 'agents'
    | 'collaboration'
    | 'skills'
    | 'tabs'
    | 'browser'
    | 'services'
    | 'terminal'
    | SessionPluginMobileSurface;
export type SessionLegacyRouteKind = 'index' | 'files' | 'git' | 'details' | 'terminal';

type SessionRightTabId = 'git' | 'files' | 'navigation' | 'agents' | 'collaboration' | 'skills' | 'board' | 'terminal' | 'browser' | 'services' | SessionPluginMobileSurface;
type SessionRoutePathQueryValue = string | number | boolean | null | undefined;

type SessionRoutePathOptions = Readonly<{
    serverId?: string | null;
    query?: Readonly<Record<string, SessionRoutePathQueryValue>>;
}>;

/**
 * The one place a persisted / routed / navigator-supplied surface string becomes a
 * `SessionMobileSurface`. Everything that accepts a surface from outside the type system —
 * persistence, deep links, the cockpit tab navigator's route names — goes through here, so a
 * newly declared surface becomes reachable by extending this list once.
 */
export function normalizeSessionMobileSurface(value: string | null | undefined): SessionMobileSurface | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (
        normalized === 'chat'
        || normalized === 'browse'
        || normalized === 'git'
        || normalized === 'navigation'
        || normalized === 'companion'
        || normalized === 'board'
        || normalized === 'agents'
        || normalized === 'collaboration'
        || normalized === 'skills'
        || normalized === 'tabs'
        || normalized === 'browser'
        || normalized === 'services'
        || normalized === 'terminal'
    ) {
        return normalized;
    }
    if (isSessionPluginMobileSurface(normalized)) {
        return normalized;
    }
    return null;
}

/**
 * Companion's full presentation is the existing Cockpit destination. An
 * explicit Companion route therefore selects that host even when the viewer's
 * normal Session experience is classic (for example a narrow desktop window
 * where the reserved rail cannot fit). Other route hints retain the person's
 * normal experience choice.
 */
export function shouldUseSessionCockpitExperience(input: Readonly<{
    cockpitEnabled: boolean;
    explicitSurface: string | null | undefined;
    /**
     * Whether the route resolved to an exact qualified Session address.
     * Companion's first-party Session Summary is composed from Session facts
     * alone, so an unresolvable link cannot claim the Cockpit experience;
     * omitted means unresolved. Board content inside Companion still follows
     * the exact Home's `sessions.board` decision at the Board owner.
     */
    companionAddressQualified?: boolean;
}>): boolean {
    return input.cockpitEnabled
        || (input.companionAddressQualified === true
            && normalizeSessionMobileSurface(input.explicitSurface) === 'companion');
}

export function isSessionPluginMobileSurface(value: string): value is SessionPluginMobileSurface {
    return /^plugin:[^:]+:.+$/.test(value);
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

function appendRouteSearchParams<TPath extends string>(basePath: TPath, params: URLSearchParams): TPath | `${TPath}?${string}` {
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
    if (surface === 'browser') {
        return 'browser';
    }
    if (surface === 'services') {
        return 'services';
    }
    if (surface === 'navigation') {
        return 'navigation';
    }
    if (surface === 'agents') {
        return 'agents';
    }
    if (surface === 'collaboration') {
        return 'collaboration';
    }
    if (surface === 'skills') return 'skills';
    if (surface === 'board') {
        return 'board';
    }
    if (surface === 'chat' || surface === 'tabs' || surface === 'companion') {
        return null;
    }
    if (isSessionPluginMobileSurface(surface)) {
        return surface;
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
    if (input.activeRightTabId === 'browser') {
        return 'browser';
    }
    if (input.activeRightTabId === 'services') {
        return 'services';
    }
    if (input.activeRightTabId === 'navigation') {
        return 'navigation';
    }
    if (input.activeRightTabId === 'agents') {
        return 'agents';
    }
    if (input.activeRightTabId === 'collaboration') {
        return 'collaboration';
    }
    if (input.activeRightTabId === 'skills') return 'skills';
    if (input.activeRightTabId === 'board') {
        return 'board';
    }
    if (input.activeRightTabId && isSessionPluginMobileSurface(input.activeRightTabId)) {
        return input.activeRightTabId;
    }
    if (input.detailsTargetPresent === true) {
        return 'tabs';
    }

    return 'chat';
}

/**
 * A phone docks the Session's viewer into Chat's reading flow, so a cockpit that mounts while the
 * viewer is presented (a desktop window narrowed to a phone width, say) opens on Chat instead of a
 * retained projection that would hide it.
 */
export function resolveSessionCockpitLandingSurface(
    requestedSurface: SessionMobileSurface,
    viewerPresenting: boolean,
): SessionMobileSurface {
    return viewerPresenting ? 'chat' : requestedSurface;
}

/**
 * The route of a phone cockpit surface: always the Session's own route, the surface in its `mobileSurface` query
 * (owner 2026-11-17). Every cockpit tab is a peer view of that one route, so a tab press replaces only its query and
 * the retained cockpit keeps its scenes. The one exception is a Tabs link that names a Details page
 * (`details=…`): that page is its own destination (`/session/<id>/details`, see `buildSessionDetailsTabHref`).
 */
export function resolveSessionRoutePathForSurface(
    sessionId: string,
    surface: SessionMobileSurface,
    options?: SessionRoutePathOptions,
): `/session/${string}` {
    const detailsPage = surface === 'tabs' && normalizeRouteQueryValue(options?.query?.details) !== null;
    return buildSessionRoutePath(sessionId, detailsPage ? 'details' : null, detailsPage ? null : surface, options);
}

/**
 * The classic (non-cockpit) phone's full-screen pane screens: `/session/<id>/files|git|terminal`. The cockpit never
 * routes here; on a cockpit these legacy links redirect to their surface (`resolveSessionCockpitLegacyLeafRedirect`).
 */
export function resolveSessionPaneScreenRoutePath(
    sessionId: string,
    surface: 'browse' | 'git' | 'terminal',
    options?: SessionRoutePathOptions,
): `/session/${string}` {
    return buildSessionRoutePath(sessionId, surface === 'browse' ? 'files' : surface, null, options);
}

function buildSessionRoutePath(
    sessionId: string,
    leaf: Exclude<SessionLegacyRouteKind, 'index'> | null,
    mobileSurface: SessionMobileSurface | null,
    options?: SessionRoutePathOptions,
): `/session/${string}` {
    const searchParams = new URLSearchParams();
    if (mobileSurface) searchParams.set('mobileSurface', mobileSurface);
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
    const basePath = `/session/${encodeURIComponent(sessionId)}${leaf ? `/${leaf}` : ''}` as const;
    return appendRouteSearchParams(basePath, searchParams);
}

/**
 * Where an old cockpit tab link (`/session/<id>/files|git|terminal`, or a `/details` link that names no page) lands on
 * a phone cockpit: its surface on the Session route, keeping the link's other query. Null for every other leaf,
 * including a Details page link. The route leaves call this once through `useSessionCockpitLegacyLeafRedirect`.
 */
export function resolveSessionCockpitLegacyLeafRedirect(input: Readonly<{
    leaf: string;
    sessionId: string;
    params: Readonly<Record<string, unknown>>;
    terminalTabAvailable: boolean;
}>): `/session/${string}` | null {
    const { leaf } = input;
    if (leaf !== 'files' && leaf !== 'git' && leaf !== 'terminal' && leaf !== 'details') return null;
    if (leaf === 'details' && normalizeRouteQueryValue(input.params.details) !== null) return null;
    const surface = resolveSessionMobileSurfaceIntent({ routeKind: leaf, terminalTabAvailable: input.terminalTabAvailable });
    const { id: _id, serverId, ...query } = input.params;
    return resolveSessionRoutePathForSurface(input.sessionId, surface, {
        serverId: typeof serverId === 'string' ? serverId : null,
        query: Object.fromEntries(Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    });
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

export function shouldRouteSessionCockpitSurfacePressThroughUrl(input: Readonly<{
    pathname: string | null | undefined;
    sessionId: string;
    surface: SessionMobileSurface;
    terminalTabAvailable?: boolean;
    explicitRootSurfaceHint?: string | null;
    paneUrlState?: SessionPaneUrlState | null;
}>): boolean {
    const currentRoute = resolveSessionCockpitRouteFromPathname(
        input.pathname,
        null,
        input.terminalTabAvailable ?? true,
        input.explicitRootSurfaceHint,
    );
    if (!currentRoute || currentRoute.sessionId !== input.sessionId) {
        return true;
    }
    // Tabs presents a page through the phone rail owner, or the existing empty scene when there is no page.
    // Neither presentation changes the Session tab's route, including the navigator's later state-change echo.
    if (input.surface === 'tabs') return false;
    // A root URL carrying desktop pane intent still needs the phone route
    // projection, even when the selected tab already matches that intent.
    if (isSessionRootRoutePath(input.pathname, input.sessionId)
        && (input.paneUrlState?.details || input.paneUrlState?.rightTabId || input.paneUrlState?.bottomTabId)) return true;
    return currentRoute.surface !== input.surface;
}

/** Whether the pathname is the Session's root route (`/session/<id>`), whatever its query. */
export function isSessionRootRoutePath(pathname: string | null | undefined, sessionId: string): boolean {
    const path = pathname?.split(/[?#]/, 1)[0]?.replace(/\/+$/, '');
    return path === `/session/${encodeURIComponent(sessionId)}`;
}

/**
 * The phone surface a Session URL's desktop pane intent asks for (an open Details page presents on Tabs, a right
 * sidebar tab on its own surface), or null when the URL carries none. The cockpit navigator consumes it once.
 */
export function resolveSessionPaneIntentSurface(
    paneUrlState: SessionPaneUrlState | null | undefined,
    terminalTabAvailable: boolean,
    explicitRootSurfaceHint?: string | null,
): SessionMobileSurface | null {
    if (!paneUrlState?.details && !paneUrlState?.rightTabId) return null;
    return resolveSessionMobileSurfaceIntent({
        routeKind: 'index',
        detailsTargetPresent: paneUrlState.details !== undefined,
        activeRightTabId: paneUrlState.details ? null : paneUrlState.rightTabId,
        // A URL that names its own surface asks for that surface; the sidebar tab it still carries is retained layout.
        persistedSurface: explicitRootSurfaceHint,
        terminalTabAvailable,
    });
}
