import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import {
    installRestoreRouteCommonModuleMocks,
    resetRestoreRouteTestState,
} from './restoreRouteTestHelpers';

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
                select: (options: {
                    web?: unknown;
                    default?: unknown;
                    ios?: unknown;
                    android?: unknown;
                }) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
            },
            Dimensions: {
                get: () => ({ width: 360, height: 800, scale: 2, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: 360, height: 800, scale: 2, fontScale: 1 }),
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

describe('/restore (web phone)', () => {
    it('defaults to the scan-desktop restore flow on phone-sized web', async () => {
        vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' } as any);

        vi.resetModules();
        const { default: Screen } = await import('@/app/(app)/restore/index');

        const screen = await renderScreen(<Screen />);
        await flushHookEffects();
        const scanner = screen.findAllByProps({ 'data-testid': 'RestoreScanComputerQrView' });
        expect(scanner).toHaveLength(1);
    });
});
