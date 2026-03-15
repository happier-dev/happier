import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('expo-constants', () => ({
    default: { deviceName: 'Test iPhone' },
}));

vi.mock('react-native', () => ({
    View: 'View',
    ScrollView: 'ScrollView',
    ActivityIndicator: 'ActivityIndicator',
    Platform: {
        OS: 'ios',
        select: (options: any) => options?.ios ?? options?.default ?? options?.web ?? options?.android,
    },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ login: vi.fn(async () => {}), refreshFromActiveServer: vi.fn(async () => {}) }),
}));

vi.mock('@/modal', () => ({
    Modal: { alertAsync: vi.fn(async () => {}), prompt: vi.fn(async () => null) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: 'RoundButton',
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
    authQRStart: vi.fn(async () => false),
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

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                text: '#000',
                textSecondary: '#666',
                divider: '#ddd',
            },
        },
    }),
    StyleSheet: { create: (styles: any) => styles },
}));

let lastScannerProps: any = null;
vi.mock('@/components/qr/QrCodeScannerView', () => ({
    QrCodeScannerView: (props: any) => {
        lastScannerProps = props;
        return React.createElement('div', { 'data-testid': 'QrCodeScannerView' });
    },
}));

describe('RestoreScanComputerQrView (loopback serverUrl)', () => {
    it('does not switch active server to localhost when scanning a pairing link', async () => {
        vi.resetModules();
        upsertActivateAndSwitchServerSpy.mockClear();
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
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});

