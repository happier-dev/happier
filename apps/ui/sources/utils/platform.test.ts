import { describe, it, expect, vi, beforeEach } from 'vitest';

type PlatformMock = {
    OS: string;
    constants?: { isMacCatalyst?: boolean };
};

async function loadIsRunningOnMac(params: { platform: PlatformMock; deviceType: string }) {
    vi.doMock('react-native', () => ({ Platform: params.platform }));
    vi.doMock('react-native-device-info', () => ({ getDeviceType: () => params.deviceType }));
    const mod = await import('./platform');
    return mod.isRunningOnMac();
}

describe('isRunningOnMac', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('returns false on non-iOS platforms', async () => {
        const result = await loadIsRunningOnMac({
            platform: { OS: 'android', constants: { isMacCatalyst: true } },
            deviceType: 'Desktop',
        });
        expect(result).toBe(false);
    });

    it('returns true when Platform.constants.isMacCatalyst is true', async () => {
        const result = await loadIsRunningOnMac({
            platform: { OS: 'ios', constants: { isMacCatalyst: true } },
            deviceType: 'Tablet',
        });
        expect(result).toBe(true);
    });

    it('falls back to deviceType Desktop when constants are unavailable', async () => {
        const result = await loadIsRunningOnMac({
            platform: { OS: 'ios' },
            deviceType: 'Desktop',
        });
        expect(result).toBe(true);
    });

    it('returns false when isMacCatalyst is explicitly false (even if deviceType is Desktop)', async () => {
        const result = await loadIsRunningOnMac({
            platform: { OS: 'ios', constants: { isMacCatalyst: false } },
            deviceType: 'Desktop',
        });
        expect(result).toBe(false);
    });

    it('returns false when not catalyst and deviceType is not Desktop', async () => {
        const result = await loadIsRunningOnMac({
            platform: { OS: 'ios', constants: {} },
            deviceType: 'Tablet',
        });
        expect(result).toBe(false);
    });
});
