import * as React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: {
        OS: 'web',
        select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
    },
    Dimensions: {
        get: () => ({ width: 360, height: 800, scale: 2, fontScale: 1 }),
    },
    useWindowDimensions: () => ({ width: 360, height: 800, scale: 2, fontScale: 1 }),
}));

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
});

describe('/restore (web phone)', () => {
    it('defaults to the scan-desktop restore flow on phone-sized web', async () => {
        vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' } as any);

        vi.resetModules();
        const { default: Screen } = await import('@/app/(app)/restore/index');

        let tree: ReactTestRenderer | null = null;
        try {
            act(() => {
                tree = create(<Screen />);
            });
            const scanner = tree!.root.findAllByProps({ 'data-testid': 'RestoreScanComputerQrView' });
            expect(scanner).toHaveLength(1);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
