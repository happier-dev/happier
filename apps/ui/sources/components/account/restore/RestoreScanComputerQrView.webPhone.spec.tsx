import * as React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
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

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ login: vi.fn(async () => {}), refreshFromActiveServer: vi.fn(async () => {}) }),
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(async () => {}), prompt: vi.fn(async () => null) },
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

vi.mock('@/sync/api/account/apiPairingAuth', () => ({
    pairingRequest: vi.fn(async () => ({ ok: false, reason: 'not_found', status: 404 })),
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

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (s: string) => s,
    upsertActivateAndSwitchServer: vi.fn(async () => {}),
}));

vi.mock('@/auth/pairing/pairingUrl', () => ({
    buildPairingDeepLink: () => 'happier:///pair?v=1&pairId=p&secret=s',
    parsePairingDeepLink: () => null,
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

describe('RestoreScanComputerQrView (web phone)', () => {
    it('renders the QR scanner in idle state on web', async () => {
        vi.resetModules();
        lastScannerProps = null;

        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');

        let tree: ReactTestRenderer | null = null;
        act(() => {
            tree = create(<RestoreScanComputerQrView />);
        });

        try {
            const nodes = tree!.root.findAllByProps({ 'data-testid': 'QrCodeScannerView' });
            expect(nodes).toHaveLength(1);
            expect(lastScannerProps?.testIDPrefix).toBe('restore-scan');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
