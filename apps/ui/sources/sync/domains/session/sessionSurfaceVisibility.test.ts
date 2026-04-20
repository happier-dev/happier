import { beforeEach, describe, expect, it } from 'vitest';

import {
    clearFocusedSessionId,
    clearRouteAnchorSessionId,
    getSessionSurfaceVisibilitySnapshot,
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
});
