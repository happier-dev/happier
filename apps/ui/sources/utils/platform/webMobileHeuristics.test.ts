import { afterEach, describe, expect, it, vi } from 'vitest';

import { isCoarsePrimaryPointerEnvironment, isWebMobileHost, isWebMobileLikeQrScannerHost } from './webMobileHeuristics';

afterEach(() => {
    vi.unstubAllGlobals();
});

function stubMatchMedia(matching: readonly string[]): void {
    const matchMedia = (query: string) => ({ matches: matching.some((entry) => query.includes(entry)) });
    vi.stubGlobal('matchMedia', matchMedia);
    vi.stubGlobal('window', {
        matchMedia,
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

describe('isWebMobileHost', () => {
    it.each([
        { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', maxTouchPoints: 5 },
        { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 5 },
        { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', maxTouchPoints: 0 },
        { userAgent: 'Mozilla/5.0 (X11; CrOS aarch64 16093.0.0)', maxTouchPoints: 5 },
        // A desktop platform client hint is not a mobile hint (negative control for the Android/iOS rows below).
        { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', userAgentData: { mobile: false, platform: 'Windows' }, maxTouchPoints: 5 },
        { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', userAgentData: { mobile: false, platform: 'Linux' }, maxTouchPoints: 5 },
    ])('keeps a desktop computer eligible despite a coarse primary pointer: %j', (navigatorFixture) => {
        vi.stubGlobal('navigator', navigatorFixture);
        vi.stubGlobal('window', {
            matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' || query === '(hover: none)' }),
        });

        expect(isWebMobileHost()).toBe(false);
    });

    it.each([
        { userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36' },
        { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
        { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15', maxTouchPoints: 5 },
        { userAgentData: { mobile: true }, userAgent: 'Mozilla/5.0 (Windows NT 10.0)' },
    ])('keeps phone and tablet hosts excluded: %j', (navigatorFixture) => {
        vi.stubGlobal('navigator', navigatorFixture);
        vi.stubGlobal('window', {
            matchMedia: (query: string) => ({ matches: query === '(pointer: fine)' || query === '(hover: hover)' }),
        });

        expect(isWebMobileHost()).toBe(true);
    });

    it('uses the coarse-pointer fallback when host identity is unavailable', () => {
        vi.stubGlobal('navigator', { maxTouchPoints: 2 });
        vi.stubGlobal('window', {
            matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' }),
        });

        expect(isWebMobileHost()).toBe(true);
    });
});

describe('explicit mobile platform identity', () => {
    it.each(['Android', 'iOS'])('keeps a host reporting %s mobile platform excluded with a desktop UA', (platform) => {
        vi.stubGlobal('navigator', {
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
            userAgentData: { mobile: false, platform },
            maxTouchPoints: 5,
        });
        vi.stubGlobal('window', {
            matchMedia: (query: string) => ({ matches: query === '(pointer: fine)' || query === '(hover: hover)' }),
        });
        expect(isWebMobileHost()).toBe(true);
    });
});
