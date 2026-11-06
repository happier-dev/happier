import type { MobileBottomChromeModel } from './mobileBottomChromeTypes';
import { resolveSessionCockpitRouteFromPathname } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { resolveProjectCockpitRouteFromPathname } from '@/components/workspaceCockpit/project/projectCockpitState';

export function resolveMobileBottomChromeModel(input: Readonly<{
    isAuthenticated: boolean;
    pathname: string | null | undefined;
    mobileWorkspaceExperience: 'classic' | 'cockpit' | null | undefined;
    sessionLastMobileSurfaceBySessionId: Record<string, string> | null | undefined;
    projectLastMobileSurfaceByWorkspaceRefId: Record<string, string> | null | undefined;
    sessionTerminalTabAvailable: boolean;
    explicitMobileSurfaceHint?: string | null;
    /** Kind of the session `details` target in the route (`details=` search param). */
    sessionDetailsKind?: string | null;
    registeredSessionCockpit?: Omit<Extract<MobileBottomChromeModel, { kind: 'sessionCockpit' }>, 'kind'> | null;
}>): MobileBottomChromeModel {
    if (input.isAuthenticated !== true) {
        return { kind: 'hidden' };
    }

    const pathname = typeof input.pathname === 'string' ? input.pathname.trim() : '';
    if (pathname === '/' || isWorkflowsTabRoutePathname(pathname)) {
        return { kind: 'mainAppTabs' };
    }

    if (input.mobileWorkspaceExperience === 'cockpit') {
        if (isImmersiveSessionDetailsRoute(pathname, input.sessionDetailsKind)) {
            // The pushed SCM reading (Walkthrough/Files) owns its own bottom bar and a Back to the chat.
            return { kind: 'hidden' };
        }
        if (!isSessionHistoryRoutePathname(pathname)) {
            const sessionRoute = resolveSessionCockpitRouteFromPathname(
                pathname,
                resolvePersistedSessionSurface(input.sessionLastMobileSurfaceBySessionId, pathname),
                input.sessionTerminalTabAvailable,
                input.explicitMobileSurfaceHint,
            );
            if (sessionRoute) {
                return {
                    kind: 'sessionCockpit',
                    sessionId: sessionRoute.sessionId,
                    surface: sessionRoute.surface,
                    terminalTabAvailable: input.sessionTerminalTabAvailable,
                };
            }
        }

        const projectRoute = resolveProjectCockpitRouteFromPathname(
            pathname,
            resolvePersistedProjectSurface(input.projectLastMobileSurfaceByWorkspaceRefId, pathname),
            input.explicitMobileSurfaceHint,
        );
        if (projectRoute) {
            return {
                kind: 'projectCockpit',
                workspaceRefId: projectRoute.workspaceRefId,
                surface: projectRoute.surface,
            };
        }
        if (input.registeredSessionCockpit) {
            return { kind: 'sessionCockpit', ...input.registeredSessionCockpit };
        }
    }

    return { kind: 'hidden' };
}

function isImmersiveSessionDetailsRoute(pathname: string, detailsKind: string | null | undefined): boolean {
    if (detailsKind !== 'scmReview') return false;
    const pathWithoutQuery = pathname.split(/[?#]/, 1)[0]?.replace(/\/+$/, '') ?? '';
    return /^\/session\/[^/]+\/details$/.test(pathWithoutQuery);
}

/**
 * The Workflows tab's own page (owner Q4). A workflow, run or editor it opens is pushed over it with
 * its own back, as Settings is now pushed from the avatar.
 */
export function isWorkflowsTabRoutePathname(pathname: string): boolean {
    return pathname.split(/[?#]/, 1)[0]!.replace(/\/+$/, '') === '/workflows';
}

function resolvePersistedProjectSurface(
    persistedByWorkspaceRefId: Record<string, string> | null | undefined,
    pathname: string,
): string | null {
    const match = /^\/projects\/([^/]+?)(?:\/|$)/.exec(pathname);
    if (!match) {
        return null;
    }
    const workspaceRefId = decodeURIComponent(match[1] ?? '');
    const persistedSurface = workspaceRefId ? persistedByWorkspaceRefId?.[workspaceRefId] : null;
    return typeof persistedSurface === 'string' ? persistedSurface : null;
}

function isSessionHistoryRoutePathname(pathname: string): boolean {
    return pathname === '/session/recent'
        || pathname === '/session/recent/'
        || pathname === '/session/archived'
        || pathname === '/session/archived/';
}

function resolvePersistedSessionSurface(
    persistedBySessionId: Record<string, string> | null | undefined,
    pathname: string,
): string | null {
    const match = /^\/session\/([^/]+?)(?:\/|$)/.exec(pathname);
    if (!match) {
        return null;
    }
    const sessionId = decodeURIComponent(match[1] ?? '');
    const persistedSurface = sessionId ? persistedBySessionId?.[sessionId] : null;
    return typeof persistedSurface === 'string' ? persistedSurface : null;
}
