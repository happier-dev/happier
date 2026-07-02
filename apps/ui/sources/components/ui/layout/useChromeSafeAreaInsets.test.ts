import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

describe('useChromeSafeAreaInsets helpers', () => {
    afterEach(() => {
        standardCleanup();
        vi.doUnmock('react-native');
        vi.doUnmock('react-native-safe-area-context');
        vi.resetModules();
    });

    it('reads safe area insets from a CSS var probe element (so env(safe-area-inset-*) resolves)', async () => {
        const { readWebSafeAreaInsetsFromCss } = await import('./useChromeSafeAreaInsets');
        const originalDocument = globalThis.document;
        const fakeProbe = { style: {}, parentNode: null } as any;
        const fakeBody = {
            appendChild: (node: any) => {
                fakeProbe.parentNode = fakeBody;
                return node;
            },
            removeChild: (node: any) => {
                if (fakeProbe === node) fakeProbe.parentNode = null;
                return node;
            },
        };
        const fakeDocument = {
            documentElement: {},
            body: fakeBody,
            createElement: () => fakeProbe,
        } as unknown as Document;

        (globalThis as any).document = fakeDocument;
        try {
            const insets = readWebSafeAreaInsetsFromCss(((elt: Element) => {
                expect(elt).toBe(fakeProbe);
                return {
                    paddingTop: '20px',
                    paddingBottom: '12px',
                    paddingLeft: '0px',
                    paddingRight: '6px',
                } as any;
            }) as any);
            expect(insets).toEqual({ top: 20, bottom: 12, left: 0, right: 6 });
        } finally {
            (globalThis as any).document = originalDocument;
        }
    });

    it('merges safe area insets by taking the max per edge', async () => {
        const { mergeSafeAreaInsets } = await import('./useChromeSafeAreaInsets');
        expect(mergeSafeAreaInsets(
            { top: 0, bottom: 10, left: 2, right: 0 },
            { top: 12, bottom: 0, left: 0, right: 6 },
        )).toEqual({ top: 12, bottom: 10, left: 2, right: 6 });
    });

    it('falls back to initialWindowMetrics insets on native when safe area provider returns zeros', async () => {
        vi.resetModules();
        const safeAreaState = {
            insets: { top: 0, bottom: 0, left: 0, right: 0 },
            initial: { insets: { top: 22, bottom: 13, left: 0, right: 0 } },
        };

        vi.doMock('react-native', async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                Platform: { OS: 'ios' },
            });
        });

        vi.doMock('react-native-safe-area-context', () => ({
            useSafeAreaInsets: () => safeAreaState.insets,
            initialWindowMetrics: safeAreaState.initial,
        }));

        const { useChromeSafeAreaInsets } = await import('./useChromeSafeAreaInsets');
        const hook = await renderHook(() => useChromeSafeAreaInsets());

        expect(hook.getCurrent()).toEqual({ top: 22, bottom: 13, left: 0, right: 0 });
    });

    it('falls back to initialWindowMetrics even when it is not an own export (ESM/CJS interop)', async () => {
        vi.resetModules();
        const safeAreaState = {
            insets: { top: 0, bottom: 0, left: 0, right: 0 },
            initial: { insets: { top: 44, bottom: 21, left: 0, right: 0 } },
        };

        vi.doMock('react-native', async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                Platform: { OS: 'ios' },
            });
        });

        vi.doMock('react-native-safe-area-context', () => {
            const proto = { initialWindowMetrics: safeAreaState.initial };
            return Object.assign(Object.create(proto), {
                useSafeAreaInsets: () => safeAreaState.insets,
            });
        });

        const { useChromeSafeAreaInsets } = await import('./useChromeSafeAreaInsets');
        const hook = await renderHook(() => useChromeSafeAreaInsets());

        expect(hook.getCurrent()).toEqual({ top: 44, bottom: 21, left: 0, right: 0 });
    });

    it('falls back to initialWindowMetrics when the export is a getter (ESM namespace live binding)', async () => {
        vi.resetModules();
        const safeAreaState = {
            insets: { top: 0, bottom: 0, left: 0, right: 0 },
            initial: { insets: { top: 50, bottom: 18, left: 0, right: 0 } },
        };

        vi.doMock('react-native', async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                Platform: { OS: 'ios' },
            });
        });

        vi.doMock('react-native-safe-area-context', () => {
            const module: Record<string, unknown> = {
                useSafeAreaInsets: () => safeAreaState.insets,
            };
            Object.defineProperty(module, 'initialWindowMetrics', {
                enumerable: true,
                get: () => safeAreaState.initial,
            });
            return module;
        });

        const { useChromeSafeAreaInsets } = await import('./useChromeSafeAreaInsets');
        const hook = await renderHook(() => useChromeSafeAreaInsets());

        expect(hook.getCurrent()).toEqual({ top: 50, bottom: 18, left: 0, right: 0 });
    });

    it('reuses the last native safe-area inset for a same-viewport zero-inset frame', async () => {
        vi.resetModules();
        const safeAreaState = {
            dimensions: { width: 390, height: 844, scale: 1, fontScale: 1 },
            initial: null as null | { insets: { top: number; bottom: number; left: number; right: number } },
            insets: { top: 0, bottom: 34, left: 0, right: 0 },
        };

        vi.doMock('react-native', async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                Platform: { OS: 'ios' },
                useWindowDimensions: () => safeAreaState.dimensions,
            });
        });

        vi.doMock('react-native-safe-area-context', () => ({
            useSafeAreaInsets: () => safeAreaState.insets,
            initialWindowMetrics: safeAreaState.initial,
        }));

        const { useChromeSafeAreaInsets } = await import('./useChromeSafeAreaInsets');
        const hook = await renderHook(() => useChromeSafeAreaInsets());

        expect(hook.getCurrent().bottom).toBe(34);

        safeAreaState.insets = { top: 0, bottom: 0, left: 0, right: 0 };
        await hook.rerender();

        expect(hook.getCurrent().bottom).toBe(34);
    });

    it('does not crash when initialWindowMetrics is not exported by the safe-area mock (returns zeros)', async () => {
        vi.resetModules();

        vi.doMock('react-native', async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                Platform: { OS: 'ios' },
            });
        });

        vi.doMock('react-native-safe-area-context', () => ({
            useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
        }));

        const { useChromeSafeAreaInsets } = await import('./useChromeSafeAreaInsets');
        const hook = await renderHook(() => useChromeSafeAreaInsets());

        expect(hook.getCurrent()).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    });

    it('returns zero insets for the dedicated desktop activity overlay window', async () => {
        vi.resetModules();

        vi.doMock('react-native', async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                Platform: { OS: 'web' },
            });
        });

        vi.doMock('react-native-safe-area-context', () => ({
            useSafeAreaInsets: () => ({ top: 14, bottom: 10, left: 24, right: 24 }),
        }));

        vi.doMock('@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext', () => ({
            isDesktopActivityOverlayWindowContext: () => true,
        }));

        const { useChromeSafeAreaInsets } = await import('./useChromeSafeAreaInsets');
        const hook = await renderHook(() => useChromeSafeAreaInsets());

        expect(hook.getCurrent()).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    });
});
