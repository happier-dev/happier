import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadSurfaceBorderModule(platformOS: 'web' | 'ios') {
    vi.resetModules();
    vi.doMock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: platformOS,
            },
            StyleSheet: {
                hairlineWidth: 0.5,
            },
        });
    });

    return import('./resolveThemeHairlineBorderStyle');
}

describe('resolveThemeHairlineBorderStyle platform widths', () => {
    afterEach(() => {
        vi.doUnmock('react-native');
        vi.resetModules();
    });

    it('uses a full point border on iOS so subtle surface chrome remains visible', async () => {
        const { resolveThemeHairlineBorderStyle } = await loadSurfaceBorderModule('ios');

        expect(resolveThemeHairlineBorderStyle('rgba(255,255,255,0.08)')).toEqual({
            borderColor: 'rgba(255,255,255,0.08)',
            borderWidth: 1,
        });
    });

    it('keeps the web hairline width unchanged', async () => {
        const { resolveThemeHairlineBorderStyle } = await loadSurfaceBorderModule('web');

        expect(resolveThemeHairlineBorderStyle('rgba(255,255,255,0.08)')).toEqual({
            borderColor: 'rgba(255,255,255,0.08)',
            borderWidth: 0.5,
        });
    });
});
