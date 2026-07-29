import { describe, expect, it } from 'vitest';

import {
    resolveRightSidebarMobileSurface,
    resolveRightSidebarTabIdForMobileSurface,
} from '@/components/appShell/rightSidebar/rightSidebarMobileProjection';
import { resolveRightSidebarTabs } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import {
    resolveSessionMobileSurfaceIntent,
    resolveSessionCockpitRouteFromPathname,
    resolveSessionRoutePathForSurface,
    resolveSessionRightTabIdForSurface,
    shouldRouteSessionCockpitSurfacePressThroughUrl,
} from './sessionCockpitState';

describe('sessionCockpitState', () => {
    it('maps legacy fullscreen subroutes to cockpit surfaces', () => {
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'files' })).toBe('browse');
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'git' })).toBe('git');
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'details' })).toBe('tabs');
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'terminal', terminalTabAvailable: true })).toBe('terminal');
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'terminal', terminalTabAvailable: false })).toBe('chat');
    });

    it('resolves index-route intent from live pane state before falling back to chat', () => {
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'index', activeRightTabId: 'git' })).toBe('git');
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'index', activeRightTabId: 'files' })).toBe('browse');
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'index', activeRightTabId: 'terminal', terminalTabAvailable: true })).toBe('terminal');
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'index', activeRightTabId: 'browser' })).toBe('browser');
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'index', activeRightTabId: 'services' })).toBe('services');
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'index', activeRightTabId: 'navigation' })).toBe('navigation');
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'index', detailsTargetPresent: true })).toBe('tabs');
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'index' })).toBe('chat');
    });

    it('lets persisted mobile surface state override the default chat fallback', () => {
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'index', persistedSurface: 'tabs' })).toBe('tabs');
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'index', persistedSurface: 'browse' })).toBe('browse');
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'index', persistedSurface: 'browser' })).toBe('browser');
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'index', persistedSurface: 'services' })).toBe('services');
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'index', persistedSurface: 'navigation' })).toBe('navigation');
        expect(
            resolveSessionMobileSurfaceIntent({
                routeKind: 'index',
                activeRightTabId: 'terminal',
                persistedSurface: 'chat',
                terminalTabAvailable: true,
            }),
        ).toBe('chat');
    });

    it('falls back to chat when persisted mobile surface state is stale or unknown', () => {
        expect(
            resolveSessionMobileSurfaceIntent({
                routeKind: 'index',
                persistedSurface: 'preview',
                detailsTargetPresent: true,
                activeRightTabId: 'git',
            }),
        ).toBe('git');
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'index', persistedSurface: 'browser-preview' })).toBe('chat');
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'index', persistedSurface: 'plugin:' })).toBe('chat');
    });

    it('falls back to chat when the persisted terminal surface is unavailable', () => {
        expect(
            resolveSessionMobileSurfaceIntent({
                routeKind: 'index',
                persistedSurface: 'terminal',
                terminalTabAvailable: false,
                detailsTargetPresent: true,
                activeRightTabId: 'files',
            }),
        ).toBe('chat');
    });

    it('maps cockpit browseable surfaces back to shared right-tab ids', () => {
        expect(resolveSessionRightTabIdForSurface('browse', true)).toBe('files');
        expect(resolveSessionRightTabIdForSurface('git', true)).toBe('git');
        expect(resolveSessionRightTabIdForSurface('terminal', true)).toBe('terminal');
        expect(resolveSessionRightTabIdForSurface('terminal', false)).toBeNull();
        expect(resolveSessionRightTabIdForSurface('browser', true)).toBe('browser');
        expect(resolveSessionRightTabIdForSurface('services', true)).toBe('services');
        expect(resolveSessionRightTabIdForSurface('navigation', true)).toBe('navigation');
        expect(resolveSessionRightTabIdForSurface('chat', true)).toBeNull();
        expect(resolveSessionRightTabIdForSurface('tabs', true)).toBeNull();
    });

    it('round-trips the navigation surface through its declared right-sidebar tab', () => {
        const tabs = resolveRightSidebarTabs({
            scope: 'session',
            presentation: 'mobile',
            terminalTabAvailable: true,
        });
        const navigationTab = tabs.find((tab) => tab.id === 'navigation');

        // The registry declaration is the single source: the cockpit surface id and the
        // right-tab id it maps back to must both come from it, not from a local list.
        expect(navigationTab).toBeDefined();
        expect(navigationTab && resolveRightSidebarMobileSurface(navigationTab, 'session')).toBe('navigation');
        expect(resolveSessionRightTabIdForSurface('navigation', true)).toBe(
            resolveRightSidebarTabIdForMobileSurface({ scope: 'session', surface: 'navigation', tabs }),
        );
    });

    it('builds canonical session cockpit route paths for each surface', () => {
        expect(resolveSessionRoutePathForSurface('session-1', 'chat')).toBe('/session/session-1?mobileSurface=chat');
        expect(resolveSessionRoutePathForSurface('session-1', 'browse')).toBe('/session/session-1/files');
        expect(resolveSessionRoutePathForSurface('session-1', 'git')).toBe('/session/session-1/git');
        expect(resolveSessionRoutePathForSurface('session-1', 'tabs')).toBe('/session/session-1/details');
        expect(resolveSessionRoutePathForSurface('session-1', 'terminal')).toBe('/session/session-1/terminal');
        expect(resolveSessionRoutePathForSurface('session-1', 'browser')).toBe('/session/session-1?mobileSurface=browser');
        expect(resolveSessionRoutePathForSurface('session-1', 'services')).toBe('/session/session-1?mobileSurface=services');
        expect(resolveSessionRoutePathForSurface('session-1', 'navigation')).toBe('/session/session-1?mobileSurface=navigation');
    });

    it('preserves scoped route params when building cockpit route paths', () => {
        expect(resolveSessionRoutePathForSurface('session-1', 'chat', {
            serverId: 'server-b',
        })).toBe('/session/session-1?mobileSurface=chat&serverId=server-b');
        expect(resolveSessionRoutePathForSurface('session-1', 'git', {
            serverId: 'server-b',
        })).toBe('/session/session-1/git?serverId=server-b');
        expect(resolveSessionRoutePathForSurface('session-1', 'tabs', {
            serverId: 'server-b',
            query: {
                details: 'file',
                path: 'src/index.ts',
            },
        })).toBe('/session/session-1/details?serverId=server-b&details=file&path=src%2Findex.ts');
    });

    it('falls back away from the terminal surface in route parsing when the terminal tab is unavailable', () => {
        expect(
            resolveSessionCockpitRouteFromPathname('/session/session-1/terminal', null, false),
        ).toEqual({
            sessionId: 'session-1',
            surface: 'chat',
        });
    });

    it('keeps cockpit routing active for nested legacy surface paths', () => {
        expect(resolveSessionCockpitRouteFromPathname('/session/session-1/files/browse')).toEqual({
            sessionId: 'session-1',
            surface: 'browse',
        });
        expect(resolveSessionCockpitRouteFromPathname('/session/session-1/git/diff')).toEqual({
            sessionId: 'session-1',
            surface: 'git',
        });
        expect(resolveSessionCockpitRouteFromPathname('/session/session-1/details/files')).toEqual({
            sessionId: 'session-1',
            surface: 'tabs',
        });
    });

    it('lets an explicit root-route surface hint override stale persisted surface state', () => {
        expect(
            resolveSessionCockpitRouteFromPathname('/session/session-1', 'terminal', true, 'chat'),
        ).toEqual({
            sessionId: 'session-1',
            surface: 'chat',
        });
        expect(
            resolveSessionCockpitRouteFromPathname('/session/session-1', 'git', true, 'browser'),
        ).toEqual({
            sessionId: 'session-1',
            surface: 'browser',
        });
        expect(
            resolveSessionCockpitRouteFromPathname('/session/session-1', 'browser', true, 'services'),
        ).toEqual({
            sessionId: 'session-1',
            surface: 'services',
        });
        expect(
            resolveSessionCockpitRouteFromPathname('/session/session-1', 'chat', true, 'navigation'),
        ).toEqual({
            sessionId: 'session-1',
            surface: 'navigation',
        });
    });

    it('routes tabs presses through the canonical details URL when starting from files', () => {
        expect(shouldRouteSessionCockpitSurfacePressThroughUrl({
            pathname: '/session/session-1/files',
            sessionId: 'session-1',
            surface: 'tabs',
        })).toBe(true);
        expect(shouldRouteSessionCockpitSurfacePressThroughUrl({
            pathname: '/session/session-1/files',
            sessionId: 'session-1',
            surface: 'browse',
        })).toBe(false);
        expect(shouldRouteSessionCockpitSurfacePressThroughUrl({
            pathname: '/session/session-1',
            sessionId: 'session-1',
            surface: 'browser',
            explicitRootSurfaceHint: 'browser',
        })).toBe(false);
    });
});
