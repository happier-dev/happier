import { describe, expect, it } from 'vitest';

import {
    isWebIosBrowser,
    resolveTrustedWebSafeAreaBottomInset,
} from './webSafeAreaInset';

describe('isWebIosBrowser', () => {
    it('detects iPhone/iPod/iPad user agents', () => {
        expect(isWebIosBrowser({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15' })).toBe(true);
        expect(isWebIosBrowser({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15' })).toBe(true);
    });

    it('detects iPadOS desktop-mode user agents via touch points', () => {
        expect(isWebIosBrowser({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 })).toBe(true);
        expect(isWebIosBrowser({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 })).toBe(false);
    });

    it('rejects Android, desktop, and unknown agents', () => {
        expect(isWebIosBrowser({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Gecko/20100101 Firefox/142.0' })).toBe(false);
        expect(isWebIosBrowser({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0' })).toBe(false);
        expect(isWebIosBrowser({ userAgent: 'Node.js/22' })).toBe(false);
    });
});

describe('resolveTrustedWebSafeAreaBottomInset', () => {
    it('keeps the inset on iOS web, where the viewport really extends under the home indicator', () => {
        expect(resolveTrustedWebSafeAreaBottomInset(34, { isWebIos: true })).toBe(34);
    });

    it('zeroes the inset everywhere else on web (Firefox Android reports a nav bar the viewport never overlaps)', () => {
        expect(resolveTrustedWebSafeAreaBottomInset(72, { isWebIos: false })).toBe(0);
        expect(resolveTrustedWebSafeAreaBottomInset(34, { isWebIos: false })).toBe(0);
        expect(resolveTrustedWebSafeAreaBottomInset(0, { isWebIos: false })).toBe(0);
    });
});
