import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';

export type MobileSurfaceTransitionOperation = 'push' | 'replace';

export type MobileSurfaceTransitionIntent = Readonly<{
    animation: 'slide_from_left' | 'slide_from_right';
    animationTypeForReplace?: 'push' | 'pop';
    targetPathname: string;
    targetRouteName: string;
}>;

type MobileSurfaceTransitionGroup = 'main' | 'session';
type MainMobileSurface = 'inbox' | 'sessions' | 'friends' | 'settings';
type SessionMobileTransitionSurface = 'chat' | 'browse' | 'git' | 'tabs' | 'terminal';

type ClassifiedMobileSurfaceRoute = Readonly<{
    group: MobileSurfaceTransitionGroup;
    surface: MainMobileSurface | SessionMobileTransitionSurface;
    sessionId?: string;
    routeName: string;
    pathname: string;
}>;

const MOBILE_SURFACE_TRANSITION_TTL_MS = 1_500;

const MAIN_MOBILE_SURFACE_ORDER = ['inbox', 'sessions', 'friends', 'settings'] as const;
const SESSION_MOBILE_SURFACE_ORDER = ['chat', 'browse', 'git', 'tabs', 'terminal'] as const;

const MAIN_ROUTE_BY_PATHNAME = new Map<string, Readonly<{
    surface: MainMobileSurface;
    routeName: string;
}>>([
    ['/', { surface: 'sessions', routeName: 'index' }],
    ['/inbox', { surface: 'inbox', routeName: 'inbox/index' }],
    ['/friends', { surface: 'friends', routeName: 'friends/index' }],
    ['/settings', { surface: 'settings', routeName: 'settings' }],
]);

let pendingMobileSurfaceTransition: (MobileSurfaceTransitionIntent & Readonly<{
    createdAtMs: number;
}>) | null = null;

function normalizePathname(value: string | null | undefined): string {
    const raw = typeof value === 'string' ? value.trim() : '';
    const withoutHash = raw.split('#', 1)[0] ?? '';
    const withoutQuery = withoutHash.split('?', 1)[0] ?? '';
    if (!withoutQuery) return '';
    const withLeadingSlash = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
    if (withLeadingSlash !== '/' && withLeadingSlash.endsWith('/')) {
        return withLeadingSlash.slice(0, -1);
    }
    return withLeadingSlash;
}

function normalizeHrefPathname(href: string): string {
    const trimmed = href.trim();
    if (!trimmed) return '';
    try {
        return normalizePathname(new URL(trimmed, 'happier://app').pathname);
    } catch {
        return normalizePathname(trimmed);
    }
}

function decodeSessionId(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function classifyMainRoute(pathname: string): ClassifiedMobileSurfaceRoute | null {
    const exact = MAIN_ROUTE_BY_PATHNAME.get(pathname);
    if (exact) {
        return {
            group: 'main',
            surface: exact.surface,
            routeName: exact.routeName,
            pathname,
        };
    }

    for (const [rootPathname, route] of MAIN_ROUTE_BY_PATHNAME.entries()) {
        if (rootPathname === '/') continue;
        if (pathname.startsWith(`${rootPathname}/`)) {
            return {
                group: 'main',
                surface: route.surface,
                routeName: route.routeName,
                pathname,
            };
        }
    }

    return null;
}

function classifySessionRoute(pathname: string): ClassifiedMobileSurfaceRoute | null {
    const match = /^\/session\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
    if (!match?.[1]) return null;

    const routeSegment = match[2] ?? '';
    const sessionId = decodeSessionId(match[1]);
    let surface: SessionMobileTransitionSurface;
    let routeName: string;

    if (routeSegment === '') {
        surface = 'chat';
        routeName = 'session/[id]/index';
    } else if (routeSegment === 'files') {
        surface = 'browse';
        routeName = 'session/[id]/files';
    } else if (routeSegment === 'git') {
        surface = 'git';
        routeName = 'session/[id]/git';
    } else if (routeSegment === 'details') {
        surface = 'tabs';
        routeName = 'session/[id]/details';
    } else if (routeSegment === 'file') {
        surface = 'tabs';
        routeName = 'session/[id]/file';
    } else if (routeSegment === 'commit') {
        surface = 'tabs';
        routeName = 'session/[id]/commit';
    } else if (routeSegment === 'terminal') {
        surface = 'terminal';
        routeName = 'session/[id]/terminal';
    } else {
        return null;
    }

    return {
        group: 'session',
        surface,
        sessionId,
        routeName,
        pathname,
    };
}

function classifyRoute(pathname: string): ClassifiedMobileSurfaceRoute | null {
    return classifyMainRoute(pathname) ?? classifySessionRoute(pathname);
}

function resolveSurfaceOrder(route: ClassifiedMobileSurfaceRoute): readonly string[] {
    return route.group === 'main'
        ? MAIN_MOBILE_SURFACE_ORDER
        : SESSION_MOBILE_SURFACE_ORDER;
}

function areSiblingSurfaces(
    current: ClassifiedMobileSurfaceRoute,
    target: ClassifiedMobileSurfaceRoute,
): boolean {
    if (current.group !== target.group) return false;
    if (current.group === 'session' && current.sessionId !== target.sessionId) return false;
    return true;
}

function resolveReplaceAnimationType(animation: MobileSurfaceTransitionIntent['animation']): 'push' | 'pop' {
    return animation === 'slide_from_right' ? 'push' : 'pop';
}

export function resolveMobileSurfaceTransitionIntent(input: Readonly<{
    currentPathname: string | null | undefined;
    targetHref: string;
    operation: MobileSurfaceTransitionOperation;
}>): MobileSurfaceTransitionIntent | null {
    const currentPathname = normalizePathname(input.currentPathname);
    const targetPathname = normalizeHrefPathname(input.targetHref);
    if (!currentPathname || !targetPathname) return null;

    const current = classifyRoute(currentPathname);
    const target = classifyRoute(targetPathname);
    if (!current || !target) return null;
    if (!areSiblingSurfaces(current, target)) return null;

    const order = resolveSurfaceOrder(current);
    const currentIndex = order.indexOf(current.surface);
    const targetIndex = order.indexOf(target.surface);
    if (currentIndex < 0 || targetIndex < 0 || currentIndex === targetIndex) {
        return null;
    }

    const animation: MobileSurfaceTransitionIntent['animation'] =
        targetIndex > currentIndex ? 'slide_from_right' : 'slide_from_left';

    return {
        animation,
        ...(input.operation === 'replace' ? { animationTypeForReplace: resolveReplaceAnimationType(animation) } : {}),
        targetPathname,
        targetRouteName: target.routeName,
    };
}

export function prepareMobileSurfaceTransition(input: Readonly<{
    currentPathname: string | null | undefined;
    targetHref: string;
    operation: MobileSurfaceTransitionOperation;
    nowMs?: number;
}>): MobileSurfaceTransitionIntent | null {
    const intent = resolveMobileSurfaceTransitionIntent(input);
    pendingMobileSurfaceTransition = intent
        ? {
            ...intent,
            createdAtMs: input.nowMs ?? Date.now(),
        }
        : null;
    return intent;
}

export function clearPendingMobileSurfaceTransition(): void {
    pendingMobileSurfaceTransition = null;
}

export function clearPendingMobileSurfaceTransitionForPathname(
    pathname: string | null | undefined,
    nowMs: number = Date.now(),
): void {
    if (!pendingMobileSurfaceTransition) return;

    if (nowMs - pendingMobileSurfaceTransition.createdAtMs > MOBILE_SURFACE_TRANSITION_TTL_MS) {
        clearPendingMobileSurfaceTransition();
        return;
    }

    if (normalizePathname(pathname) === pendingMobileSurfaceTransition.targetPathname) {
        clearPendingMobileSurfaceTransition();
    }
}

export function resolvePendingMobileSurfaceTransitionStackOptions(input: Readonly<{
    routeName: string | null | undefined;
    nowMs?: number;
}>): NativeStackNavigationOptions {
    if (!pendingMobileSurfaceTransition) return {};

    const nowMs = input.nowMs ?? Date.now();
    if (nowMs - pendingMobileSurfaceTransition.createdAtMs > MOBILE_SURFACE_TRANSITION_TTL_MS) {
        clearPendingMobileSurfaceTransition();
        return {};
    }

    if (input.routeName !== pendingMobileSurfaceTransition.targetRouteName) {
        return {};
    }

    return {
        animation: pendingMobileSurfaceTransition.animation,
        ...(pendingMobileSurfaceTransition.animationTypeForReplace
            ? { animationTypeForReplace: pendingMobileSurfaceTransition.animationTypeForReplace }
            : {}),
    };
}
