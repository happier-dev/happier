import { resolveNewSessionDraftRouteIdentity } from './newSessionDraftRouteIdentity';

type RouteLike = Readonly<{
    key?: string;
    name?: string;
    path?: string;
    params?: object | undefined;
}>;

type NavigationStateLike = Readonly<{
    index?: number;
    routes?: ReadonlyArray<RouteLike>;
}>;

type RouteParamValue = string | number | null | undefined | Array<string | number>;

type RouteParams = Record<string, RouteParamValue>;
type UnknownRouteParams = Record<string, unknown>;

// Expo Router / React Navigation expose wide generic surface areas here.
// Keep this helper boundary loose and validate only the fields we actually read/write.
type NavigationLike = Readonly<{
    dispatch: (...args: any[]) => unknown;
    getState: () => NavigationStateLike | undefined;
}>;

type RouterLike = Readonly<{
    replace: (...args: any[]) => unknown;
}>;

const NEW_SESSION_PARAM_KEYS = new Set([
    'agent',
    'agentType',
    'automation',
    'automationCronExpr',
    'automationDescription',
    'automationEnabled',
    'automationEveryMinutes',
    'automationName',
    'automationScheduleKind',
    'automationTimezone',
    'dataId',
    'directory',
    'draftId',
    'draftOrigin',
    'machineId',
    'path',
    'profileId',
    'resumeSessionId',
    'secretId',
    'secretRequirementResultId',
    'secretSessionOnlyId',
    'spawnServerId',
    'worktree',
]);

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isRouteParamArray(value: unknown): value is Array<string | number> {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string' || typeof entry === 'number');
}

function isRouteParamValue(value: unknown): value is RouteParamValue {
    return value == null
        || typeof value === 'string'
        || typeof value === 'number'
        || isRouteParamArray(value);
}

function routeIsNestedNewSessionPicker(routeName: string, routePath: string): boolean {
    return routeName.includes('/new/pick') || routeName.includes('(app)/new/pick') || routePath.startsWith('/new/pick');
}

function routeHasExplicitDescriptor(route: RouteLike | null | undefined): boolean {
    if (!route) return false;
    if (isNonEmptyString(route.name) || isNonEmptyString(route.path)) return true;
    return Boolean(route.params && typeof route.params === 'object' && Object.keys(route.params).length > 0);
}

function routeLooksLikeNewSession(route: RouteLike | null | undefined): boolean {
    if (!route) return false;

    const name = String(route.name ?? '').trim().toLowerCase();
    const path = String(route.path ?? '').trim().toLowerCase();
    if (routeIsNestedNewSessionPicker(name, path)) return false;

    if (path === '/new' || path.startsWith('/new?')) return true;
    if (name === 'new' || name === '(app)/new' || name === '(app)/new/index' || name === 'new/index') return true;

    const params = route.params;
    if (!params || typeof params !== 'object') return false;
    for (const key of Object.keys(params)) {
        if (NEW_SESSION_PARAM_KEYS.has(key)) return true;
    }
    return false;
}

export function pickNewSessionRouteParams(params: Readonly<UnknownRouteParams> | null | undefined): RouteParams {
    if (!params) {
        return {};
    }

    const nextParams: RouteParams = {};
    for (const [key, value] of Object.entries(params)) {
        if (!NEW_SESSION_PARAM_KEYS.has(key)) {
            continue;
        }
        if (!isRouteParamValue(value)) {
            continue;
        }
        nextParams[key] = value;
    }

    return nextParams;
}

export function buildNewSessionPickerFallbackHref(params: Readonly<object> | null | undefined): Readonly<{
    pathname: '/new';
    params: RouteParams;
}> {
    const routeParams = pickNewSessionRouteParams(params as UnknownRouteParams | null | undefined);
    const identity = resolveNewSessionDraftRouteIdentity({
        routeDraftId: typeof routeParams.draftId === 'string' ? routeParams.draftId : undefined,
    });
    return {
        pathname: '/new',
        params: {
            ...routeParams,
            draftId: identity.draftId,
        },
    };
}

export function resolveNewSessionPickerReturnRouteKey(state: NavigationStateLike | null | undefined): string | null {
    if (!state || !Array.isArray(state.routes) || state.routes.length === 0) return null;
    const currentIndex = typeof state.index === 'number' ? state.index : state.routes.length - 1;
    const priorRoutes = state.routes.slice(0, Math.max(currentIndex, 0));
    for (let index = priorRoutes.length - 1; index >= 0; index -= 1) {
        const route = priorRoutes[index];
        if (!routeLooksLikeNewSession(route)) continue;
        if (isNonEmptyString(route?.key)) return route.key;
    }

    const currentRoute = state.routes[currentIndex];
    const currentName = String(currentRoute?.name ?? '').trim().toLowerCase();
    const currentPath = String(currentRoute?.path ?? '').trim().toLowerCase();
    if (!routeIsNestedNewSessionPicker(currentName, currentPath)) return null;

    const immediatePreviousRoute = currentIndex > 0 ? state.routes[currentIndex - 1] : null;
    if (!isNonEmptyString(immediatePreviousRoute?.key)) return null;
    if (routeLooksLikeNewSession(immediatePreviousRoute)) return immediatePreviousRoute.key;
    if (!routeHasExplicitDescriptor(immediatePreviousRoute)) return immediatePreviousRoute.key;

    return null;
}

export function setNewSessionPickerReturnParams(params: Readonly<{
    navigation: NavigationLike;
    router: RouterLike;
    routeParams: RouteParams;
    currentParams?: RouteParams;
    replaceParams?: RouteParams;
}>): 'dispatch' | 'replace' {
    const navigationState = params.navigation.getState();
    const targetRouteKey = resolveNewSessionPickerReturnRouteKey(navigationState);
    if (targetRouteKey) {
        params.navigation.dispatch({
            type: 'SET_PARAMS',
            payload: { params: params.routeParams },
            source: targetRouteKey,
        });
        return 'dispatch';
    }

    const currentIndex = typeof navigationState?.index === 'number'
        ? navigationState.index
        : (navigationState?.routes?.length ?? 1) - 1;
    const currentRouteParams = Array.isArray(navigationState?.routes)
        && typeof currentIndex === 'number'
        && currentIndex >= 0
        ? navigationState.routes[currentIndex]?.params as RouteParams | undefined
        : undefined;

    params.router.replace({
        pathname: '/new',
        params: {
            ...pickNewSessionRouteParams(currentRouteParams),
            ...pickNewSessionRouteParams(params.currentParams),
            ...(params.replaceParams ?? {}),
            ...params.routeParams,
        },
    });
    return 'replace';
}
