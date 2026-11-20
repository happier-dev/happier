import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installRestoreScanComputerQrViewCommonModuleMocks } from './restoreScanComputerQrViewTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

installRestoreScanComputerQrViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            ScrollView: 'ScrollView',
            ActivityIndicator: 'ActivityIndicator',
            Platform: {
                OS: 'ios',
                select: (options: any) => options?.ios ?? options?.default ?? options?.web ?? options?.android,
            },
        });
    },
});

// The camera SDK is a native boundary; the scanner and its gate stay real.
vi.mock('expo-camera', () => ({ CameraView: 'CameraView',
    useCameraPermissions: () => [{ granted: true }, vi.fn()] }));

const { AuthProvider } = await import('@/auth/context/AuthContext');
const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');
const { QrCodeScannerView } = await import('@/components/qr/QrCodeScannerView');

describe('RestoreScanComputerQrView (feature disabled)', () => {
    beforeEach(() => {
        // A build-policy denial disables this device's scanner; a focused Home's
        // disabled server bit must still allow scanning another Home's invite.
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY', 'auth.pairing.boundQrV2');
    });

    afterEach(() => vi.unstubAllEnvs());

    it('renders a fallback UX instead of the scanner', async () => {
        const screen = await renderScreen(<AuthProvider initialCredentials={null}>
            <RestoreScanComputerQrView entryIntent="add_home" />
        </AuthProvider>);

        expect(screen.findAllByType(QrCodeScannerView)).toHaveLength(0);
        expect(screen.getTextContent()).toContain('connect.scanComputerQrUnavailableBody');
        expect(screen.findByTestId('restore-scan-unavailable')).not.toBeNull();
        expect(screen.findByTestId('restore-open-manual')).not.toBeNull();
        expect(screen.findByTestId('restore-show-qr-instead')).toBeNull();
    });
});
