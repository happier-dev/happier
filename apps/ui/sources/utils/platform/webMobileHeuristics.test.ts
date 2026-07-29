import { afterEach, describe, expect, it, vi } from 'vitest';

import { isCoarsePrimaryPointerEnvironment, isWebMobileLikeQrScannerHost } from './webMobileHeuristics';

afterEach(() => {
    vi.unstubAllGlobals();
});

function stubMatchMedia(matching: readonly string[]): void {
    vi.stubGlobal('window', {
        matchMedia: (query: string) => ({ matches: matching.some((entry) => query.includes(entry)) }),
    } as any);
}

describe('isWebMobileLikeQrScannerHost', () => {
    it('treats touch-enabled fine-pointer desktops as not mobile-like', () => {
        vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } as any);
        stubMatchMedia(['pointer: fine']);

        expect(isWebMobileLikeQrScannerHost({ width: 360, height: 800 })).toBe(false);
    });
});

describe('isCoarsePrimaryPointerEnvironment', () => {
    it('is false on a hover-capable laptop that also has a touchscreen', () => {
        vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } as any);
        // A touchscreen laptop matches `any-pointer: coarse` while its PRIMARY
        // pointer stays fine — hover affordances must survive there.
        stubMatchMedia(['pointer: fine', 'hover: hover', 'any-pointer: coarse', 'any-hover: none']);

        expect(isCoarsePrimaryPointerEnvironment()).toBe(false);
    });

    it('is true on a phone whose primary pointer cannot hover', () => {
        vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone)' } as any);
        stubMatchMedia(['pointer: coarse', 'hover: none', 'any-pointer: coarse', 'any-hover: none']);

        expect(isCoarsePrimaryPointerEnvironment()).toBe(true);
    });

    it('falls back to touch points when the host reports no pointer media', () => {
        vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: '' } as any);
        stubMatchMedia([]);

        expect(isCoarsePrimaryPointerEnvironment()).toBe(true);

        vi.stubGlobal('navigator', { maxTouchPoints: 0, userAgent: '' } as any);
        expect(isCoarsePrimaryPointerEnvironment()).toBe(false);
    });
});
