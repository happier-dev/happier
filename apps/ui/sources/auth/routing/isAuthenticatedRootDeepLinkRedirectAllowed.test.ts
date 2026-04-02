import { describe, expect, it } from 'vitest';

import { isAuthenticatedRootDeepLinkRedirectAllowed } from './isAuthenticatedRootDeepLinkRedirectAllowed';

describe('isAuthenticatedRootDeepLinkRedirectAllowed', () => {
    it('returns true when window is missing (native / SSR)', () => {
        const prevWindow = (globalThis as any).window;
        try {
            delete (globalThis as any).window;
            expect(isAuthenticatedRootDeepLinkRedirectAllowed()).toBe(true);
        } finally {
            (globalThis as any).window = prevWindow;
        }
    });

    it('returns true when window exists but location is missing', () => {
        const prevWindow = (globalThis as any).window;
        try {
            (globalThis as any).window = {};
            expect(isAuthenticatedRootDeepLinkRedirectAllowed()).toBe(true);
        } finally {
            (globalThis as any).window = prevWindow;
        }
    });

    it('returns true for empty pathname', () => {
        const prevWindow = (globalThis as any).window;
        try {
            (globalThis as any).window = { location: { pathname: '' } };
            expect(isAuthenticatedRootDeepLinkRedirectAllowed()).toBe(true);
        } finally {
            (globalThis as any).window = prevWindow;
        }
    });

    it('returns true for root pathnames', () => {
        const prevWindow = (globalThis as any).window;
        try {
            (globalThis as any).window = { location: { pathname: '/' } };
            expect(isAuthenticatedRootDeepLinkRedirectAllowed()).toBe(true);
            (globalThis as any).window = { location: { pathname: '/index.html' } };
            expect(isAuthenticatedRootDeepLinkRedirectAllowed()).toBe(true);
        } finally {
            (globalThis as any).window = prevWindow;
        }
    });

    it('returns false for non-root pathnames', () => {
        const prevWindow = (globalThis as any).window;
        try {
            (globalThis as any).window = { location: { pathname: '/session/abc' } };
            expect(isAuthenticatedRootDeepLinkRedirectAllowed()).toBe(false);
        } finally {
            (globalThis as any).window = prevWindow;
        }
    });
});

