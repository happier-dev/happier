import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    TextInput: 'TextInput',
    ScrollView: 'ScrollView',
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web' },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ login: vi.fn(async () => {}) }),
}));

vi.mock('@/auth/flows/getToken', () => ({
    authGetToken: vi.fn(async () => 'token'),
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
});
