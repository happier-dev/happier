import { beforeEach, describe, expect, it, vi } from 'vitest';

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
        vi.stubGlobal('navigator', { userAgent: params.userAgent } as any);
    }

    return await import('./Typography');
}

describe('Typography.default Apple system font preference', () => {
    beforeEach(() => {
        vi.resetModules();
        // Ensure previous tests don't leak navigator overrides.
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).navigator;
    });

    it('uses system font on native iOS by omitting fontFamily', async () => {
        const mod = await loadTypography({ platform: { OS: 'ios' } });
        expect(mod.Typography.default()).not.toHaveProperty('fontFamily');
        expect(mod.Typography.default('semiBold')).toEqual({ fontWeight: mod.FontWeights.semiBold });
        expect(mod.Typography.default('italic')).toEqual({ fontStyle: 'italic' });
    });

    it('uses Inter on non-Apple platforms', async () => {
        const mod = await loadTypography({ platform: { OS: 'android' } });
        expect(mod.Typography.default()).toEqual({ fontFamily: 'Inter-Regular' });
        expect(mod.Typography.default('semiBold')).toEqual({ fontFamily: 'Inter-SemiBold' });
        expect(mod.Typography.default('italic')).toEqual({ fontFamily: 'Inter-Italic' });
    });

    it('uses the Apple system font stack on Apple web', async () => {
        const mod = await loadTypography({
            platform: { OS: 'web' },
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15',
        });
        expect(mod.Typography.default()).toEqual({
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', system-ui, sans-serif",
        });
        expect(mod.Typography.default('semiBold')).toEqual({
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', system-ui, sans-serif",
            fontWeight: mod.FontWeights.semiBold,
        });
    });
});

