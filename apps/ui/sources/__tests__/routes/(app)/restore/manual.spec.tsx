import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackSpy = vi.hoisted(() => vi.fn());
const routerReplaceSpy = vi.hoisted(() => vi.fn());
const authLoginSpy = vi.hoisted(() => vi.fn(async () => {}));
const normalizeSecretKeySpy = vi.hoisted(() => vi.fn((input: string) => input.trim()));

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    TextInput: 'TextInput',
    ScrollView: 'ScrollView',
    ActivityIndicator: 'ActivityIndicator',
    AppState: {
        addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    },
    Platform: { OS: 'web' },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ back: routerBackSpy, push: vi.fn(), replace: routerReplaceSpy }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ login: authLoginSpy }),
}));

vi.mock('@/auth/flows/getToken', () => ({
    authGetToken: vi.fn(async () => 'token'),
}));

vi.mock('@/auth/recovery/secretKeyBackup', () => ({
    normalizeSecretKey: normalizeSecretKeySpy,
}));

vi.mock('@/encryption/base64', () => ({
    decodeBase64: vi.fn((_value: string, _encoding: string) => new Uint8Array(32)),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: 'RoundButton',
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1024 },
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(async () => {}),
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
                textSecondary: '#666',
                input: { background: '#fff', text: '#000', placeholder: '#999' },
            },
        },
    }),
    StyleSheet: { create: (styles: any) => styles },
}));

afterEach(() => {
    vi.restoreAllMocks();
});

describe('/restore/manual', () => {
    it('does not auto-capitalize secret key input (supports case-sensitive base64url input)', async () => {
        vi.resetModules();
        const { default: Screen } = await import('./manual');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<Screen />);
            });
            if (!tree) throw new Error('Expected renderer');

            const inputs = tree.root.findAll((node) => (node.type as unknown) === 'TextInput');
            expect(inputs.length).toBeGreaterThan(0);
            expect(inputs[0]?.props?.autoCapitalize).toBe('none');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('replaces navigation to home after a successful restore (does not return to link-new-device QR screen)', async () => {
        vi.resetModules();
        const { default: Screen } = await import('./manual');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<Screen />);
            });
            if (!tree) throw new Error('Expected renderer');

            const input = tree.root.find((node) => (node.props as any)?.testID === 'restore-manual-secret-input');
            await act(async () => {
                input.props.onChangeText?.('secret-key');
            });

            const submit = tree.root.find((node) => (node.props as any)?.testID === 'restore-manual-submit');
            await act(async () => {
                await submit.props.action?.();
            });

            expect(authLoginSpy).toHaveBeenCalled();
            expect(normalizeSecretKeySpy).toHaveBeenCalled();
            expect(routerBackSpy).not.toHaveBeenCalled();
            expect(routerReplaceSpy).toHaveBeenCalledWith('/');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
