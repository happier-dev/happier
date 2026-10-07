import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PlatformMock = {
    OS: string;
};

async function loadTypography(params: Readonly<{ platform: PlatformMock; userAgent?: string }>) {
    vi.doMock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: params.platform,
        });
    });

    if (params.userAgent) {
        vi.stubGlobal('navigator', { userAgent: params.userAgent });
    }

    return await import('./Typography');
}

describe('Typography.default Inter on every platform', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal('navigator', undefined);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.doUnmock('react-native');
    });

    it('uses Inter on native iOS, with weight and style encoded in the face', async () => {
        const mod = await loadTypography({ platform: { OS: 'ios' } });
        expect(mod.Typography.default()).toEqual({ fontFamily: 'Inter-Regular' });
        expect(mod.Typography.default('semiBold')).toEqual({ fontFamily: 'Inter-SemiBold' });
        expect(mod.Typography.default('italic')).toEqual({ fontFamily: 'Inter-Italic' });
        expect(mod.Typography.mono()).toEqual({ fontFamily: 'IBMPlexMono-Regular' });
    });

    it('uses Inter on non-Apple platforms', async () => {
        const mod = await loadTypography({ platform: { OS: 'android' } });
        expect(mod.Typography.default()).toEqual({ fontFamily: 'Inter-Regular' });
        expect(mod.Typography.default('semiBold')).toEqual({ fontFamily: 'Inter-SemiBold' });
        expect(mod.Typography.default('italic')).toEqual({ fontFamily: 'Inter-Italic' });
    });

    it.each([
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
        'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
    ])('uses Inter through the theme-held family on Apple web (%s)', async (userAgent) => {
        const mod = await loadTypography({
            platform: { OS: 'web' },
            userAgent,
        });
        for (const weight of mod.DEFAULT_FONT_WEIGHTS) {
            expect(mod.Typography.default(weight)).toEqual({
                fontFamily: `var(--happier-font-default-${weight}, ${mod.FontFamilies.default[weight]})`,
            });
            expect(mod.getHappierFontFamily('default', weight)).toBe(mod.FontFamilies.default[weight]);
        }
        expect(mod.Typography.mono()).toEqual({ fontFamily: 'var(--happier-font-mono-regular, IBMPlexMono-Regular)' });
    });

    it('reads the theme-held family variable on other web platforms, falling back to Inter', async () => {
        const mod = await loadTypography({
            platform: { OS: 'web' },
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
        });
        expect(mod.Typography.default()).toEqual({ fontFamily: 'var(--happier-font-default-regular, Inter-Regular)' });
        expect(mod.Typography.default('semiBold')).toEqual({ fontFamily: 'var(--happier-font-default-semiBold, Inter-SemiBold)' });
        expect(mod.Typography.mono()).toEqual({ fontFamily: 'var(--happier-font-mono-regular, IBMPlexMono-Regular)' });
        expect(mod.getMonoFont('semiBold')).toBe('var(--happier-font-mono-semiBold, IBMPlexMono-SemiBold)');
    });

    it('offers a true medium (500) and bold (600) weight on every platform', async () => {
        const android = await loadTypography({ platform: { OS: 'android' } });
        expect(android.Typography.default('medium')).toEqual({ fontFamily: 'Inter-Medium' });
        expect(android.Typography.default('bold')).toEqual({ fontFamily: 'Inter-SemiBold' });

        vi.resetModules();
        const ios = await loadTypography({ platform: { OS: 'ios' } });
        expect(ios.Typography.default('medium')).toEqual({ fontFamily: 'Inter-Medium' });
        expect(ios.Typography.default('bold')).toEqual({ fontFamily: 'Inter-SemiBold' });

        vi.resetModules();
        const appleWeb = await loadTypography({
            platform: { OS: 'web' },
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15',
        });
        expect(appleWeb.Typography.default('medium')).toEqual({ fontFamily: 'var(--happier-font-default-medium, Inter-Medium)' });
        expect(appleWeb.Typography.default('bold')).toEqual({ fontFamily: 'var(--happier-font-default-bold, Inter-SemiBold)' });
    });
});
