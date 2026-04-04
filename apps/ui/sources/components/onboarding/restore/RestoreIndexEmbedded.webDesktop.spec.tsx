import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    useWindowDimensions: () => ({ width: 1400, height: 900 }),
}));

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

vi.mock('@/utils/platform/webMobileHeuristics', () => ({
    isWebMobileLikeQrScannerHost: () => false,
}));

vi.mock('@/utils/platform/qrScannerSupport', () => ({
    isWebQrScannerSupported: () => true,
    canUseCurrentDeviceQrScanner: () => true,
}));

let lastScanProps: unknown = null;
vi.mock('@/components/account/restore/RestoreScanComputerQrView', () => ({
    RestoreScanComputerQrView: (props: unknown) => {
        lastScanProps = props;
        return React.createElement('scan');
    },
}));

let lastQrProps: unknown = null;
vi.mock('@/components/account/restore/RestoreQrView', () => ({
    RestoreQrView: (props: unknown) => {
        lastQrProps = props;
        return React.createElement('qr');
    },
}));

describe('RestoreIndexEmbedded (web desktop)', () => {
    it('defaults to the QR view and lets the user explicitly switch into the scanner', async () => {
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

            expect(tree.root.findByType('qr')).toBeTruthy();
            expect((lastQrProps as { embedded?: boolean } | null)?.embedded).toBe(true);
            expect((lastQrProps as { onOpenScanQr?: () => void } | null)?.onOpenScanQr).toBeInstanceOf(Function);

            await act(async () => {
                (lastQrProps as { onOpenScanQr: () => void }).onOpenScanQr();
            });

            expect(tree.root.findByType('scan')).toBeTruthy();
            expect((lastScanProps as { embedded?: boolean } | null)?.embedded).toBe(true);
            expect((lastScanProps as { onShowQrInstead?: () => void } | null)?.onShowQrInstead).toBeInstanceOf(Function);

            await act(async () => {
                (lastScanProps as { onShowQrInstead: () => void }).onShowQrInstead();
            });

            expect(tree.root.findByType('qr')).toBeTruthy();
            expect((lastQrProps as { onBack?: () => void } | null)?.onBack).toBe(onBack);
            expect((lastQrProps as { onOpenSecretKeyLogin?: () => void } | null)?.onOpenSecretKeyLogin).toBe(onOpenSecretKeyLogin);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
