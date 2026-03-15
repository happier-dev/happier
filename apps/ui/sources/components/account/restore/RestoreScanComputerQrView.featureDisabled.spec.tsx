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
        OS: 'ios',
        select: (options: any) => options?.ios ?? options?.default ?? options?.web ?? options?.android,
    },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'disabled' }),
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

let scannerRendered = false;
vi.mock('@/components/qr/QrCodeScannerView', () => ({
    QrCodeScannerView: (props: any) => {
        scannerRendered = true;
        return React.createElement('QrCodeScannerView', props);
    },
}));

function textContent(node: ReactTestInstance): string {
    const c = node.props?.children;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : '')).join('');
    return '';
}

describe('RestoreScanComputerQrView (feature disabled)', () => {
    it('renders a fallback UX instead of the scanner', async () => {
        vi.resetModules();
        scannerRendered = false;

        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');

        let tree: ReactTestRenderer | null = null;
        act(() => {
            tree = create(<RestoreScanComputerQrView />);
        });

        try {
            expect(scannerRendered).toBe(false);

            const texts = tree!.root.findAll((node: ReactTestInstance) => (node.type as unknown) === 'Text');
            const joined = texts.map(textContent).join('\n');
            expect(joined).toContain('connect.scanComputerQrUnavailableBody');

            const buttons = tree!.root.findAll((node: ReactTestInstance) => (node.type as unknown) === 'RoundButton');
            const testIds = buttons
                .map((node: ReactTestInstance) => String(node.props?.testID ?? ''))
                .filter(Boolean);
            expect(testIds).toContain('restore-open-manual');
            expect(testIds).toContain('restore-show-qr-instead');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
