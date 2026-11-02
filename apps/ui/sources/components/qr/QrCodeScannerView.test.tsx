import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { lightTheme } from '@/theme';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const deviceState = vi.hoisted(() => ({
    platformOs: 'ios' as 'ios' | 'web',
    windowWidth: 360,
    windowHeight: 800,
    safeAreaInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    realWebPermissions: false,
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...flattenStyle(entry),
        }), {});
    }
    return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
}

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

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => deviceState.safeAreaInsets,
}));

vi.mock('@expo/vector-icons', async () => {
    const ReactModule = await import('react');
    return {
        Ionicons: (props: Record<string, unknown>) => ReactModule.createElement('Ionicons', props),
    };
});

// Keep Expo's permission hook and browser permission implementation real. Only
// the camera preview and browser APIs are boundaries in the permission regression.
vi.mock('expo-modules-core', async () => {
    const { createRequire } = await import('node:module');
    const appRequire = createRequire(import.meta.url);
    const coreRequire = createRequire(appRequire.resolve('expo-modules-core/package.json'));
    const core = await import('@/dev/expoModulesCoreStub');
    const { UnavailabilityError } = await vi.importActual<typeof import('expo-modules-core')>(
        coreRequire.resolve('./src/errors/UnavailabilityError.ts'),
    );
    return { ...core, UnavailabilityError };
});

let lastCameraProps: any = null;
vi.mock('expo-camera', async () => {
    const { createRequire } = await import('node:module');
    const appRequire = createRequire(import.meta.url);
    const coreRequire = createRequire(appRequire.resolve('expo-modules-core/package.json'));
    const { createPermissionHook } = await vi.importActual<typeof import('expo-modules-core')>(
        coreRequire.resolve('./src/PermissionsHook.ts'),
    );
    const cameraRequire = createRequire(appRequire.resolve('expo-camera/package.json'));
    const { default: camera } = await vi.importActual<{
        default: Pick<typeof import('expo-camera').Camera, 'getCameraPermissionsAsync' | 'requestCameraPermissionsAsync'>;
    }>(cameraRequire.resolve('./src/ExpoCameraManager.web.ts'));
    const useWebPermissions = createPermissionHook({
        getMethod: () => camera.getCameraPermissionsAsync(),
        requestMethod: () => camera.requestCameraPermissionsAsync(),
    });
    return {
        CameraView: (props: any) => {
            lastCameraProps = props;
            return React.createElement('CameraView', props);
        },
        useCameraPermissions: (options?: Parameters<typeof useWebPermissions>[0]) => deviceState.realWebPermissions
            ? useWebPermissions(options)
            : [{ granted: true }, vi.fn(async () => ({ granted: true }))],
    };
});

describe('QrCodeScannerView', () => {
    beforeEach(() => {
        lastCameraProps = null;
        deviceState.platformOs = 'ios';
        deviceState.windowWidth = 360;
        deviceState.windowHeight = 800;
        deviceState.safeAreaInsets = { top: 0, bottom: 0, left: 0, right: 0 };
        deviceState.realWebPermissions = false;
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

    it('requests camera access on user action when the browser cannot query permissions', async () => {
        deviceState.platformOs = 'web';
        deviceState.realWebPermissions = true;
        const track = { stop: vi.fn() };
        const stream = { getTracks: () => [track], removeTrack: vi.fn() };
        const getUserMedia = vi.fn(async () => stream);
        vi.stubGlobal('navigator', { maxTouchPoints: 5, mediaDevices: { getUserMedia } });
        const { QrCodeScannerView } = await import('./QrCodeScannerView');

        const screen = await renderScreen(<QrCodeScannerView
            title="t"
            permissionRequiredMessage="perm"
            onCancel={vi.fn()}
            onScan={vi.fn()}
            testIDPrefix="test"
        />);

        expect(getUserMedia).not.toHaveBeenCalled();
        const request = screen.root.findByProps({ testID: 'test-retry-permission' });
        await React.act(async () => { await request.props.action(); });

        expect(getUserMedia).toHaveBeenCalledWith({ video: true });
        expect(track.stop).toHaveBeenCalled();
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

    it('offsets overlay controls by the safe area while keeping the camera full-bleed', async () => {
        deviceState.safeAreaInsets = { top: 44, bottom: 34, left: 0, right: 0 };

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
        const overlay = closeButton.parent?.parent;
        expect(overlay).toBeTruthy();
        const overlayStyle = flattenStyle(overlay!.props.style);
        expect(overlayStyle.paddingTop).toBe(62);
        expect(overlayStyle.paddingBottom).toBe(52);
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
        expect(closeStyle.backgroundColor).toBe(lightTheme.colors.overlay.foreground);
        expect(closeIcon.props.color).toBe(lightTheme.colors.text.primary);
    });
});
