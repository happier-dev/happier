import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    return {
        ...original,
        areServerProfileIdentifiersEquivalent: (leftRaw: string | null | undefined, rightRaw: string | null | undefined) => {
            const left = String(leftRaw ?? '').trim();
            const right = String(rightRaw ?? '').trim();
            if (!left || !right) return false;
            if (left === right) return true;
            return [left, right].sort().join('\u0000') === ['server-actual', 'server-alias'].sort().join('\u0000');
        },
        resolveServerProfileScopeIdForIdentifier: (serverIdRaw: string | null | undefined) => {
            const serverId = String(serverIdRaw ?? '').trim();
            return serverId === 'server-profile' ? 'server-actual' : serverId;
        },
    };
});

import {
    clearFocusedSessionId,
    clearRouteAnchorSessionId,
    getSessionSurfaceVisibilitySnapshot,
    isSessionSurfaceVisible,
    markSessionSurfaceHidden,
    markSessionSurfaceVisible,
    resetSessionSurfaceVisibilityForTests,
    setFocusedSessionId,
    setRouteAnchorSessionId,
} from './sessionSurfaceVisibility';

describe('sessionSurfaceVisibility', () => {
    beforeEach(() => {
        resetSessionSurfaceVisibilityForTests();
    });

    it('tracks visible, focused, and route-anchor session ids independently', () => {
        markSessionSurfaceVisible('session-1');
        markSessionSurfaceVisible('session-2');
        setFocusedSessionId('session-2');
        setRouteAnchorSessionId('session-1');

        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: 'session-2',
            routeAnchorSessionId: 'session-1',
            visibleSessionIds: ['session-1', 'session-2'],
        });
    });

    it('uses reference counting for visible sessions and only clears matching focus state', () => {
        markSessionSurfaceVisible('session-1');
        markSessionSurfaceVisible('session-1');
        setFocusedSessionId('session-1');
        setRouteAnchorSessionId('session-1');

        markSessionSurfaceHidden('session-1');
        clearFocusedSessionId('session-2');
        clearRouteAnchorSessionId('session-2');

        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: 'session-1',
            routeAnchorSessionId: 'session-1',
            visibleSessionIds: ['session-1'],
        });

        markSessionSurfaceHidden('session-1');

        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: 'session-1',
            routeAnchorSessionId: 'session-1',
            visibleSessionIds: [],
        });

        clearFocusedSessionId('session-1');
        clearRouteAnchorSessionId('session-1');

        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: null,
            routeAnchorSessionId: null,
            visibleSessionIds: [],
        });
    });

    it('falls back to unscoped visibility only before a session has scoped visibility', () => {
        markSessionSurfaceVisible('session-1');

        expect(isSessionSurfaceVisible('session-1', 'server-a')).toBe(true);

        markSessionSurfaceVisible('session-2', 'server-a');

        expect(isSessionSurfaceVisible('session-2', 'server-a')).toBe(true);
        expect(isSessionSurfaceVisible('session-2', 'server-b')).toBe(false);
    });

    it('canonicalizes profile ids to learned server identity ids for scoped visibility', () => {
        markSessionSurfaceVisible('session-1', 'server-actual');

        expect(isSessionSurfaceVisible('session-1', 'server-profile')).toBe(true);
        expect(isSessionSurfaceVisible('session-1', 'server-unrelated')).toBe(false);
    });

    it('clears stale visibility state when the app route leaves session screens', async () => {
        const { clearSessionSurfaceVisibilityForNonSessionRoute } = await import('./sessionSurfaceVisibility');

        markSessionSurfaceVisible('session-1', 'server-actual');
        setFocusedSessionId('session-1');
        setRouteAnchorSessionId('session-1');

        expect(clearSessionSurfaceVisibilityForNonSessionRoute('/session/session-1')).toBe(false);
        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: 'session-1',
            routeAnchorSessionId: 'session-1',
            visibleSessionIds: ['session-1'],
        });

        expect(clearSessionSurfaceVisibilityForNonSessionRoute('/settings')).toBe(true);
        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: null,
            routeAnchorSessionId: null,
            visibleSessionIds: [],
        });
        expect(isSessionSurfaceVisible('session-1', 'server-actual')).toBe(false);
    });

    it('keeps visibility state available across module re-evaluation', async () => {
        markSessionSurfaceVisible('session-1', 'server-actual');

        vi.resetModules();
        const reloaded = await import('./sessionSurfaceVisibility');

        expect(reloaded.isSessionSurfaceVisible('session-1', 'server-actual')).toBe(true);
        reloaded.markSessionSurfaceHidden('session-1', 'server-actual');
    });
});
