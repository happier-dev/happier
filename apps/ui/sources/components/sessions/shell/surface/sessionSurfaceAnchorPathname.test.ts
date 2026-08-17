import { describe, expect, it } from 'vitest';

import {
    isOverlaySurfaceRoutePathname,
    resolveSurfaceAnchorPathname,
} from './sessionSurfaceAnchorPathname';

describe('sessionSurfaceAnchorPathname', () => {
    it('classifies overlay routes and their sub-routes, but not the routes they open over', () => {
        expect(isOverlaySurfaceRoutePathname('/new')).toBe(true);
        expect(isOverlaySurfaceRoutePathname('/new/')).toBe(true);
        expect(isOverlaySurfaceRoutePathname('/new?machine=m1')).toBe(true);
        expect(isOverlaySurfaceRoutePathname('/new/pick/machine')).toBe(true);
        expect(isOverlaySurfaceRoutePathname('/external/browse')).toBe(true);
        expect(isOverlaySurfaceRoutePathname('/direct/browse')).toBe(true);
        expect(isOverlaySurfaceRoutePathname('/zen/new')).toBe(true);
        expect(isOverlaySurfaceRoutePathname('/zen/view')).toBe(true);

        expect(isOverlaySurfaceRoutePathname('/')).toBe(false);
        expect(isOverlaySurfaceRoutePathname('/session/session-1')).toBe(false);
        expect(isOverlaySurfaceRoutePathname('/newsletter')).toBe(false);
        expect(isOverlaySurfaceRoutePathname('/external')).toBe(false);
        expect(isOverlaySurfaceRoutePathname('/zen')).toBe(false);
        expect(isOverlaySurfaceRoutePathname(null)).toBe(false);
    });

    it('holds the last non-overlay route while an overlay is open and hands the route back on close', () => {
        expect(resolveSurfaceAnchorPathname('/session/session-1', null)).toBe('/session/session-1');
        expect(resolveSurfaceAnchorPathname('/new', '/session/session-1')).toBe('/session/session-1');
        expect(resolveSurfaceAnchorPathname('/new/pick/machine', '/session/session-1')).toBe('/session/session-1');
        expect(resolveSurfaceAnchorPathname('/session/session-2', '/session/session-1')).toBe('/session/session-2');
    });

    it('falls back to the overlay route when no background route was ever observed', () => {
        expect(resolveSurfaceAnchorPathname('/new', null)).toBe('/new');
    });
});
