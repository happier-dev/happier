import { beforeEach, describe, expect, it, vi } from 'vitest';

import { safeRouterBack } from './safeRouterBack';

describe('safeRouterBack', () => {
    beforeEach(() => {
        vi.useRealTimers();
        Object.defineProperty(globalThis, 'location', {
            value: { href: 'http://localhost/start', pathname: '/start' },
            writable: true,
            configurable: true,
        });
    });

    it('falls back to replace when router reports no back stack', () => {
        const backSpy = vi.fn();
        const replaceSpy = vi.fn();

        safeRouterBack({
            router: {
                back: backSpy,
                replace: replaceSpy,
                canGoBack: () => false,
            },
            navigation: {
                canGoBack: () => true,
            },
            fallbackHref: '/fallback',
        });

        expect(backSpy).not.toHaveBeenCalled();
        expect(replaceSpy).toHaveBeenCalledWith('/fallback');
    });

    it('replaces with the fallback when back does not change the URL on web', () => {
        vi.useFakeTimers();

        const startHref = (globalThis as any).location.href as string;
        const backSpy = vi.fn();
        const replaceSpy = vi.fn();

        safeRouterBack({
            router: {
                back: backSpy,
                replace: replaceSpy,
            },
            navigation: {
                canGoBack: () => true,
            },
            fallbackHref: '/fallback',
        });

        expect(backSpy).toHaveBeenCalled();
        expect((globalThis as any).location.href).toBe(startHref);
        expect(replaceSpy).not.toHaveBeenCalled();

        vi.runAllTimers();

        expect(replaceSpy).toHaveBeenCalledWith('/fallback');
    });

    it('does not replace when back changes the URL before the fallback timer fires', () => {
        vi.useFakeTimers();

        const backSpy = vi.fn(() => {
            (globalThis as any).location.href = 'http://localhost/went-back';
            (globalThis as any).location.pathname = '/went-back';
        });
        const replaceSpy = vi.fn();

        safeRouterBack({
            router: {
                back: backSpy,
                replace: replaceSpy,
            },
            navigation: {
                canGoBack: () => true,
            },
            fallbackHref: '/fallback',
        });

        vi.runAllTimers();

        expect(backSpy).toHaveBeenCalled();
        expect((globalThis as any).location.pathname).toBe('/went-back');
        expect(replaceSpy).not.toHaveBeenCalled();
    });

    it('falls back to replace when navigation state shows there is no back stack', () => {
        const backSpy = vi.fn();
        const replaceSpy = vi.fn();

        safeRouterBack({
            router: {
                back: backSpy,
                replace: replaceSpy,
            },
            navigation: {
                getState: () => ({
                    index: 0,
                    routes: [{ key: 'only-route' }],
                }),
            },
            fallbackHref: '/fallback',
        });

        expect(backSpy).not.toHaveBeenCalled();
        expect(replaceSpy).toHaveBeenCalledWith('/fallback');
    });

    it('prefers navigation.goBack over router.back when the local navigator can handle back', () => {
        vi.useFakeTimers();

        const backSpy = vi.fn();
        const replaceSpy = vi.fn();
        const navigationGoBackSpy = vi.fn();

        safeRouterBack({
            router: {
                back: backSpy,
                replace: replaceSpy,
            },
            navigation: {
                canGoBack: () => true,
                goBack: navigationGoBackSpy,
                getState: () => ({
                    index: 1,
                    routes: [{ key: 'previous-route' }, { key: 'current-route' }],
                }),
            },
            fallbackHref: '/fallback',
        });

        expect(navigationGoBackSpy).toHaveBeenCalledTimes(1);
        expect(backSpy).not.toHaveBeenCalled();
        expect(replaceSpy).not.toHaveBeenCalled();

        vi.runAllTimers();

        expect(replaceSpy).not.toHaveBeenCalled();
    });
});
