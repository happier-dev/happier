import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import {
    createModalModuleMock,
} from '@/dev/testkit/mocks/modal';

const setPendingExternalAuthSpy =
    vi.hoisted(() => vi.fn(async () => true));
const getExternalAuthUrlSpy =
    vi.hoisted(() => vi.fn(async () => 'https://oauth.example.test'));
const guardCredentialMutationSpy =
    vi.hoisted(() => vi.fn(async () => ({
        kind: 'finish_encryption_setup' as const,
        recovery: {},
    })));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } =
        await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } =
        await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } =
        await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key) => key,
    });
});

const modalMock = createModalModuleMock({
    confirmResult: true,
    spies: {
        show: (config) => {
            config.onRequestClose?.();
            return 'modal-id';
        },
    },
});
vi.mock('@/modal', () => modalMock.module);

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: vi.fn(async () => ({
        features: {
            auth: {
                recovery: {
                    providerReset: { enabled: true },
                },
            },
        },
        capabilities: {
            auth: {
                recovery: {
                    providerReset: {
                        providers: ['github'],
                    },
                },
            },
        },
    })),
}));

vi.mock('@/auth/providers/registry', () => ({
    getAuthProvider: () => ({
        displayName: 'GitHub',
        getExternalAuthUrl: getExternalAuthUrlSpy,
    }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        setPendingExternalAuth: setPendingExternalAuthSpy,
        clearPendingExternalAuth: vi.fn(async () => true),
    },
}));

vi.mock(
    '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth',
    () => ({
        guardAccountEncryptionFirstKeyCredentialMutation:
            guardCredentialMutationSpy,
        abandonAccountEncryptionFirstKeyExternalAuth:
            vi.fn(async () => ({ kind: 'abandoned' })),
    }),
);

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverUrl: 'https://relay.example.test',
    }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) =>
        React.createElement('RoundButton', props),
}));

afterEach(() => {
    standardCleanup();
    vi.clearAllMocks();
});

describe('LostAccessView custody', () => {
    it('does not treat the generic lost-access warning as authority to replace marked custody', async () => {
        const { LostAccessView } = await import('./LostAccessView');
        const screen = await renderScreen(
            <LostAccessView
                onBack={() => {}}
                returnTo="/restore"
            />,
        );
        await act(async () => {});

        const provider = screen.findByTestId(
            'lost-access-provider-github',
        );
        if (!provider) {
            throw new Error('Expected lost-access provider action');
        }
        await act(async () => {
            await provider.props.action();
        });

        expect(modalMock.spies.confirm).toHaveBeenCalledTimes(1);
        expect(modalMock.spies.show).toHaveBeenCalledTimes(1);
        expect(setPendingExternalAuthSpy).not.toHaveBeenCalled();
        expect(getExternalAuthUrlSpy).not.toHaveBeenCalled();
    });
});
