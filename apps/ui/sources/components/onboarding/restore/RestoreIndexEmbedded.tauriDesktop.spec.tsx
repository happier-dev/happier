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
        Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
        useWindowDimensions: () => ({ width: 390, height: 844 }),
    });
});

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => true,
}));

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

vi.mock('@/utils/platform/webMobileHeuristics', () => ({
    isWebMobileLikeQrScannerHost: ({ width }: { width: number; height: number }) => width <= 430,
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

describe('RestoreIndexEmbedded (Tauri desktop)', () => {
    it('defaults to the QR view even when the window is phone-sized (uses physical screen size heuristics)', async () => {
        vi.resetModules();
        lastScanProps = null;
        lastQrProps = null;

        const originalScreen = (globalThis as unknown as { screen?: unknown }).screen;
        Object.defineProperty(globalThis, 'screen', {
            value: { width: 1440, height: 900, availWidth: 1440, availHeight: 900 },
            configurable: true,
        });

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
            expect(lastScanProps).toBeNull();
        } finally {
            Object.defineProperty(globalThis, 'screen', { value: originalScreen, configurable: true });
            act(() => {
                tree?.unmount();
            });
        }
    });
});
