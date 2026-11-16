import * as React from 'react';
import { AppState } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText } from '@/dev/testkit/render/renderScreen';

import { ManagedIdentityProviderV1Schema, MANAGED_IDENTITY_PROVIDER_ACTION_PATHS_V1, type ManagedIdentityProviderV1 } from '@happier-dev/protocol/identity/providers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance, type HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const networkResponse = vi.fn<(path: string, input: unknown) => Promise<HomeDomainAnswer>>();

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const {
    EMPTY_MANAGED_OIDC_PROVIDER_DRAFT,
    ManagedOidcProviderEditorContent,
    validateManagedIdentityProviderDraft,
} = await import('./ManagedIdentityProviderEditorScreen');
let serverId: string;

function provider(revision: number): ManagedIdentityProviderV1 {
    return ManagedIdentityProviderV1Schema.parse({
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
    });
}

beforeEach(async () => {
    standardCleanup();
    await harness.reset();
    serverId = await harness.addHome({ name: 'Identity Home', serverUrl: 'https://identity-home.example', accountId: 'account-1' });
    networkResponse.mockReset();
    for (const path of Object.values(MANAGED_IDENTITY_PROVIDER_ACTION_PATHS_V1)) {
        harness.answer(serverId, path, { select: input => networkResponse(path, input) });
    }
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
                scope={{ serverId, accountId: 'account-1' }}
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
                scope={{ serverId, accountId: 'account-1' }}
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
        networkResponse.mockResolvedValueOnce({ body: provider(5) });
        const screen = await renderScreen(
            <ManagedOidcProviderEditorContent
                scope={{ serverId, accountId: 'account-1' }}
                owner={{ kind: 'home' }}
                provider={provider(4)}
                mutationsAvailable
                onSaved={() => ({ kind: 'completed' })}
            />,
        );

        expect(findTestInstanceByTypeContainingText(screen.findByTestId('identity-provider-test')!, 'Text', 'identityAdministration.validate')).toBeDefined();
        await screen.pressByTestIdAsync('identity-provider-test');
        expect(networkResponse).toHaveBeenCalledWith('/v1/identity/providers/validate', expect.anything());
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('identity-provider-test')!, 'Text', 'identityAdministration.validated')).toBeDefined();
    });

    it('starts only one validation when pressed twice before React renders busy state', async () => {
        let releaseValidation = (_value: HomeDomainAnswer): void => {};
        networkResponse.mockImplementationOnce(() => new Promise((resolve) => { releaseValidation = resolve; }));
        const screen = await renderScreen(
            <ManagedOidcProviderEditorContent
                scope={{ serverId, accountId: 'account-1' }}
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
        await waitForHomeGovernance(() => expect(networkResponse).toHaveBeenCalledTimes(1));

        await act(async () => releaseValidation({ body: provider(5) }));
    });

    it('starts only one save when pressed twice before React renders busy state', async () => {
        let releaseSave = (_value: HomeDomainAnswer): void => {};
        networkResponse.mockImplementationOnce(() => new Promise((resolve) => { releaseSave = resolve; }));
        const screen = await renderScreen(
            <ManagedOidcProviderEditorContent
                scope={{ serverId, accountId: 'account-1' }}
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
        await waitForHomeGovernance(() => expect(networkResponse).toHaveBeenCalledTimes(1));

        await act(async () => releaseSave({ body: { ...provider(5), displayName: 'Edited OIDC' } }));
    });

    it('refreshes a server CAS conflict and waits for the newer revision before allowing retry', async () => {
        const onRefreshRequested = vi.fn();
        const onSaved = vi.fn(() => ({ kind: 'completed' as const }));
        const renderEditor = (current: ManagedIdentityProviderV1) => (
            <ManagedOidcProviderEditorContent
                scope={{ serverId, accountId: 'account-1' }}
                owner={{ kind: 'home' }}
                provider={current}
                mutationsAvailable
                onRefreshRequested={onRefreshRequested}
                onSaved={onSaved}
            />
        );
        networkResponse.mockResolvedValueOnce({ status: 409, body: { error: 'identity_provider_revision_conflict' } });
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
        networkResponse.mockResolvedValueOnce({ body: { ...provider(6), displayName: 'Edited OIDC' } });
        await screen.pressByTestIdAsync('identity-provider-save');

        expect(networkResponse).toHaveBeenLastCalledWith('/v1/identity/providers/update', expect.objectContaining({
            expectedRevision: 5,
            displayName: 'Edited OIDC',
        }));
        expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 6 }), expect.objectContaining({ onApprovalFailed: expect.any(Function) }));
    });

    it('preserves an edited draft until an explicit reload, then requires reapplying it before CAS save', async () => {
        const onSaved = vi.fn(() => ({ kind: 'completed' as const }));
        const renderEditor = (current: ManagedIdentityProviderV1) => (
            <ManagedOidcProviderEditorContent
                scope={{ serverId, accountId: 'account-1' }}
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
        networkResponse.mockResolvedValue({ body: { ...provider(6), displayName: 'Edited OIDC' } });
        await screen.pressByTestIdAsync('identity-provider-save');

        expect(networkResponse).toHaveBeenCalledWith('/v1/identity/providers/update', expect.objectContaining({
            owner: { kind: 'home' },
            id: 'provider-1',
            expectedRevision: 5,
            displayName: 'Edited OIDC',
        }));
        expect(networkResponse).not.toHaveBeenCalledWith('/v1/identity/providers/secret/replace', expect.anything());
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
        networkResponse
            .mockResolvedValueOnce({ body: serverUpdated })
            .mockResolvedValueOnce({ dispatchThenFail: true })
            .mockResolvedValueOnce({ body: { ...serverUpdated, revision: 6 } })
            .mockResolvedValueOnce({ body: { ...serverUpdated, revision: 7, securityRevision: 4 } });
        const onSaved = vi.fn(() => ({ kind: 'completed' as const }));
        const screen = await renderScreen(
            <ManagedOidcProviderEditorContent
                scope={{ serverId, accountId: 'account-1' }}
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

        expect(networkResponse).toHaveBeenNthCalledWith(3, '/v1/identity/providers/update', expect.objectContaining({
            expectedRevision: 5,
            config: expect.objectContaining({
                allow: expect.objectContaining({ groupsAny: ['server-rule'] }),
            }),
        }));
        expect(networkResponse).toHaveBeenNthCalledWith(4, '/v1/identity/providers/secret/replace', expect.objectContaining({
            expectedRevision: 6,
            clientSecret: 'replacement-secret',
        }));
        expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 7, securityRevision: 4 }), expect.objectContaining({ onApprovalFailed: expect.any(Function) }));
    });

    it('refreshes and blocks retry when the secret-repair CAS loses', async () => {
        const onRefreshRequested = vi.fn();
        let currentProvider = provider(4);
        const renderEditor = () => (
            <ManagedOidcProviderEditorContent
                scope={{ serverId, accountId: 'account-1' }}
                owner={{ kind: 'home' }}
                provider={currentProvider}
                mutationsAvailable
                onRefreshRequested={onRefreshRequested}
                onSaved={() => ({ kind: 'completed' })}
            />
        );
        networkResponse
            .mockResolvedValueOnce({ body: provider(5) })
            .mockResolvedValueOnce({
                status: 409,
                body: { error: 'identity_provider_revision_conflict' },
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
