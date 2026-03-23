import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
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
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { back: vi.fn(), push: vi.fn(), replace: vi.fn() },
        });
        return routerMock.module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alertAsync: modalAlertAsyncSpy,
                prompt: vi.fn(async () => null),
            },
        }).module;
    },
});

vi.mock('expo-constants', () => ({
    default: { deviceName: 'Test iPhone' },
}));

const modalAlertAsyncSpy = vi.fn(async () => {});

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ login: vi.fn(async () => {}), refreshFromActiveServer: vi.fn(async () => {}) }),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => 'https://lan.example.test:53288',
}));

const upsertActivateAndSwitchServerSpy = vi.fn(async () => {});
vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (s: string) => s,
    upsertActivateAndSwitchServer: upsertActivateAndSwitchServerSpy,
}));

vi.mock('@/auth/pairing/pairingUrl', () => ({
    buildPairingDeepLink: () => 'happier:///pair?v=1&pairId=p&secret=s&server=http%3A%2F%2Flocalhost%3A53288',
    parsePairingDeepLink: () => ({ pairId: 'p', secret: 's', serverUrl: 'http://localhost:53288' }),
}));

vi.mock('@/auth/flows/qrStart', () => ({
    generateAuthKeyPair: () => ({ publicKey: new Uint8Array([1]), secretKey: new Uint8Array([2]) }),
    authQRStart: vi.fn(async () => true),
}));

vi.mock('@/auth/flows/qrWait', () => ({
    authQRWait: vi.fn(async () => null),
}));

vi.mock('@/sync/api/account/apiPairingAuth', () => ({
    pairingRequest: vi.fn(async () => ({ ok: false, reason: 'not_found', status: 404 })),
}));

vi.mock('@/encryption/base64', () => ({
    encodeBase64: () => 'x',
}));

let lastScannerProps: any = null;
vi.mock('@/components/qr/QrCodeScannerView', () => ({
    QrCodeScannerView: (props: any) => {
        lastScannerProps = props;
        return React.createElement('div', { 'data-testid': 'QrCodeScannerView' });
    },
}));

describe('RestoreScanComputerQrView (loopback serverUrl)', () => {
    it('does not switch to localhost and shows a server-setup hint when pairing returns not_found', async () => {
        vi.resetModules();
        upsertActivateAndSwitchServerSpy.mockClear();
        modalAlertAsyncSpy.mockClear();
        lastScannerProps = null;

        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');

        let tree: ReactTestRenderer | null = null;
        try {
            await act(async () => {
                tree = create(<RestoreScanComputerQrView />);
            });

            expect(lastScannerProps?.onScan).toBeInstanceOf(Function);

            await act(async () => {
                await lastScannerProps.onScan('happier:///pair?v=1&pairId=p&secret=s&server=http%3A%2F%2Flocalhost%3A53288');
            });

            expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
            expect(modalAlertAsyncSpy).toHaveBeenCalledWith(
                'connect.serverUrlNotEmbeddedTitle',
                'connect.serverUrlNotEmbeddedBody',
            );
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
