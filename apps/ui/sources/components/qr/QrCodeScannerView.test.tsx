import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let platformOs: 'ios' | 'web' = 'ios';
let windowWidth = 360;
let windowHeight = 800;

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
    useWindowDimensions: () => ({ width: windowWidth, height: windowHeight, scale: 2, fontScale: 1 }),
    Platform: {
        get OS() {
            return platformOs;
        },
        select: (options: any) => options?.[platformOs] ?? options?.default ?? options?.ios ?? options?.android,
    },
    Linking: { openSettings: vi.fn(async () => {}) },
    AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
    useUnistyles: () => ({
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
    }),
}));

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
        platformOs = 'ios';
        windowWidth = 360;
        windowHeight = 800;
        vi.unstubAllGlobals();
    });

    it('debounces duplicate scans', async () => {
        const onScan = vi.fn(async () => {});
        const { QrCodeScannerView } = await import('./QrCodeScannerView');

        await act(async () => {
            renderer.create(
                <QrCodeScannerView
                    title="t"
                    subtitle="s"
                    permissionRequiredMessage="perm"
                    onCancel={vi.fn()}
                    onScan={onScan}
                    testIDPrefix="test"
                />,
            );
        });

        expect(typeof lastCameraProps?.onBarcodeScanned).toBe('function');

        await act(async () => {
            lastCameraProps.onBarcodeScanned({ data: 'x' });
            lastCameraProps.onBarcodeScanned({ data: 'x' });
            await Promise.resolve();
        });

        expect(onScan).toHaveBeenCalledTimes(1);
    });

    it('renders a camera scanner on phone-sized web when camera APIs exist', async () => {
        platformOs = 'web';
        windowWidth = 360;
        windowHeight = 800;
        vi.stubGlobal('navigator', { maxTouchPoints: 5, mediaDevices: { getUserMedia: async () => ({}) } } as any);

        const { QrCodeScannerView } = await import('./QrCodeScannerView');

        await act(async () => {
            renderer.create(
                <QrCodeScannerView
                    title="t"
                    permissionRequiredMessage="perm"
                    onCancel={vi.fn()}
                    onScan={vi.fn()}
                    testIDPrefix="test"
                />,
            );
        });
        expect(lastCameraProps).not.toBeNull();
    });

    it('does not render a camera scanner on desktop web even when camera APIs exist', async () => {
        platformOs = 'web';
        windowWidth = 1400;
        windowHeight = 900;
        vi.stubGlobal('navigator', {
            maxTouchPoints: 0,
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
            mediaDevices: { getUserMedia: async () => ({}) },
        } as any);
        vi.stubGlobal('window', {
            matchMedia: () => ({ matches: false }),
        } as any);

        const { QrCodeScannerView } = await import('./QrCodeScannerView');

        await act(async () => {
            renderer.create(
                <QrCodeScannerView
                    title="t"
                    permissionRequiredMessage="perm"
                    onCancel={vi.fn()}
                    onScan={vi.fn()}
                    testIDPrefix="test"
                />,
            );
        });
        expect(lastCameraProps).toBeNull();
    });
});
