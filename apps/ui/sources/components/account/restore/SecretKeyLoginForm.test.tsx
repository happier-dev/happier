import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const loginSpy = vi.hoisted(() => vi.fn(async () => {}));
const replaceSpy = vi.hoisted(() => vi.fn());
const trackAccountRestoredSpy = vi.hoisted(() => vi.fn());
const authGetTokenSpy = vi.hoisted(() => vi.fn<(secret: Uint8Array) => Promise<string>>(async (_secret) => 'tok_restore'));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('expo-router', () => ({
    useRouter: () => ({
        replace: replaceSpy,
    }),
}));

vi.mock('@expo/vector-icons/Ionicons', () => ({
    default: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        login: loginSpy,
    }),
}));

vi.mock('@/auth/flows/getToken', () => ({
    authGetToken: authGetTokenSpy as (secret: Uint8Array) => Promise<string>,
}));

vi.mock('@/auth/recovery/secretKeyBackup', () => ({
    normalizeSecretKey: (value: string) => value.trim(),
}));

vi.mock('@/encryption/base64', () => ({
    decodeBase64: () => new Uint8Array(32).fill(1),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                divider: '#ddd',
                surface: '#fff',
                textSecondary: '#666',
                input: {
                    background: '#fff',
                    text: '#000',
                    placeholder: '#999',
                },
            },
        },
    });
});

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: { children?: React.ReactNode } & Record<string, unknown>) =>
        React.createElement('Text', props, props.children ?? null),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));

vi.mock('@/track', () => ({
    trackAccountRestored: trackAccountRestoredSpy,
}));

describe('SecretKeyLoginForm', () => {
    beforeEach(() => {
        loginSpy.mockReset();
        replaceSpy.mockReset();
        trackAccountRestoredSpy.mockReset();
        authGetTokenSpy.mockReset();
        authGetTokenSpy.mockResolvedValue('tok_restore');
    });

    afterEach(() => {
        standardCleanup();
    });

    it('tracks account restoration after a successful secret-key login', async () => {
        const { SecretKeyLoginForm } = await import('./SecretKeyLoginForm');
        const screen = await renderScreen(<SecretKeyLoginForm />);
        const secretInput = screen.findByTestId('restore-manual-secret-input');
        const submitButton = screen.findByTestId('restore-manual-submit');
        if (!secretInput || !submitButton) {
            throw new Error('Expected restore secret input and submit button to render');
        }

        await act(async () => {
            secretInput.props.onChangeText('secret-key');
        });
        await act(async () => {
            await submitButton.props.action();
        });

        expect(loginSpy).toHaveBeenCalledWith('tok_restore', 'secret-key');
        expect(trackAccountRestoredSpy).toHaveBeenCalledTimes(1);
        expect(replaceSpy).toHaveBeenCalledWith('/');
    });
});
