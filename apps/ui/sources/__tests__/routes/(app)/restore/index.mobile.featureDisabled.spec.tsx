import * as React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: {
        OS: 'ios',
        select: (options: any) => options?.ios ?? options?.default ?? options?.web ?? options?.android,
    },
    Dimensions: {
        get: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
    },
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
}));

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'disabled' }),
}));

vi.mock('@/utils/platform/qrScannerSupport', () => ({
    isWebQrScannerSupported: () => false,
}));

vi.mock('@/components/account/restore/RestoreQrView', () => ({
    RestoreQrView: () => React.createElement('div', { 'data-testid': 'RestoreQrView' }),
}));

vi.mock('@/components/account/restore/RestoreScanComputerQrView', () => ({
    RestoreScanComputerQrView: () => React.createElement('div', { 'data-testid': 'RestoreScanComputerQrView' }),
}));

afterEach(() => {
    vi.restoreAllMocks();
});

describe('/restore (mobile, feature disabled)', () => {
    it('renders the scan-desktop restore flow (with fallback actions) when desktop QR scan is disabled', async () => {
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
