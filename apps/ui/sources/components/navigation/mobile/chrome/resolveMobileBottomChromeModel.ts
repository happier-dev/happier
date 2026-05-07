import type { TabType } from '@/components/ui/navigation/tabTypes';
import { normalizeMobileWorkspaceExperience } from '@/components/workspaceCockpit/mobileWorkspaceExperience';
import { resolveSessionCockpitRouteFromPathname } from '@/components/workspaceCockpit/session/sessionCockpitState';

import type { MobileBottomChromeModel } from './mobileBottomChromeTypes';

function resolveMainAppTab(pathname: string): TabType | null {
    if (pathname === '/') return 'sessions';
    if (pathname === '/settings' || pathname.startsWith('/settings/')) return 'settings';
    if (pathname === '/inbox' || pathname.startsWith('/inbox/')) return 'inbox';
    if (pathname === '/friends' || pathname.startsWith('/friends/')) return 'friends';
    return null;
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

export function resolveMobileBottomChromeModel(input: Readonly<{
    isAuthenticated: boolean;
    pathname: string | null | undefined;
    mobileWorkspaceExperience: 'classic' | 'cockpit' | null | undefined;
    sessionLastMobileSurfaceBySessionId: Record<string, string> | null | undefined;
    sessionTerminalTabAvailable: boolean;
    explicitMobileSurfaceHint?: string | null;
}>): MobileBottomChromeModel {
    if (input.isAuthenticated !== true) {
        return { kind: 'hidden' };
    }

    const pathname = typeof input.pathname === 'string' ? input.pathname.trim() : '';
    const mainAppTab = resolveMainAppTab(pathname);
    if (mainAppTab) {
        return { kind: 'mainAppTabs', activeTab: mainAppTab };
    }

    if (normalizeMobileWorkspaceExperience(input.mobileWorkspaceExperience) !== 'cockpit') {
        return { kind: 'hidden' };
    }

    if (isSessionHistoryRoutePathname(pathname)) {
        return { kind: 'hidden' };
    }

    const sessionRoute = resolveSessionCockpitRouteFromPathname(
        pathname,
        resolvePersistedSessionSurface(input.sessionLastMobileSurfaceBySessionId, pathname),
        input.sessionTerminalTabAvailable,
        input.explicitMobileSurfaceHint,
    );
    if (!sessionRoute) {
        return { kind: 'hidden' };
    }

    return {
        kind: 'sessionCockpit',
        sessionId: sessionRoute.sessionId,
        surface: sessionRoute.surface,
        terminalTabAvailable: input.sessionTerminalTabAvailable,
    };
}
