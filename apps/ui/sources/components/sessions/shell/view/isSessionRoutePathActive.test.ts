import { describe, expect, it } from 'vitest';

import { isSessionRoutePathActive } from './isSessionRoutePathActive';

describe('isSessionRoutePathActive', () => {
    it('returns true for the active session route and nested session paths', () => {
        expect(isSessionRoutePathActive('/session/s1', 's1')).toBe(true);
        expect(isSessionRoutePathActive('/session/s1/sharing', 's1')).toBe(true);
    });

    it('returns false once the pathname leaves the session route', () => {
        expect(isSessionRoutePathActive('/', 's1')).toBe(false);
        expect(isSessionRoutePathActive('/settings', 's1')).toBe(false);
        expect(isSessionRoutePathActive('/session/s2', 's1')).toBe(false);
    });
});
