import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            View: 'View',
                            ScrollView: 'ScrollView',
                            ActivityIndicator: 'ActivityIndicator',
                            Platform: {
                                OS: 'ios',
                                select: (options: any) => options?.ios ?? options?.default ?? options?.web ?? options?.android,
                            },
                        }
    );
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: { back: vi.fn(), push: vi.fn(), replace: vi.fn() },
    });
    return routerMock.module;
});

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'disabled' }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ login: vi.fn(async () => {}), refreshFromActiveServer: vi.fn(async () => {}) }),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alertAsync: vi.fn(async () => {}),
            prompt: vi.fn(async () => null),
        },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: 'RoundButton',
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => 'https://stack.example.test',
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (s: string) => s,
    upsertActivateAndSwitchServer: vi.fn(async () => {}),
}));

vi.mock('@/auth/pairing/pairingUrl', () => ({
    buildPairingDeepLink: () => 'happier:///pair?v=1&pairId=p&secret=s',
    parsePairingDeepLink: () => ({ pairId: 'pair_123', secret: 'secret_123', serverUrl: null }),
}));

vi.mock('@/sync/api/account/apiPairingAuth', () => ({
    pairingRequest: vi.fn(async () => ({ ok: true, data: { state: 'requested', confirmCode: '000 000' } })),
}));

vi.mock('@/auth/flows/qrStart', () => ({
    generateAuthKeyPair: () => ({ publicKey: new Uint8Array([1]), secretKey: new Uint8Array([2]) }),
    authQRStart: vi.fn(async () => true),
}));

vi.mock('@/auth/flows/qrWait', () => ({
    authQRWait: vi.fn(async () => null),
}));

vi.mock('@/encryption/base64', () => ({
    encodeBase64: () => 'x',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surface: '#fff',
                text: '#000',
                textSecondary: '#666',
                divider: '#ddd',
                overlay: {
                    scrim: 'rgba(0,0,0,0.3)',
                    scrimStrong: 'rgba(0,0,0,0.55)',
                    text: '#fff',
                    textSecondary: 'rgba(255,255,255,0.85)',
                },
            },
        },
    });
});

let scannerRendered = false;
vi.mock('@/components/qr/QrCodeScannerView', () => ({
    QrCodeScannerView: (props: any) => {
        scannerRendered = true;
        return React.createElement('QrCodeScannerView', props);
    },
}));

describe('RestoreScanComputerQrView (feature disabled)', () => {
    it('renders a fallback UX instead of the scanner', async () => {
        vi.resetModules();
        scannerRendered = false;

        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');

        const screen = await renderScreen(<RestoreScanComputerQrView />);

        expect(scannerRendered).toBe(false);
        expect(screen.getTextContent()).toContain('connect.scanComputerQrUnavailableBody');
        expect(screen.findByTestId('restore-open-manual')).not.toBeNull();
        expect(screen.findByTestId('restore-show-qr-instead')).not.toBeNull();
    });
});
