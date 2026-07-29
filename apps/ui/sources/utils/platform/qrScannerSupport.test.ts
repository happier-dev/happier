import { beforeEach, describe, expect, it, vi } from 'vitest';

const platformState = vi.hoisted(() => ({
    os: 'ios',
    isDevice: true,
}));

vi.mock('react-native', () => ({
    Platform: {
        get OS() {
            return platformState.os;
        },
    },
}));

vi.mock('expo-device', () => ({
    get isDevice() {
        return platformState.isDevice;
    },
}));

vi.mock('./platform', () => ({
    isRunningOnMac: () => false,
}));

describe('canUseCurrentDeviceQrScanner', () => {
    beforeEach(() => {
        platformState.os = 'ios';
        platformState.isDevice = true;
        vi.unstubAllGlobals();
    });

    it('allows the native scanner on a physical device', async () => {
        const { canUseCurrentDeviceQrScanner } = await import('./qrScannerSupport');

        expect(canUseCurrentDeviceQrScanner()).toBe(true);
    });

    it('uses the fallback flow on a native simulator without a camera capture source', async () => {
        platformState.isDevice = false;
        const { canUseCurrentDeviceQrScanner } = await import('./qrScannerSupport');

        expect(canUseCurrentDeviceQrScanner()).toBe(false);
    });
});
