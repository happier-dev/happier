import { describe, expect, it, vi } from 'vitest';

import { collapseSessionDetailsRouteBeforeSurfaceSwitch } from './sessionCockpitNavigation';

describe('sessionCockpitNavigation', () => {
    it('returns false without calling back when the router cannot go back', () => {
        const router = {
            back: vi.fn(),
            replace: vi.fn(),
            canGoBack: vi.fn(() => false),
        };

        expect(collapseSessionDetailsRouteBeforeSurfaceSwitch({ router })).toBe(false);
        expect(router.back).not.toHaveBeenCalled();
    });
});
