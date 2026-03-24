import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const deviceState = vi.hoisted(() => ({
    platformOs: 'ios' as 'ios' | 'web',
    windowWidth: 360,
    windowHeight: 800,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            View: 'View',
                            Pressable: 'Pressable',
                            ActivityIndicator: 'ActivityIndicator',
                            useWindowDimensions: () => ({
                                width: deviceState.windowWidth,
                                height: deviceState.windowHeight,
                                scale: 2,
                                fontScale: 1,
                            }),
                            Platform: {
                                get OS() {
                                    return deviceState.platformOs;
                                },
                                select: (options: any) => options?.[deviceState.platformOs] ?? options?.default ?? options?.ios ?? options?.android,
                            },
                            Linking: {
                                openSettings: vi.fn(async () => {}),
                            },
                            AppState: {
                                addEventListener: () => ({ remove: () => {} }),
                            },
                        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surface: '#fff',
                text: '#000',
                textSecondary: '#666',
                overlay: {
                    scrim: 'rgba(0,0,0,0.45)',
                    scrimStrong: 'rgba(0,0,0,0.6)',
                    text: '#fff',
                    textSecondary: 'rgba(255,255,255,0.9)',
                },
            },
        },
    });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: 'RoundButton',
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'phone',
}));

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

let lastCameraProps: any = null;
vi.mock('expo-camera', () => ({
    CameraView: (props: any) => {
        lastCameraProps = props;
        return React.createElement('CameraView', props);
    },
    useCameraPermissions: () => [{ granted: true }, vi.fn(async () => ({ granted: true }))],
}));

describe('QrCodeScannerView', () => {
    beforeEach(() => {
        lastCameraProps = null;
        deviceState.platformOs = 'ios';
        deviceState.windowWidth = 360;
        deviceState.windowHeight = 800;
        vi.unstubAllGlobals();
    });

    it('debounces duplicate scans', async () => {
        const onScan = vi.fn(async () => {});
        const { QrCodeScannerView } = await import('./QrCodeScannerView');

        await renderScreen(<QrCodeScannerView
                    title="t"
                    subtitle="s"
                    permissionRequiredMessage="perm"
                    onCancel={vi.fn()}
                    onScan={onScan}
                    testIDPrefix="test"
                />);

        expect(typeof lastCameraProps?.onBarcodeScanned).toBe('function');

        lastCameraProps.onBarcodeScanned({ data: 'x' });
        lastCameraProps.onBarcodeScanned({ data: 'x' });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(onScan).toHaveBeenCalledTimes(1);
    });

    it('renders a camera scanner on phone-sized web when camera APIs exist', async () => {
        deviceState.platformOs = 'web';
        deviceState.windowWidth = 360;
        deviceState.windowHeight = 800;
        vi.stubGlobal('navigator', { maxTouchPoints: 5, mediaDevices: { getUserMedia: async () => ({}) } } as any);

        const { QrCodeScannerView } = await import('./QrCodeScannerView');

        await renderScreen(<QrCodeScannerView
                    title="t"
                    permissionRequiredMessage="perm"
                    onCancel={vi.fn()}
                    onScan={vi.fn()}
                    testIDPrefix="test"
                />);
        expect(lastCameraProps).not.toBeNull();
    });

    it('does not render a camera scanner on desktop web even when camera APIs exist', async () => {
        deviceState.platformOs = 'web';
        deviceState.windowWidth = 1400;
        deviceState.windowHeight = 900;
        vi.stubGlobal('navigator', {
            maxTouchPoints: 0,
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
            mediaDevices: { getUserMedia: async () => ({}) },
        } as any);
        vi.stubGlobal('window', {
            matchMedia: () => ({ matches: false }),
        } as any);

        const { QrCodeScannerView } = await import('./QrCodeScannerView');

        await renderScreen(<QrCodeScannerView
                    title="t"
                    permissionRequiredMessage="perm"
                    onCancel={vi.fn()}
                    onScan={vi.fn()}
                    testIDPrefix="test"
                />);
        expect(lastCameraProps).toBeNull();
    });
});
