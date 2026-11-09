import type { MobileBottomChromeModel } from './mobileBottomChromeTypes';

export function resolveMobileBottomChromeModel(input: Readonly<{
    isAuthenticated: boolean;
    pathname: string | null | undefined;
    mobileWorkspaceExperience: 'classic' | 'cockpit' | null | undefined;
    explicitMobileSurfaceHint?: string | null;
    /** Kind of the session `details` target in the route (`details=` search param). */
    sessionDetailsKind?: string | null;
    mountedDetail?: Omit<Extract<MobileBottomChromeModel, { kind: 'detail' }>, 'kind'> | null;
    rootHostedDetail?: boolean;
    /** A section or More destination claims this route (the destination catalog's answer), Settings aside. */
    sectionPage?: boolean;
}>): MobileBottomChromeModel {
    if (input.isAuthenticated !== true) {
        return { kind: 'hidden' };
    }
    // A plugin detail can be hosted on the app's root route.
    if (input.mobileWorkspaceExperience === 'cockpit' && input.mountedDetail && input.rootHostedDetail) {
        return { kind: 'detail', ...input.mountedDetail };
    }

    const pathname = typeof input.pathname === 'string' ? input.pathname.trim() : '';
    if (pathname === '/' || isWorkflowsTabRoutePathname(pathname)) {
        return { kind: 'mainAppTabs' };
    }

    if (input.mobileWorkspaceExperience === 'cockpit') {
        if (input.mountedDetail?.pageKind === 'session'
            && isImmersiveSessionDetailsRoute(pathname, input.sessionDetailsKind, input.mountedDetail.activeId)) {
            // The pushed SCM reading (Walkthrough/Files) owns its own bottom bar and a Back to the chat.
            return { kind: 'hidden' };
        }
        // Session history is a Sessions list: a retained Session's bar never stands over it.
        if (input.mountedDetail && !isSessionHistoryRoutePathname(pathname)) return { kind: 'detail', ...input.mountedDetail };
    }

    // The bar is coherent on every page (owner 11-06): a page a section or More destination claims keeps the
    // main bar, pushed details included. A page whose detail host draws its own bar waits for that host
    // instead, so its bar never shows the main bar first; Classic keeps those pages bar-free.
    if (input.sectionPage === true && !isDetailHostRoutePathname(pathname)) return { kind: 'mainAppTabs' };
    return { kind: 'hidden' };
}

/**
 * Pages whose detail host draws its own bar once mounted: a Session (not its history lists), a Project (not
 * its open and sources pickers), a Discussion, a Machine, a Workflow's editor or runs, an Environment.
 */
const DETAIL_HOST_ROUTE = /^\/(?:session\/(?!recent$|archived$)[^/]+|projects\/(?!open$|sources$|deployments$)[^/]+|discussions\/(?!new$)[^/]+|machines\/(?!managed(?:\/|$))[^/]+|workflows\/.+|deployments\/[^/]+)/;

function isDetailHostRoutePathname(pathname: string): boolean {
    return DETAIL_HOST_ROUTE.test(normalizeRoutePath(pathname));
}

function normalizeRoutePath(pathname: string): string {
    const path = pathname.split(/[?#]/, 1)[0]!.replace(/\/+$/, '');
    return path === '' ? '/' : path;
}

/**
 * Where a main-tab press goes: the tab's route when the page shown is anything else (a pushed detail, a More
 * destination, another tab's own page), and nowhere when the tab's page is already shown.
 */
export function resolveMainTabPressRoute(input: Readonly<{ pathname: string | null | undefined; targetRoute: string }>): string | null {
    if (typeof input.pathname !== 'string') return null;
    return normalizeRoutePath(input.pathname) === normalizeRoutePath(input.targetRoute) ? null : input.targetRoute;
}

/**
 * The SCM reading presented as the Session's Details: on its pushed `/details` route, or on the Session's root route
 * while the cockpit shows it on Tabs (a window narrowed to a phone keeps the route it had).
 */
function isImmersiveSessionDetailsRoute(
    pathname: string,
    detailsKind: string | null | undefined,
    registeredSurface: string | undefined,
): boolean {
    if (detailsKind !== 'scmReview') return false;
    const pathWithoutQuery = pathname.split(/[?#]/, 1)[0]?.replace(/\/+$/, '') ?? '';
    return /^\/session\/[^/]+\/details$/.test(pathWithoutQuery)
        || (registeredSurface === 'tabs' && /^\/session\/[^/]+$/.test(pathWithoutQuery));
}

/**
 * The Workflows tab's own page (owner Q4). A workflow, run or editor it opens is pushed over it with
 * its own back, as Settings is now pushed from the avatar.
 */
export function isWorkflowsTabRoutePathname(pathname: string): boolean {
    return pathname.split(/[?#]/, 1)[0]!.replace(/\/+$/, '') === '/workflows';
}

function isSessionHistoryRoutePathname(pathname: string): boolean {
    return pathname === '/session/recent'
        || pathname === '/session/recent/'
        || pathname === '/session/archived'
        || pathname === '/session/archived/';
}
