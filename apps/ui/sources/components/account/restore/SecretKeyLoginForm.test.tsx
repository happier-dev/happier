import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import type {
    AuthCredentialLifecycleResult,
} from '@/auth/context/AuthContext';
import type {
    AccountEncryptionFirstKeyCredentialMutationResult,
    AccountEncryptionFirstKeyRecoveryHandle,
} from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';

const loginSpy = vi.hoisted(() => vi.fn<
    (...args: unknown[]) => Promise<AuthCredentialLifecycleResult>
>(async () => ({ kind: 'completed' })));
const replaceSpy = vi.hoisted(() => vi.fn());
const dismissToSpy = vi.hoisted(() => vi.fn());
const trackAccountRestoredSpy = vi.hoisted(() => vi.fn());
const authGetTokenSpy = vi.hoisted(() => vi.fn<(secret: Uint8Array) => Promise<string>>(async (_secret) => 'tok_restore'));
const activateStackRuntimeServerSpy = vi.hoisted(() => vi.fn());
const guardCredentialMutationSpy = vi.hoisted(() =>
    vi.fn<
        (
            target?: Readonly<{
                serverUrl: string;
                serverId?: string;
            }>,
        ) => Promise<AccountEncryptionFirstKeyCredentialMutationResult>
    >(async () => ({ kind: 'allowed' })),
);
const modalShowSpy = vi.hoisted(() => vi.fn(
    (config: { onRequestClose?: () => void }) => {
        config.onRequestClose?.();
        return 'modal-id';
    },
));

const expoRouterMock = createExpoRouterMock({
    router: {
        replace: (value: unknown) => replaceSpy(value),
        dismissTo: (value: unknown) => dismissToSpy(value),
    },
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('expo-router', () => expoRouterMock.module);

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

vi.mock('@/sync/domains/server/stackRuntimeServer', () => ({
    activateStackRuntimeServer: activateStackRuntimeServerSpy,
    readStackRuntimeServerUrl: () => 'https://stack.example.test',
}));

vi.mock(
    '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth',
    () => ({
        guardAccountEncryptionFirstKeyCredentialMutation:
            guardCredentialMutationSpy,
        abandonAccountEncryptionFirstKeyExternalAuth:
            vi.fn(async () => ({ kind: 'abandoned' as const })),
    }),
);

vi.mock('@/encryption/base64', () => ({
    decodeBase64: () => new Uint8Array(32).fill(1),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: { show: modalShowSpy },
    }).module;
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
        loginSpy.mockResolvedValue({ kind: 'completed' });
        replaceSpy.mockReset();
        dismissToSpy.mockReset();
        trackAccountRestoredSpy.mockReset();
        authGetTokenSpy.mockReset();
        authGetTokenSpy.mockResolvedValue('tok_restore');
        activateStackRuntimeServerSpy.mockReset();
        guardCredentialMutationSpy.mockReset();
        guardCredentialMutationSpy.mockResolvedValue({
            kind: 'allowed',
        });
        modalShowSpy.mockClear();
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
        expect(replaceSpy).not.toHaveBeenCalled();
        expect(dismissToSpy).toHaveBeenCalledWith('/');
    });

    it('re-anchors the active server to the stack runtime server before completing restore login', async () => {
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

        expect(activateStackRuntimeServerSpy).toHaveBeenCalledWith({ scope: 'device' });
        expect(loginSpy).toHaveBeenCalledWith('tok_restore', 'secret-key');
    });

    it('does not track or navigate when restore credential recovery fails', async () => {
        loginSpy.mockResolvedValueOnce({ kind: 'recovery_failed' });
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
        expect(trackAccountRestoredSpy).not.toHaveBeenCalled();
        expect(replaceSpy).not.toHaveBeenCalled();
        expect(dismissToSpy).not.toHaveBeenCalled();
    });

    it('guards the known stack target before activating it', async () => {
        const recovery =
            {} as AccountEncryptionFirstKeyRecoveryHandle;
        guardCredentialMutationSpy.mockImplementation(
            async (target?: { serverUrl?: string }) =>
                target?.serverUrl === 'https://stack.example.test'
                    ? {
                        kind: 'finish_encryption_setup' as const,
                        recovery,
                    }
                    : { kind: 'allowed' as const },
        );
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

        expect(guardCredentialMutationSpy).toHaveBeenCalledWith({
            serverUrl: 'https://stack.example.test',
        });
        expect(modalShowSpy).toHaveBeenCalledTimes(1);
        expect(activateStackRuntimeServerSpy).not.toHaveBeenCalled();
        expect(authGetTokenSpy).not.toHaveBeenCalled();
        expect(loginSpy).not.toHaveBeenCalled();
    });

    it('gives the secret-key input its accessible name', async () => {
        const { SecretKeyLoginForm } = await import('./SecretKeyLoginForm');
        const screen = await renderScreen(<SecretKeyLoginForm />);

        expect(screen.findByTestId('restore-manual-secret-input')?.props.accessibilityLabel)
            .toBe('connect.secretKeyInputLabel');
    });
});
