import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { RestoreIndexEmbedded } from './RestoreIndexEmbedded';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
        useWindowDimensions: () => ({ width: 1400, height: 900 }),
    });
});

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
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
    it('opens the existing scanner first for the explicit add-home intent', async () => {
        lastScanProps = null;
        lastQrProps = null;

        let tree!: renderer.ReactTestRenderer;
        try {
            await act(async () => {
                tree = renderer.create(
                    <RestoreIndexEmbedded entryIntent="add_home" onBack={vi.fn()} />,
                );
            });

            expect(tree.root.findByType('scan')).toBeTruthy();
            expect((lastScanProps as { entryIntent?: string } | null)?.entryIntent).toBe('add_home');
            expect(lastQrProps).toBeNull();
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('defaults to the QR view and lets the user explicitly switch into the scanner', async () => {
        lastScanProps = null;
        lastQrProps = null;

        const onBack = vi.fn();
        const onOpenSecretKeyLogin = vi.fn();
        let tree!: renderer.ReactTestRenderer;
        try {
            await act(async () => {
                tree = renderer.create(
                    <RestoreIndexEmbedded entryIntent="enter_home" reverseTargetProfileId="home-b" onBack={onBack} onOpenSecretKeyLogin={onOpenSecretKeyLogin} />,
                );
            });

            expect(tree.root.findByType('qr')).toBeTruthy();
            expect((lastQrProps as { embedded?: boolean } | null)?.embedded).toBe(true);
            expect((lastQrProps as { entryIntent?: string } | null)?.entryIntent).toBe('enter_home');
            expect((lastQrProps as { onOpenScanQr?: () => void } | null)?.onOpenScanQr).toBeInstanceOf(Function);

            await act(async () => {
                (lastQrProps as { onOpenScanQr: () => void }).onOpenScanQr();
            });

            expect(tree.root.findByType('scan')).toBeTruthy();
            expect((lastScanProps as { embedded?: boolean } | null)?.embedded).toBe(true);
            expect((lastScanProps as { entryIntent?: string } | null)?.entryIntent).toBe('enter_home');
            expect((lastScanProps as { onShowQrInstead?: () => void } | null)?.onShowQrInstead).toBeInstanceOf(Function);

            await act(async () => {
                (lastScanProps as { onBack: () => void }).onBack();
            });

            expect(tree.root.findByType('qr')).toBeTruthy();
            expect(onBack).not.toHaveBeenCalled();
            await act(async () => {
                (lastQrProps as { onBack: () => void }).onBack();
            });
            expect(onBack).toHaveBeenCalledOnce();
            expect((lastQrProps as { onOpenSecretKeyLogin?: () => void } | null)?.onOpenSecretKeyLogin).toBe(onOpenSecretKeyLogin);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
