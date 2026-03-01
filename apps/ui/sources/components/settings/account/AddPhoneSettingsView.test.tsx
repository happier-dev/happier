import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0 as any);
vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

vi.mock('react-native', () => ({
    View: 'View',
    ScrollView: 'ScrollView',
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    Platform: {
        OS: 'web',
        select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('@/components/qr/QRCode', () => ({
    QRCode: 'QRCode',
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: 'RoundButton',
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(async () => {}),
        alertAsync: vi.fn(async () => {}),
    },
}));

const AUTH_FIXTURE = Object.freeze({
    isAuthenticated: true,
    credentials: Object.freeze({ token: 't', secret: 's' }),
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => AUTH_FIXTURE,
}));

let featureState: 'enabled' | 'disabled' | 'unknown' = 'enabled';
vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: featureState }),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                text: '#000',
                textSecondary: '#666',
                divider: '#ddd',
                accent: { blue: 'blue' },
                input: { placeholder: '#999' },
            },
        },
    }),
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytes: () => new Uint8Array(32).fill(7),
}));

vi.mock('@/platform/digest', () => ({
    digest: vi.fn(async () => new Uint8Array(32).fill(1)),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => 'https://stack.example.test',
}));

const serverFetchSpy = vi.fn(async (path: string, _init?: any, _options?: any) => {
    if (path === '/v1/auth/pairing/start') {
        return {
            ok: true,
            status: 200,
            json: async () => ({ pairId: 'pair_123', expiresAt: '2026-02-23T00:00:00.000Z' }),
        } as any;
    }
    if (path.startsWith('/v1/auth/pairing/status')) {
        return pairingStatusResponse;
    }
    throw new Error(`Unexpected serverFetch path: ${path}`);
});

let pairingStatusResponse: any = {
    ok: true,
    status: 200,
    json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: '2026-02-23T00:00:00.000Z' }),
} as any;

vi.mock('@/sync/http/client', () => ({
    serverFetch: (path: string, init?: any, options?: any) => serverFetchSpy(path, init, options),
}));

describe('AddPhoneSettingsView', () => {
    it('renders a pairing QR code after starting a session', async () => {
        featureState = 'enabled';
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: '2026-02-23T00:00:00.000Z' }),
        } as any;
        const { AddPhoneSettingsView } = await import('./AddPhoneSettingsView');

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(<AddPhoneSettingsView />);
        });
        if (!tree) throw new Error('Expected renderer');

        const qr = tree.root.findByType('QRCode');
        expect(String(qr.props.data)).toContain('happier:///pair?v=1');
        expect(String(qr.props.data)).toContain('pairId=pair_123');
    });

    it('clears the QR code when the pairing session expires', async () => {
        featureState = 'enabled';
        pairingStatusResponse = {
            ok: false,
            status: 404,
            json: async () => ({ error: 'not_found' }),
        } as any;
        const { AddPhoneSettingsView } = await import('./AddPhoneSettingsView');

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(<AddPhoneSettingsView />);
        });
        if (!tree) throw new Error('Expected renderer');

        await act(async () => {
            await Promise.resolve();
        });

        const qrs = tree.root.findAllByType('QRCode');
        expect(qrs).toHaveLength(0);

        const textNodes = tree.root.findAllByType('Text');
        const allText = textNodes
            .map((node) => node.props.children)
            .flat()
            .filter((row) => typeof row === 'string')
            .join('\\n');
        expect(allText).toContain('connect.pairingQrExpired');
    });

    it('does not show a sign-in prompt when the feature is disabled', async () => {
        featureState = 'disabled';
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: '2026-02-23T00:00:00.000Z' }),
        } as any;
        const { AddPhoneSettingsView } = await import('./AddPhoneSettingsView');

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(<AddPhoneSettingsView />);
        });
        if (!tree) throw new Error('Expected renderer');

        const textNodes = tree.root.findAllByType('Text');
        const allText = textNodes
            .map((node) => node.props.children)
            .flat()
            .filter((row) => typeof row === 'string')
            .join('\n');

        expect(allText).toContain('common.unavailable');
        expect(allText).not.toContain('modals.pleaseSignInFirst');
    });
});
