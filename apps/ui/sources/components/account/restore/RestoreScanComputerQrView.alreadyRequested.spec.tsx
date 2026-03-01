import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', () => ({
    View: 'View',
    ScrollView: 'ScrollView',
    ActivityIndicator: 'ActivityIndicator',
    Platform: {
        OS: 'web',
        select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
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

const modalAlertAsyncSpy = vi.fn(async () => {});
vi.mock('@/modal', () => ({
    Modal: { alertAsync: modalAlertAsyncSpy, prompt: vi.fn(async () => null) },
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
    pairingRequest: vi.fn(async () => ({ ok: false, reason: 'already_requested', status: 401 })),
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

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
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
    }),
    StyleSheet: { create: (styles: any) => styles },
}));

let lastScannerProps: any = null;
vi.mock('@/components/qr/QrCodeScannerView', () => ({
    QrCodeScannerView: (props: any) => {
        lastScannerProps = props;
        return React.createElement('QrCodeScannerView', props);
    },
}));

describe('RestoreScanComputerQrView (already requested)', () => {
    it('shows a friendly error when the pairing session already has a requested device', async () => {
        vi.resetModules();
        modalAlertAsyncSpy.mockClear();
        lastScannerProps = null;

        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');

        let tree: ReturnType<typeof renderer.create> | null = null;
        try {
            await act(async () => {
                tree = renderer.create(<RestoreScanComputerQrView />);
            });
            if (!tree) throw new Error('Expected renderer');
            expect(typeof lastScannerProps?.onScan).toBe('function');

            await act(async () => {
                await lastScannerProps.onScan('happier:///pair?v=1&pairId=pair_123&secret=secret_123');
            });

            expect(modalAlertAsyncSpy).toHaveBeenCalledWith(
                'connect.pairingAlreadyRequestedTitle',
                'connect.pairingAlreadyRequestedBody',
            );
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
