import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';

export type SessionMobileSurface = 'chat' | 'browse' | 'git' | 'tabs' | 'terminal';
export type SessionLegacyRouteKind = 'index' | 'files' | 'git' | 'details' | 'terminal';

type SessionRightTabId = 'git' | 'files' | 'terminal';
type SessionRouteQueryValue = string | number | boolean | null | undefined;

function normalizeSessionMobileSurface(value: string | null | undefined): SessionMobileSurface | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized === 'chat' || normalized === 'browse' || normalized === 'git' || normalized === 'tabs' || normalized === 'terminal') {
        return normalized;
    }
    return null;
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
    options: Readonly<{
        serverId?: string | null;
        query?: Readonly<Record<string, SessionRouteQueryValue>>;
    }> = {},
): string {
    const query = surface === 'chat'
        ? { ...options.query, mobileSurface: surface }
        : options.query;
    const suffix =
        surface === 'browse'
            ? '/files'
            : surface === 'git'
                ? '/git'
                : surface === 'tabs'
                    ? '/details'
                    : surface === 'terminal'
                        ? '/terminal'
                        : undefined;

    return buildScopedSessionRouteHref({
        sessionId,
        serverId: options.serverId,
        suffix,
        query,
    });
}

export function resolveSessionCockpitRouteFromPathname(
    pathname: string | null | undefined,
    persistedSurface?: string | null,
    terminalTabAvailable: boolean = true,
    explicitRootSurfaceHint?: string | null,
): Readonly<{ sessionId: string; surface: SessionMobileSurface }> | null {
    const normalizedPathname = typeof pathname === 'string' ? pathname.trim() : '';
    const match = /^\/session\/([^/]+?)(?:\/(files|git|details|terminal))?$/.exec(normalizedPathname);
    if (!match) {
        return null;
    }

    const [, encodedSessionId, routeSegment] = match;
    const sessionId = decodeURIComponent(encodedSessionId);
    const routeKind: SessionLegacyRouteKind =
        routeSegment === 'files'
            ? 'files'
            : routeSegment === 'git'
                ? 'git'
                : routeSegment === 'details'
                    ? 'details'
                    : routeSegment === 'terminal'
                        ? 'terminal'
                        : 'index';

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
