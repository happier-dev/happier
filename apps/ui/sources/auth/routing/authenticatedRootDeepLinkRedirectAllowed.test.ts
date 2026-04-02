import { afterEach, describe, expect, it } from 'vitest';

import { isAuthenticatedRootDeepLinkRedirectAllowed } from './authenticatedRootDeepLinkRedirectAllowed';

describe('isAuthenticatedRootDeepLinkRedirectAllowed', () => {
    const originalWindow = (globalThis as any).window;

    afterEach(() => {
        (globalThis as any).window = originalWindow;
    });

    it('returns true when window is undefined', () => {
        (globalThis as any).window = undefined;
        expect(isAuthenticatedRootDeepLinkRedirectAllowed()).toBe(true);
    });

    it('returns true when window.location is missing (native/hybrid environments)', () => {
        (globalThis as any).window = {};
        expect(isAuthenticatedRootDeepLinkRedirectAllowed()).toBe(true);
    });

    it('returns true for root pathnames', () => {
        (globalThis as any).window = { location: { pathname: '/' } };
        expect(isAuthenticatedRootDeepLinkRedirectAllowed()).toBe(true);

        (globalThis as any).window = { location: { pathname: '/index.html' } };
        expect(isAuthenticatedRootDeepLinkRedirectAllowed()).toBe(true);
    });

    it('returns false when pathname is not root', () => {
        (globalThis as any).window = { location: { pathname: '/session/abc' } };
        expect(isAuthenticatedRootDeepLinkRedirectAllowed()).toBe(false);
    });
});
