import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const nativeSafeAreaState = vi.hoisted(() => ({
    dimensions: { width: 390, height: 844, scale: 1, fontScale: 1 },
    initialWindowMetrics: null as null | {
        insets: { top: number; bottom: number; left: number; right: number };
    },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
}));

describe('useChromeSafeAreaInsets helpers', () => {
    afterEach(() => {
        standardCleanup();
        vi.doUnmock('react-native');
        vi.doUnmock('react-native-safe-area-context');
        vi.resetModules();
    });

    it('merges safe-area inset sources by keeping the larger edge value', async () => {
        const { mergeSafeAreaInsets } = await import('./useChromeSafeAreaInsets');

        expect(mergeSafeAreaInsets(
            { top: 4, bottom: 12, left: 0, right: 6 },
            { top: 8, bottom: 2, left: 3, right: 1 },
        )).toEqual({
            top: 8,
            bottom: 12,
            left: 3,
            right: 6,
        });
    });

    it('returns zero web fallback insets when document is unavailable', async () => {
        const { readWebSafeAreaInsetsFromCss } = await import('./useChromeSafeAreaInsets');

        expect(readWebSafeAreaInsetsFromCss()).toEqual({
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
        });
    });

    it('merges the live native insets with the initial-window fallback on the first frame', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'ios' },
            useWindowDimensions: () => nativeSafeAreaState.dimensions,
        }));
        vi.doMock('react-native-safe-area-context', () => ({
            get initialWindowMetrics() {
                return nativeSafeAreaState.initialWindowMetrics;
            },
            default: {
                get initialWindowMetrics() {
                    return nativeSafeAreaState.initialWindowMetrics;
                },
            },
            useSafeAreaInsets: () => nativeSafeAreaState.insets,
        }));
        // First-frame reliability (constraint F): even when the live hook reports a
        // zero bottom inset, the root initialWindowMetrics fallback must still feed a
        // non-zero bottom inset on the very first render.
        nativeSafeAreaState.insets = { top: 0, bottom: 0, left: 0, right: 0 };
        nativeSafeAreaState.initialWindowMetrics = { insets: { top: 47, bottom: 34, left: 0, right: 0 } };
        nativeSafeAreaState.dimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
        const { useChromeSafeAreaInsets } = await import('./useChromeSafeAreaInsets');

        const hook = await renderHook(() => useChromeSafeAreaInsets());

        expect(hook.getCurrent()).toEqual({ top: 47, bottom: 34, left: 0, right: 0 });
    });

    it('zeroes the web bottom inset on non-iOS web (Firefox reports a nav bar the viewport never overlaps)', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'web' },
            useWindowDimensions: () => nativeSafeAreaState.dimensions,
        }));
        vi.doMock('react-native-safe-area-context', () => ({
            get initialWindowMetrics() {
                return nativeSafeAreaState.initialWindowMetrics;
            },
            default: {
                get initialWindowMetrics() {
                    return nativeSafeAreaState.initialWindowMetrics;
                },
            },
            useSafeAreaInsets: () => nativeSafeAreaState.insets,
        }));
        nativeSafeAreaState.insets = { top: 0, bottom: 80, left: 0, right: 0 };
        nativeSafeAreaState.initialWindowMetrics = null;
        Object.defineProperty(globalThis, 'navigator', {
            value: { userAgent: 'Mozilla/5.0 (Linux; Android 15) Gecko/20100101 Firefox/142.0', maxTouchPoints: 5 },
            configurable: true,
        });
        try {
            const { useChromeSafeAreaInsets } = await import('./useChromeSafeAreaInsets');
            const hook = await renderHook(() => useChromeSafeAreaInsets());
            expect(hook.getCurrent().bottom).toBe(0);
        } finally {
            delete (globalThis as Record<string, unknown>).navigator;
        }
    });

    it('keeps the web bottom inset on iOS web (home-indicator viewport overlap is real)', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'web' },
            useWindowDimensions: () => nativeSafeAreaState.dimensions,
        }));
        vi.doMock('react-native-safe-area-context', () => ({
            get initialWindowMetrics() {
                return nativeSafeAreaState.initialWindowMetrics;
            },
            default: {
                get initialWindowMetrics() {
                    return nativeSafeAreaState.initialWindowMetrics;
                },
            },
            useSafeAreaInsets: () => nativeSafeAreaState.insets,
        }));
        nativeSafeAreaState.insets = { top: 0, bottom: 34, left: 0, right: 0 };
        nativeSafeAreaState.initialWindowMetrics = null;
        Object.defineProperty(globalThis, 'navigator', {
            value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15', maxTouchPoints: 5 },
            configurable: true,
        });
        try {
            const { useChromeSafeAreaInsets } = await import('./useChromeSafeAreaInsets');
            const hook = await renderHook(() => useChromeSafeAreaInsets());
            expect(hook.getCurrent().bottom).toBe(34);
        } finally {
            delete (globalThis as Record<string, unknown>).navigator;
        }
    });

    it('does not resurrect a stale native inset when a later zero-inset frame has no fallback', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'ios' },
            useWindowDimensions: () => nativeSafeAreaState.dimensions,
        }));
        vi.doMock('react-native-safe-area-context', () => ({
            get initialWindowMetrics() {
                return nativeSafeAreaState.initialWindowMetrics;
            },
            default: {
                get initialWindowMetrics() {
                    return nativeSafeAreaState.initialWindowMetrics;
                },
            },
            useSafeAreaInsets: () => nativeSafeAreaState.insets,
        }));
        nativeSafeAreaState.insets = { top: 0, bottom: 34, left: 0, right: 0 };
        nativeSafeAreaState.initialWindowMetrics = null;
        nativeSafeAreaState.dimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
        const { useChromeSafeAreaInsets } = await import('./useChromeSafeAreaInsets');

        const hook = await renderHook(() => useChromeSafeAreaInsets());
        expect(hook.getCurrent().bottom).toBe(34);

        // Without a caching layer, a zero-inset frame with no fallback resolves to
        // zero instead of resurrecting the previously seen value.
        nativeSafeAreaState.insets = { top: 0, bottom: 0, left: 0, right: 0 };
        await hook.rerender();

        expect(hook.getCurrent().bottom).toBe(0);
    });
});
