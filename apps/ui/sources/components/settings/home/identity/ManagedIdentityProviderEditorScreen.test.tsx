import * as React from 'react';
import { AppState } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManagedIdentityProviderV1 } from '@happier-dev/protocol';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const executeMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/components/ui/forms/FieldItem', () => ({ FieldItem: 'FieldItem' }));
// Rows render their right-hand control, as the real row does; page fields are text inputs.
vi.mock('@/components/ui/lists/Item', async () => {
    const React = await import('react');
    return { Item: (props: { rightElement?: unknown }) => React.createElement('Item', props, props.rightElement as never) };
});
vi.mock('@/components/ui/forms/FieldTextInput', () => ({ FieldTextInput: 'TextInput' }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text', TextInput: 'TextInput' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./managedIdentityProviderClient', () => ({
    createManagedIdentityProviderClient: () => ({ execute: executeMock }),
}));

import {
    EMPTY_MANAGED_OIDC_PROVIDER_DRAFT,
    ManagedOidcProviderEditorContent,
    validateManagedIdentityProviderDraft,
} from './ManagedIdentityProviderEditorScreen';

function provider(revision: number): ManagedIdentityProviderV1 {
    return {
        v: 1,
        owner: { kind: 'home' },
        id: 'provider-1',
        kind: 'oidc',
        displayName: 'Corporate OIDC',
        enabled: false,
        firstEnabledAt: null,
        securityRevision: 3,
        revision,
        config: {
            v: 1,
            kind: 'oidc',
            issuer: 'https://id.example',
            clientId: 'client-1',
            clientAuthenticationMethod: 'client_secret_post',
            scopes: 'openid profile email',
            httpTimeoutSeconds: 15,
            claims: { login: 'preferred_username', email: 'email', groups: 'groups' },
            allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
            fetchUserInfo: true,
            storeRefreshToken: false,
            ui: { buttonColor: null, iconHint: null },
        },
        secret: { configured: true, health: 'configured' },
        teamConsumers: [],
        lastSuccessfulTest: null,
        createdByAccountId: 'account-1',
        createdAt: 1,
        updatedAt: 1,
    };
}

beforeEach(() => {
    standardCleanup();
    executeMock.mockReset();
});

describe('ManagedOidcProviderEditorContent', () => {
    it('identifies the first invalid field so the shared Home and Team editor can focus it', () => {
        expect(validateManagedIdentityProviderDraft({
            ...EMPTY_DRAFT,
            issuer: 'http://id.example',
        }, true)).toEqual({ code: 'required', field: 'displayName' });
        expect(validateManagedIdentityProviderDraft({
            ...EMPTY_DRAFT,
            displayName: 'Corporate OIDC',
            issuer: 'http://id.example',
            clientId: 'client-1',
            clientSecret: 'secret-1',
        }, true)).toEqual({ code: 'issuer', field: 'issuer' });
    });

    it('clears an unsaved client secret when the app leaves the active state', async () => {
        let onAppStateChange: ((state: string) => void) | null = null;
        vi.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
            onAppStateChange = listener as (state: string) => void;
            return { remove: vi.fn() };
        });
        const screen = await renderScreen(
            <ManagedOidcProviderEditorContent
                scope={{ serverId: 'home-1', accountId: 'account-1' }}
                owner={{ kind: 'home' }}
                provider={provider(4)}
                mutationsAvailable
                onSaved={() => ({ kind: 'completed' })}
            />,
        );
        await act(async () => {
            screen.changeTextByTestId('identity-provider-client-secret', 'replacement-secret');
        });

        await act(async () => onAppStateChange?.('inactive'));

        expect(screen.findByTestId('identity-provider-client-secret')?.props.value).toBe('');
    });

    it('does not let a read-only administrator create an unsavable provider draft', async () => {
        const screen = await renderScreen(
            <ManagedOidcProviderEditorContent
                scope={{ serverId: 'home-1', accountId: 'account-1' }}
                owner={{ kind: 'home' }}
                provider={provider(4)}
                mutationsAvailable={false}
                onSaved={() => ({ kind: 'completed' })}
            />,
        );

        expect(screen.findByTestId('identity-provider-name')?.props.editable).toBe(false);
        await screen.pressByTestIdAsync('identity-provider-advanced-toggle');
        expect(screen.findByTestId('identity-provider-scopes')?.props.editable).toBe(false);
    });

    it('presents provider validation as validation rather than a sign-in test', async () => {
        executeMock.mockResolvedValueOnce({ kind: 'succeeded', value: provider(5) });
        const screen = await renderScreen(
            <ManagedOidcProviderEditorContent
                scope={{ serverId: 'home-1', accountId: 'account-1' }}
                owner={{ kind: 'home' }}
                provider={provider(4)}
                mutationsAvailable
                onSaved={() => ({ kind: 'completed' })}
            />,
        );

        expect(screen.findByTestId('identity-provider-test')?.props.title).toBe('identityAdministration.validate');
        await screen.pressByTestIdAsync('identity-provider-test');
        expect(executeMock).toHaveBeenCalledWith('identity.providers.validate', expect.anything(), expect.anything());
        expect(screen.findByTestId('identity-provider-test')?.props.detail).toBe('identityAdministration.validated');
    });

    it('starts only one validation when pressed twice before React renders busy state', async () => {
        let releaseValidation = (_value: unknown): void => {};
        executeMock.mockImplementationOnce(() => new Promise((resolve) => { releaseValidation = resolve; }));
        const screen = await renderScreen(
            <ManagedOidcProviderEditorContent
                scope={{ serverId: 'home-1', accountId: 'account-1' }}
                owner={{ kind: 'home' }}
                provider={provider(4)}
                mutationsAvailable
                onSaved={() => ({ kind: 'completed' })}
            />,
        );

        act(() => {
            screen.pressByTestId('identity-provider-test');
            screen.pressByTestId('identity-provider-test');
        });
        expect(executeMock).toHaveBeenCalledTimes(1);

        await act(async () => releaseValidation({ kind: 'succeeded', value: provider(5) }));
    });

    it('starts only one save when pressed twice before React renders busy state', async () => {
        let releaseSave = (_value: unknown): void => {};
        executeMock.mockImplementationOnce(() => new Promise((resolve) => { releaseSave = resolve; }));
        const screen = await renderScreen(
            <ManagedOidcProviderEditorContent
                scope={{ serverId: 'home-1', accountId: 'account-1' }}
                owner={{ kind: 'home' }}
                provider={provider(4)}
                mutationsAvailable
                onSaved={() => ({ kind: 'completed' })}
            />,
        );
        await act(async () => screen.changeTextByTestId('identity-provider-name', 'Edited OIDC'));

        act(() => {
            screen.pressByTestId('identity-provider-save');
            screen.pressByTestId('identity-provider-save');
        });
        expect(executeMock).toHaveBeenCalledTimes(1);

        await act(async () => releaseSave({ kind: 'succeeded', value: { ...provider(5), displayName: 'Edited OIDC' } }));
    });

    it('refreshes a server CAS conflict and waits for the newer revision before allowing retry', async () => {
        const onRefreshRequested = vi.fn();
        const onSaved = vi.fn(() => ({ kind: 'completed' as const }));
        const renderEditor = (current: ManagedIdentityProviderV1) => (
            <ManagedOidcProviderEditorContent
                scope={{ serverId: 'home-1', accountId: 'account-1' }}
                owner={{ kind: 'home' }}
                provider={current}
                mutationsAvailable
                onRefreshRequested={onRefreshRequested}
                onSaved={onSaved}
            />
        );
        executeMock.mockResolvedValueOnce({ kind: 'failed', failure: { code: 'identity_provider_revision_conflict', retryable: false } });
        const screen = await renderScreen(renderEditor(provider(4)));
        await act(async () => {
            screen.changeTextByTestId('identity-provider-name', 'Edited OIDC');
        });

        await screen.pressByTestIdAsync('identity-provider-save');

        expect(onRefreshRequested).toHaveBeenCalledOnce();
        expect(screen.findByTestId('identity-provider-name')?.props.value).toBe('Edited OIDC');
        expect(screen.findByTestId('identity-provider-save')?.props.disabled).toBe(true);
        expect(screen.findByTestId('identity-provider-reload-conflict')).toBeNull();
        await screen.pressByTestIdAsync('identity-provider-refresh-conflict');
        expect(onRefreshRequested).toHaveBeenCalledTimes(2);

        await screen.update(renderEditor(provider(5)));
        expect(screen.findByTestId('identity-provider-reload-conflict')).not.toBeNull();
        expect(screen.findByTestId('identity-provider-refresh-conflict')).toBeNull();

        await screen.pressByTestIdAsync('identity-provider-reload-conflict');
        expect(screen.findByTestId('identity-provider-name')?.props.value).toBe('Corporate OIDC');
        await act(async () => {
            screen.changeTextByTestId('identity-provider-name', 'Edited OIDC');
        });
        executeMock.mockResolvedValueOnce({ kind: 'succeeded', value: { ...provider(6), displayName: 'Edited OIDC' } });
        await screen.pressByTestIdAsync('identity-provider-save');

        expect(executeMock).toHaveBeenLastCalledWith('identity.providers.update', expect.objectContaining({
            expectedRevision: 5,
            displayName: 'Edited OIDC',
        }), expect.anything());
        expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 6 }), expect.objectContaining({ onApprovalFailed: expect.any(Function) }));
    });

    it('preserves an edited draft until an explicit reload, then requires reapplying it before CAS save', async () => {
        const onSaved = vi.fn(() => ({ kind: 'completed' as const }));
        const renderEditor = (current: ManagedIdentityProviderV1) => (
            <ManagedOidcProviderEditorContent
                scope={{ serverId: 'home-1', accountId: 'account-1' }}
                owner={{ kind: 'home' }}
                provider={current}
                mutationsAvailable
                onSaved={onSaved}
            />
        );
        const screen = await renderScreen(renderEditor(provider(4)));
        await act(async () => {
            screen.changeTextByTestId('identity-provider-name', 'Edited OIDC');
        });

        await screen.update(renderEditor(provider(5)));

        expect(screen.findByTestId('identity-provider-name')?.props.value).toBe('Edited OIDC');
        expect(screen.findByTestId('identity-provider-save')?.props.disabled).toBe(true);
        expect(screen.findByTestId('identity-provider-reload-conflict')).not.toBeNull();

        await screen.pressByTestIdAsync('identity-provider-reload-conflict');
        expect(screen.findByTestId('identity-provider-name')?.props.value).toBe('Corporate OIDC');
        expect(screen.findByTestId('identity-provider-save')?.props.disabled).toBe(true);
        await act(async () => {
            screen.changeTextByTestId('identity-provider-name', 'Edited OIDC');
        });
        executeMock.mockResolvedValue({ kind: 'succeeded', value: { ...provider(6), displayName: 'Edited OIDC' } });
        await screen.pressByTestIdAsync('identity-provider-save');

        expect(executeMock).toHaveBeenCalledWith('identity.providers.update', expect.objectContaining({
            owner: { kind: 'home' },
            id: 'provider-1',
            expectedRevision: 5,
            displayName: 'Edited OIDC',
        }), expect.anything());
        expect(executeMock).not.toHaveBeenCalledWith('identity.providers.secret.replace', expect.anything());
        expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 6 }), expect.objectContaining({ onApprovalFailed: expect.any(Function) }));
    });

    it('retries a failed secret step from the provider revision and config the update committed', async () => {
        const serverUpdated = {
            ...provider(5),
            config: {
                ...provider(5).config,
                allow: { usersAllowlist: [], emailDomains: [], groupsAny: ['server-rule'], groupsAll: [] },
            },
        };
        executeMock
            .mockResolvedValueOnce({ kind: 'succeeded', value: serverUpdated })
            .mockResolvedValueOnce({ kind: 'failed', failure: { code: 'home_unreachable', retryable: true } })
            .mockResolvedValueOnce({ kind: 'succeeded', value: { ...serverUpdated, revision: 6 } })
            .mockResolvedValueOnce({ kind: 'succeeded', value: { ...serverUpdated, revision: 7, securityRevision: 4 } });
        const onSaved = vi.fn(() => ({ kind: 'completed' as const }));
        const screen = await renderScreen(
            <ManagedOidcProviderEditorContent
                scope={{ serverId: 'home-1', accountId: 'account-1' }}
                owner={{ kind: 'home' }}
                provider={provider(4)}
                mutationsAvailable
                onSaved={onSaved}
            />,
        );
        await act(async () => {
            screen.changeTextByTestId('identity-provider-client-secret', 'replacement-secret');
        });

        await screen.pressByTestIdAsync('identity-provider-save');
        await screen.pressByTestIdAsync('identity-provider-save');

        expect(executeMock).toHaveBeenNthCalledWith(3, 'identity.providers.update', expect.objectContaining({
            expectedRevision: 5,
            config: expect.objectContaining({
                allow: expect.objectContaining({ groupsAny: ['server-rule'] }),
            }),
        }), expect.anything());
        expect(executeMock).toHaveBeenNthCalledWith(4, 'identity.providers.secret.replace', expect.objectContaining({
            expectedRevision: 6,
            clientSecret: 'replacement-secret',
        }), expect.anything());
        expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 7, securityRevision: 4 }), expect.objectContaining({ onApprovalFailed: expect.any(Function) }));
    });

    it('refreshes and blocks retry when the secret-repair CAS loses', async () => {
        const onRefreshRequested = vi.fn();
        let currentProvider = provider(4);
        const renderEditor = () => (
            <ManagedOidcProviderEditorContent
                scope={{ serverId: 'home-1', accountId: 'account-1' }}
                owner={{ kind: 'home' }}
                provider={currentProvider}
                mutationsAvailable
                onRefreshRequested={onRefreshRequested}
                onSaved={() => ({ kind: 'completed' })}
            />
        );
        executeMock
            .mockResolvedValueOnce({ kind: 'succeeded', value: provider(5) })
            .mockResolvedValueOnce({
                kind: 'failed',
                failure: { code: 'identity_provider_revision_conflict', retryable: false },
            });
        const screen = await renderScreen(renderEditor());
        await act(async () => {
            screen.changeTextByTestId('identity-provider-client-secret', 'replacement-secret');
        });

        await screen.pressByTestIdAsync('identity-provider-save');

        expect(onRefreshRequested).toHaveBeenCalledOnce();
        expect(screen.findByTestId('identity-provider-save')?.props.disabled).toBe(true);
        expect(screen.findByTestId('identity-provider-refresh-conflict')).not.toBeNull();

        currentProvider = { ...provider(6), displayName: 'Server-edited OIDC' };
        await screen.update(renderEditor());

        expect(screen.findByTestId('identity-provider-refresh-conflict')).toBeNull();
        expect(screen.findByTestId('identity-provider-reload-conflict')).not.toBeNull();
        await screen.pressByTestIdAsync('identity-provider-reload-conflict');
        expect(screen.findByTestId('identity-provider-name')?.props.value).toBe('Server-edited OIDC');
    });
});

const EMPTY_DRAFT = Object.freeze({
    ...EMPTY_MANAGED_OIDC_PROVIDER_DRAFT,
    displayName: '',
    issuer: '',
    clientId: '',
    clientSecret: '',
    scopes: 'openid profile email',
    loginClaim: 'preferred_username',
    emailClaim: 'email',
    groupsClaim: 'groups',
    fetchUserInfo: true,
});
