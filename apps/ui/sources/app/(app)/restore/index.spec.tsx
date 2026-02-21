import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

const pushSpy = vi.fn();
vi.mock('expo-router', () => ({
    useRouter: () => ({ back: vi.fn(), push: pushSpy, replace: vi.fn() }),
    useLocalSearchParams: () => ({
        provider: 'github',
        reason: 'provider_already_linked',
    }),
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    ScrollView: 'ScrollView',
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web' },
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ login: vi.fn(async () => {}) }),
}));

vi.mock('@/auth/providers/registry', () => ({
    getAuthProvider: () => ({
        id: 'github',
        displayName: 'GitHub',
        getRestoreRedirectNotice: () => ({
            title: 'GitHub verified',
            body: 'Restore your account key to finish signing in.',
        }),
    }),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: 'RoundButton',
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1024 },
}));

vi.mock('@/auth/flows/qrStart', () => ({
    generateAuthKeyPair: () => ({ publicKey: new Uint8Array([1]), secretKey: new Uint8Array([2]) }),
    authQRStart: vi.fn(async () => false),
}));

vi.mock('@/auth/flows/qrWait', () => ({
    authQRWait: vi.fn(async () => null),
}));

vi.mock('@/encryption/base64', () => ({
    encodeBase64: () => 'x',
}));

vi.mock('@/components/qr/QRCode', () => ({
    QRCode: 'QRCode',
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(async () => {}),
    },
}));

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: vi.fn(async () => null),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => {
        void promise;
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                text: '#000',
                textSecondary: '#666',
            },
        },
    }),
    StyleSheet: { create: (styles: any) => styles },
}));

afterEach(() => {
    vi.restoreAllMocks();
});

function textContent(node: renderer.ReactTestInstance): string {
    const c = node.props?.children;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : '')).join('');
    return '';
}

describe('/restore', () => {
    it('shows provider-specific restore notice when redirected after external auth', async () => {
        vi.resetModules();
        const { default: Screen } = await import('./index');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<Screen />);
            });
            if (!tree) throw new Error('Expected renderer');

            const texts = tree.root.findAll((node) => (node.type as unknown) === 'Text');
            const joined = texts.map(textContent).join('\n');

            expect(joined).toContain('GitHub verified');
            expect(joined).toContain('Restore your account key to finish signing in.');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
