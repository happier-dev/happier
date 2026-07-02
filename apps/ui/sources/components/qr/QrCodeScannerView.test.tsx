import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { lightTheme } from '@/theme';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const deviceState = vi.hoisted(() => ({
    platformOs: 'ios' as 'ios' | 'web',
    windowWidth: 360,
    windowHeight: 800,
}));

const cameraState = vi.hoisted(() => ({
    permission: { granted: true } as { granted: boolean } | null,
    requestPermission: vi.fn(async () => ({ granted: true })),
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
    return createUnistylesMock();
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

vi.mock('@expo/vector-icons', async () => {
    const ReactModule = await import('react');
    return {
        Ionicons: (props: Record<string, unknown>) => ReactModule.createElement('Ionicons', props),
    };
});

let lastCameraProps: any = null;
vi.mock('expo-camera', () => ({
    CameraView: (props: any) => {
        lastCameraProps = props;
        return React.createElement('CameraView', props);
    },
    useCameraPermissions: () => [cameraState.permission, cameraState.requestPermission],
}));

describe('QrCodeScannerView', () => {
    function flattenStyle(style: unknown): Record<string, unknown> {
        if (!style) return {};
        if (Array.isArray(style)) {
            return style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
        }
        if (typeof style === 'object') {
            return style as Record<string, unknown>;
        }
        return {};
    }

    beforeEach(() => {
        lastCameraProps = null;
        deviceState.platformOs = 'ios';
        deviceState.windowWidth = 360;
        deviceState.windowHeight = 800;
        cameraState.permission = { granted: true };
        cameraState.requestPermission.mockReset();
        cameraState.requestPermission.mockResolvedValue({ granted: true });
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

    it('suppresses the internal title/subtitle when embedded', async () => {
        const { QrCodeScannerView } = await import('./QrCodeScannerView');

        const screen = await renderScreen(
            <QrCodeScannerView
                embedded
                title="__qr_title__"
                subtitle="__qr_subtitle__"
                permissionRequiredMessage="perm"
                onCancel={vi.fn()}
                onScan={vi.fn()}
                testIDPrefix="test"
            />,
        );

        const text = screen.getTextContent();
        expect(text).not.toContain('__qr_title__');
        expect(text).not.toContain('__qr_subtitle__');
    });

    it('renders a camera scanner on web when camera APIs exist', async () => {
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

    it('does not keep the camera mounted when scanner activity is paused', async () => {
        const { QrCodeScannerView } = await import('./QrCodeScannerView');

        await renderScreen(<QrCodeScannerView
                    active={false}
                    title="t"
                    subtitle="s"
                    permissionRequiredMessage="perm"
                    onCancel={vi.fn()}
                    onScan={vi.fn()}
                    testIDPrefix="test"
                />);

        expect(lastCameraProps).toBeNull();
    });

    it('uses the screen canvas behind the native camera instead of painting a surface card', async () => {
        const { QrCodeScannerView } = await import('./QrCodeScannerView');

        const screen = await renderScreen(<QrCodeScannerView
                    title="t"
                    subtitle="s"
                    permissionRequiredMessage="perm"
                    onCancel={vi.fn()}
                    onScan={vi.fn()}
                    testIDPrefix="test"
                />);

        const camera = screen.root.findByProps({ testID: 'test-camera' });
        const rootStyle = flattenStyle(camera.parent?.props.style);
        expect(rootStyle.backgroundColor).toBe(lightTheme.colors.background.canvas);
    });

    it('renders a high-contrast close affordance over the camera preview', async () => {
        const { QrCodeScannerView } = await import('./QrCodeScannerView');

        const screen = await renderScreen(<QrCodeScannerView
                    title="t"
                    subtitle="s"
                    permissionRequiredMessage="perm"
                    onCancel={vi.fn()}
                    onScan={vi.fn()}
                    testIDPrefix="test"
                />);

        const closeButton = screen.root.findByProps({ testID: 'test-close' });
        const closeIcon = screen.root.findByProps({ testID: 'test-close-icon' });
        const closeStyle = flattenStyle(closeButton.props.style);
        const closeIconStyle = flattenStyle(closeIcon.props.style);
        expect(closeStyle.backgroundColor).toBe(lightTheme.colors.overlay.foreground);
        expect(closeIconStyle.color).toBe(lightTheme.colors.text.primary);
    });

    it('auto-requests camera permission on web instead of waiting for a manual retry tap', async () => {
        deviceState.platformOs = 'web';
        deviceState.windowWidth = 360;
        deviceState.windowHeight = 800;
        cameraState.permission = { granted: false };
        vi.stubGlobal('navigator', { maxTouchPoints: 5, mediaDevices: { getUserMedia: async () => ({}) } } as any);

        const { QrCodeScannerView } = await import('./QrCodeScannerView');

        await renderScreen(<QrCodeScannerView
                    title="t"
                    permissionRequiredMessage="perm"
                    onCancel={vi.fn()}
                    onScan={vi.fn()}
                    testIDPrefix="test"
                />);

        expect(cameraState.requestPermission).toHaveBeenCalledTimes(1);
    });

    it('guarantees a non-zero preview surface for embedded web scanners', async () => {
        deviceState.platformOs = 'web';
        deviceState.windowWidth = 360;
        deviceState.windowHeight = 800;
        vi.stubGlobal('navigator', { maxTouchPoints: 5, mediaDevices: { getUserMedia: async () => ({}) } } as any);

        const { QrCodeScannerView } = await import('./QrCodeScannerView');

        const screen = await renderScreen(<QrCodeScannerView
                    embedded
                    title="t"
                    permissionRequiredMessage="perm"
                    onCancel={vi.fn()}
                    onScan={vi.fn()}
                    testIDPrefix="test"
                />);

        const matchingView = screen.findAllByType('View' as any).find((node) => {
            const style = flattenStyle(node.props.style);
            return typeof style.minHeight === 'number' && style.minHeight > 0;
        });

        expect(matchingView).toBeTruthy();
    });

    it('renders a camera scanner on desktop web when camera APIs exist', async () => {
        deviceState.platformOs = 'web';
        deviceState.windowWidth = 1400;
        deviceState.windowHeight = 900;
        vi.stubGlobal('navigator', {
            maxTouchPoints: 0,
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
            mediaDevices: { getUserMedia: async () => ({}) },
        } as any);

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

    it('does not render a camera scanner on web when camera APIs are unavailable', async () => {
        deviceState.platformOs = 'web';
        deviceState.windowWidth = 1400;
        deviceState.windowHeight = 900;
        vi.stubGlobal('navigator', {
            maxTouchPoints: 0,
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
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
