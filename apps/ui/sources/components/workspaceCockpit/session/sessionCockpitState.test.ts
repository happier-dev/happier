import { describe, expect, it } from 'vitest';

import {
    resolveSessionCockpitRouteFromPathname,
    resolveSessionMobileSurfaceIntent,
    resolveSessionRightTabIdForSurface,
    resolveSessionRoutePathForSurface,
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
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'index', detailsTargetPresent: true })).toBe('tabs');
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'index' })).toBe('chat');
    });

    it('lets persisted mobile surface state override the default chat fallback', () => {
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'index', persistedSurface: 'tabs' })).toBe('tabs');
        expect(resolveSessionMobileSurfaceIntent({ routeKind: 'index', persistedSurface: 'browse' })).toBe('browse');
        expect(
            resolveSessionMobileSurfaceIntent({
                routeKind: 'index',
                activeRightTabId: 'terminal',
                persistedSurface: 'chat',
                terminalTabAvailable: true,
            }),
        ).toBe('chat');
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

    it('maps cockpit browseable surfaces back to existing right-tab ids', () => {
        expect(resolveSessionRightTabIdForSurface('browse', true)).toBe('files');
        expect(resolveSessionRightTabIdForSurface('git', true)).toBe('git');
        expect(resolveSessionRightTabIdForSurface('terminal', true)).toBe('terminal');
        expect(resolveSessionRightTabIdForSurface('terminal', false)).toBeNull();
        expect(resolveSessionRightTabIdForSurface('chat', true)).toBeNull();
        expect(resolveSessionRightTabIdForSurface('tabs', true)).toBeNull();
    });

    it('builds canonical session cockpit route paths and preserves server scope', () => {
        expect(resolveSessionRoutePathForSurface('session 1', 'chat')).toBe('/session/session%201?mobileSurface=chat');
        expect(resolveSessionRoutePathForSurface('session-1', 'browse', { serverId: 'server-a' })).toBe('/session/session-1/files?serverId=server-a');
        expect(resolveSessionRoutePathForSurface('session-1', 'git', { serverId: 'server-a' })).toBe('/session/session-1/git?serverId=server-a');
        expect(resolveSessionRoutePathForSurface('session-1', 'tabs', { serverId: 'server-a', query: { details: 'file' } })).toBe('/session/session-1/details?serverId=server-a&details=file');
        expect(resolveSessionRoutePathForSurface('session-1', 'terminal', { serverId: 'server-a' })).toBe('/session/session-1/terminal?serverId=server-a');
    });

    it('falls back away from the terminal surface in route parsing when the terminal tab is unavailable', () => {
        expect(
            resolveSessionCockpitRouteFromPathname('/session/session-1/terminal', null, false),
        ).toEqual({
            sessionId: 'session-1',
            surface: 'chat',
        });
    });

    it('lets an explicit root-route surface hint override stale persisted surface state', () => {
        expect(
            resolveSessionCockpitRouteFromPathname('/session/session-1', 'terminal', true, 'chat'),
        ).toEqual({
            sessionId: 'session-1',
            surface: 'chat',
        });
    });
});
