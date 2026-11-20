import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { lightTheme } from '@/theme';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const deviceState = vi.hoisted(() => ({
    platformOs: 'ios' as 'ios' | 'web',
    windowWidth: 360,
    windowHeight: 800,
    realWebPermissions: false,
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

vi.mock('expo-device', () => ({
    isDevice: true,
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
            : [cameraState.permission, cameraState.requestPermission],
    };
});

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
        deviceState.realWebPermissions = false;
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

    it('requests camera access without querying an unavailable browser Permissions API', async () => {
        deviceState.platformOs = 'web';
        deviceState.realWebPermissions = true;
        const track = { stop: vi.fn() };
        const stream = { getTracks: () => [track], removeTrack: vi.fn() };
        const getUserMedia = vi.fn(async () => stream);
        vi.stubGlobal('navigator', { maxTouchPoints: 5, mediaDevices: { getUserMedia } });
        const { QrCodeScannerView } = await import('./QrCodeScannerView');

        await renderScreen(<QrCodeScannerView
            title="t"
            permissionRequiredMessage="perm"
            onCancel={vi.fn()}
            onScan={vi.fn()}
            testIDPrefix="test"
        />);

        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(getUserMedia).toHaveBeenCalledWith({ video: true });
        expect(track.stop).toHaveBeenCalled();
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

        expect(screen.findByTestId('test-camera')).toBeTruthy();
        const rootStyle = flattenStyle(screen.findByTestId('test-preview')?.props.style);
        expect(rootStyle.backgroundColor).toBe(lightTheme.colors.background.canvas);
    });

    it('renders a high-contrast close affordance over the camera preview', async () => {
        vi.stubGlobal('navigator', { maxTouchPoints: 1 });
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
        // A touch target is a hit area, not a drawn size (DESIGN.md): the 40 circle reaches 44 past its edge.
        expect(closeStyle.width).toBe(40);
        expect(closeStyle.height).toBe(40);
        expect(screen.findHostByTestId('test-close')?.props.hitSlop).toEqual({ top: 2, bottom: 2, left: 2, right: 2 });
        vi.unstubAllGlobals();
        expect(closeIcon.props.color).toBe(lightTheme.colors.text.primary);
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

    it('guarantees a non-zero preview surface for embedded native scanners', async () => {
        deviceState.platformOs = 'ios';
        deviceState.windowWidth = 360;
        deviceState.windowHeight = 800;

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

    it('keeps the manual-entry footer reachable when the camera is denied or unavailable', async () => {
        const { QrCodeScannerView } = await import('./QrCodeScannerView');
        const footer = React.createElement('ManualEntry', { testID: 'test-enter-url' });

        cameraState.permission = { granted: false };
        const denied = await renderScreen(<QrCodeScannerView
                    title="t"
                    permissionRequiredMessage="perm"
                    onCancel={vi.fn()}
                    onScan={vi.fn()}
                    footer={footer}
                    testIDPrefix="test"
                />);
        expect(denied.findAllByTestId('test-enter-url')).toHaveLength(1);

        deviceState.platformOs = 'web';
        vi.stubGlobal('navigator', {
            maxTouchPoints: 0,
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
        } as any);
        const unavailable = await renderScreen(<QrCodeScannerView
                    title="t"
                    permissionRequiredMessage="perm"
                    onCancel={vi.fn()}
                    onScan={vi.fn()}
                    footer={footer}
                    testIDPrefix="test"
                />);
        expect(unavailable.findAllByTestId('test-enter-url')).toHaveLength(1);
    });

    it('keeps manual entry and cancel reachable while the camera permission is undetermined', async () => {
        const { QrCodeScannerView } = await import('./QrCodeScannerView');
        const footer = React.createElement('ManualEntry', { testID: 'test-enter-url' });
        const onCancel = vi.fn();

        // `useCameraPermissions` reports `null` until the platform answers, and an
        // unanswered request leaves it there. A pasted pairing link and the exit must
        // stay reachable instead of stranding the screen on a spinner.
        cameraState.permission = null;
        const undetermined = await renderScreen(<QrCodeScannerView
                    title="t"
                    permissionRequiredMessage="perm"
                    onCancel={onCancel}
                    onScan={vi.fn()}
                    footer={footer}
                    testIDPrefix="test"
                />);

        expect(undetermined.findAllByTestId('test-enter-url')).toHaveLength(1);
        await undetermined.root.findByProps({ testID: 'test-cancel' }).props.action();
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('keeps the same manual-entry control as the camera permission changes', async () => {
        const { QrCodeScannerView } = await import('./QrCodeScannerView');
        const render = () => <QrCodeScannerView embedded title="t" permissionRequiredMessage="perm"
            onScan={vi.fn()} footer={React.createElement('ManualEntry', { testID: 'test-enter-url' })} testIDPrefix="test" />;
        cameraState.permission = null;
        const screen = await renderScreen(render());
        const original = screen.findHostByTestId('test-enter-url');
        expect(original).not.toBeNull();

        cameraState.permission = { granted: false };
        await screen.update(render());
        expect(screen.findHostByTestId('test-enter-url')).toBe(original);

        cameraState.permission = { granted: true };
        await screen.update(render());
        expect(screen.findHostByTestId('test-enter-url')).toBe(original);
    });
});
