import { describe, it, expect, vi, beforeEach } from 'vitest';

type PlatformMock = {
    OS: string;
    constants?: { isMacCatalyst?: boolean };
};

async function loadIsRunningOnMac(params: { platform: PlatformMock }) {
    vi.doMock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            Platform: params.platform,
        }
    );
});
    vi.doMock('react-native-device-info', () => {
        throw new Error('react-native-device-info should not be imported');
    });
    const mod = await import('./platform');
    return mod.isRunningOnMac();
}

describe('isRunningOnMac', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('does not import react-native-device-info for web builds', async () => {
        vi.doMock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            Platform: {
                OS: 'web',
            },
        }
    );
});
        vi.doMock('react-native-device-info', () => {
            throw new Error('react-native-device-info should not be imported on web');
        });

        const mod = await import('./platform');
        expect(mod.isRunningOnMac()).toBe(false);
    });

    it('returns false on non-iOS platforms', async () => {
        const result = await loadIsRunningOnMac({
            platform: { OS: 'android', constants: { isMacCatalyst: true } },
        });
        expect(result).toBe(false);
    });

    it('returns true when Platform.constants.isMacCatalyst is true', async () => {
        const result = await loadIsRunningOnMac({
            platform: { OS: 'ios', constants: { isMacCatalyst: true } },
        });
        expect(result).toBe(true);
    });

    it('returns false when constants are unavailable', async () => {
        const result = await loadIsRunningOnMac({
            platform: { OS: 'ios' },
        });
        expect(result).toBe(false);
    });

    it('returns false when isMacCatalyst is explicitly false (even if deviceType is Desktop)', async () => {
        const result = await loadIsRunningOnMac({
            platform: { OS: 'ios', constants: { isMacCatalyst: false } },
        });
        expect(result).toBe(false);
    });

    it('returns false when not catalyst and deviceType is not Desktop', async () => {
        const result = await loadIsRunningOnMac({
            platform: { OS: 'ios', constants: {} },
        });
        expect(result).toBe(false);
    });
});
