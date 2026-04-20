import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios ?? spec.default ?? spec.web },
        useWindowDimensions: () => ({ width: 390, height: 844 }),
    });
});

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

vi.mock('@/utils/platform/qrScannerSupport', () => ({
    isWebQrScannerSupported: () => true,
    canUseCurrentDeviceQrScanner: () => true,
}));

let lastScanProps: any = null;
vi.mock('@/components/account/restore/RestoreScanComputerQrView', () => ({
    RestoreScanComputerQrView: (props: any) => {
        lastScanProps = props;
        return React.createElement('scan');
    },
}));

let lastQrProps: any = null;
vi.mock('@/components/account/restore/RestoreQrView', () => ({
    RestoreQrView: (props: any) => {
        lastQrProps = props;
        return React.createElement('qr');
    },
}));

describe('RestoreIndexEmbedded', () => {
    it('switches from scanner-first to the QR view via an embedded callback (no route push)', async () => {
        vi.resetModules();
        lastScanProps = null;
        lastQrProps = null;

        const onBack = vi.fn();
        const onOpenSecretKeyLogin = vi.fn();
        const { RestoreIndexEmbedded } = await import('./RestoreIndexEmbedded');

        let tree!: renderer.ReactTestRenderer;
        try {
            await act(async () => {
                tree = renderer.create(
                    <RestoreIndexEmbedded onBack={onBack} onOpenSecretKeyLogin={onOpenSecretKeyLogin} />,
                );
            });

            expect(tree.root.findByType('scan')).toBeTruthy();
            expect(lastScanProps?.embedded).toBe(true);
            expect(lastScanProps?.onShowQrInstead).toBeInstanceOf(Function);

            await act(async () => {
                lastScanProps.onShowQrInstead();
            });

            expect(tree.root.findByType('qr')).toBeTruthy();
            expect(lastQrProps?.embedded).toBe(true);
            expect(lastQrProps?.onBack).toBe(onBack);
            expect(lastQrProps?.onOpenSecretKeyLogin).toBe(onOpenSecretKeyLogin);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
