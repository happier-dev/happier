import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installRestoreRouteCommonModuleMocks, resetRestoreRouteTestState } from './restoreRouteTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

installRestoreRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
            },
            Dimensions: {
                get: () => ({ width: 1400, height: 900, scale: 2, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: 1400, height: 900, scale: 2, fontScale: 1 }),
        });
    },
});

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'phone',
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

vi.mock('@/utils/platform/qrScannerSupport', () => ({
    isWebQrScannerSupported: () => true,
}));

vi.mock('@/components/account/restore/RestoreQrView', () => ({
    RestoreQrView: () => React.createElement('div', { 'data-testid': 'RestoreQrView' }),
}));

vi.mock('@/components/account/restore/RestoreScanComputerQrView', () => ({
    RestoreScanComputerQrView: () => React.createElement('div', { 'data-testid': 'RestoreScanComputerQrView' }),
}));

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetRestoreRouteTestState();
});
describe('/restore (web desktop)', () => {
    it('defaults to the show-QR restore flow when the web environment is not mobile-like', async () => {
        vi.stubGlobal('navigator', {
            maxTouchPoints: 0,
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            mediaDevices: { getUserMedia: async () => ({}) },
        } as any);
        vi.stubGlobal('window', {
            matchMedia: () => ({ matches: false }),
        } as any);

        vi.resetModules();
        const { default: Screen } = await import('@/app/(app)/restore/index');

        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            screen = await renderScreen(<Screen />);
            await act(async () => {});
            const qrView = screen.findAllByType('div').filter((node) => node.props['data-testid'] === 'RestoreQrView');
            expect(qrView).toHaveLength(1);
        } finally {
            await act(async () => {
                screen?.tree.unmount();
            });
        }
    });
});
