import {
    resolveSessionRoutePathForSurface,
    type SessionMobileSurface,
} from './sessionCockpitState';

export type SessionDetailsSourceSurface = Exclude<SessionMobileSurface, 'tabs'>;

type SessionRouteQueryValue = string | number | boolean | null | undefined;

type SessionCockpitRouter = Readonly<{
    back: () => void;
    replace: (href: string) => void;
    canGoBack?: () => boolean;
}>;

type SessionCockpitNavigation = Readonly<{
    canGoBack?: () => boolean;
    goBack?: () => void;
    getState?: () => Readonly<{
        index?: number;
        routes?: ReadonlyArray<unknown>;
    }> | undefined;
}>;

export type SessionCockpitSurfaceSwitchPlan = Readonly<{
    kind: 'replace';
    targetHref: string;
}> | Readonly<{
    kind: 'collapseDetailsThenReplace';
    targetHref: string;
    sourceDetailsPathname: string;
}>;

export function normalizeSessionDetailsSourceSurface(value: unknown): SessionDetailsSourceSurface | null {
    const raw = Array.isArray(value) ? value[0] : value;
    const normalized = typeof raw === 'string' ? raw.trim() : '';
    if (normalized === 'chat' || normalized === 'browse' || normalized === 'git' || normalized === 'terminal') {
        return normalized;
    }
    return null;
}

export function resolveSessionDetailsSourceSurface(surface: SessionMobileSurface): SessionDetailsSourceSurface | null {
    return surface === 'tabs' ? null : surface;
}

export function buildSessionDetailsRouteQuery(
    query: Readonly<Record<string, SessionRouteQueryValue>>,
    sourceSurface: SessionDetailsSourceSurface | null,
): Readonly<Record<string, SessionRouteQueryValue>> {
    if (!sourceSurface) {
        return query;
    }
    return {
        ...query,
        sourceSurface,
    };
}

export function resolveSessionDetailsFallbackHref(input: Readonly<{
    sessionId: string;
    serverId?: string | null;
    sourceSurface?: unknown;
    fallbackHref: string;
}>): string {
    const sourceSurface = normalizeSessionDetailsSourceSurface(input.sourceSurface);
    if (!sourceSurface) {
        return input.fallbackHref;
    }

    return resolveSessionRoutePathForSurface(input.sessionId, sourceSurface, {
        serverId: input.serverId,
    });
}

function isSessionDetailsRoutePathname(pathname: string | null | undefined): pathname is string {
    const normalized = typeof pathname === 'string' ? pathname.trim() : '';
    return /^\/session\/[^/]+\/details\/?$/.test(normalized);
}

export function resolveSessionCockpitSurfaceSwitchPlan(input: Readonly<{
    sessionId: string;
    targetSurface: SessionMobileSurface;
    serverId?: string | null;
    currentPathname?: string | null;
    currentDetailsSourceSurface?: unknown;
}>): SessionCockpitSurfaceSwitchPlan {
    const targetHref = resolveSessionRoutePathForSurface(input.sessionId, input.targetSurface, {
        serverId: input.serverId,
    });
    const currentDetailsSourceSurface = normalizeSessionDetailsSourceSurface(input.currentDetailsSourceSurface);
    const currentPathname = typeof input.currentPathname === 'string' ? input.currentPathname.trim() : '';
    const shouldCollapseDetailsRoute =
        currentDetailsSourceSurface !== null
        && input.targetSurface !== 'tabs'
        && isSessionDetailsRoutePathname(currentPathname);

    if (!shouldCollapseDetailsRoute) {
        return { kind: 'replace', targetHref };
    }

    return {
        kind: 'collapseDetailsThenReplace',
        targetHref,
        sourceDetailsPathname: currentPathname,
    };
}

function resolveCanGoBack(
    router: SessionCockpitRouter,
    navigation?: SessionCockpitNavigation | null,
): boolean {
    const routerCanGoBack = typeof router.canGoBack === 'function'
        ? router.canGoBack()
        : null;
    const navigationCanGoBack = typeof navigation?.canGoBack === 'function'
        ? navigation.canGoBack()
        : null;
    const navigationStateCanGoBack = typeof navigation?.getState === 'function'
        ? (() => {
            const state = navigation.getState();
            if (!state || typeof state.index !== 'number' || !Array.isArray(state.routes)) return null;
            return state.index > 0 && state.routes.length > 1;
        })()
        : null;

    if (routerCanGoBack === false || navigationCanGoBack === false) {
        return false;
    }

    return routerCanGoBack ?? navigationCanGoBack ?? navigationStateCanGoBack ?? true;
}

export function collapseSessionDetailsRouteBeforeSurfaceSwitch(input: Readonly<{
    router: SessionCockpitRouter;
    navigation?: SessionCockpitNavigation | null;
}>): boolean {
    if (!resolveCanGoBack(input.router, input.navigation)) {
        return false;
    }

    goBack(input.router, input.navigation);
    return true;
}

function goBack(
    router: SessionCockpitRouter,
    navigation?: SessionCockpitNavigation | null,
): void {
    const navigationCanGoBack = typeof navigation?.canGoBack === 'function'
        ? navigation.canGoBack()
        : null;
    const navigationStateCanGoBack = typeof navigation?.getState === 'function'
        ? (() => {
            const state = navigation.getState();
            if (!state || typeof state.index !== 'number' || !Array.isArray(state.routes)) return null;
            return state.index > 0 && state.routes.length > 1;
        })()
        : null;

    if (typeof navigation?.goBack === 'function' && (navigationCanGoBack === true || navigationStateCanGoBack === true)) {
        navigation.goBack();
        return;
    }

    router.back();
}
