import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ManagedOidcIdentityProviderV1 } from '@happier-dev/protocol/identity/providers';

import { renderScreen } from '@/dev/testkit';

// Expo Router is the navigation runtime boundary; all fields and editor logic stay real.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

import {
    EMPTY_MANAGED_OIDC_PROVIDER_DRAFT,
    ManagedOidcProviderEditorContent,
    managedOidcConfigFromDraft,
} from './ManagedIdentityProviderEditorScreen';

const completeDraft = {
    ...EMPTY_MANAGED_OIDC_PROVIDER_DRAFT,
    displayName: 'Company identity',
    issuer: 'https://identity.example',
    clientId: 'company-client',
    clientSecret: 'new-secret',
    clientAuthenticationMethod: 'client_secret_basic' as const,
    usersAllowlist: 'Alice\nBob\nCarol',
    emailDomains: 'example.com\nexample.org',
    groupsAny: 'Engineering\nSupport',
    groupsAll: 'Employees',
    storeRefreshToken: true,
    buttonColor: '#123456',
    iconHint: 'business',
};

describe('shared Home and Team OIDC configuration editor', () => {

    it('keeps the draft editable and shows retry when its retained provider could not refresh', async () => {
        const onRefreshRequested = vi.fn();
        const provider: ManagedOidcIdentityProviderV1 = {
            v: 1, owner: { kind: 'home' }, id: 'provider-1', kind: 'oidc',
            displayName: completeDraft.displayName, config: managedOidcConfigFromDraft(completeDraft),
            enabled: false, firstEnabledAt: null, securityRevision: 1, revision: 4,
            secret: { configured: true, health: 'configured' }, teamConsumers: [],
            lastSuccessfulTest: null, createdByAccountId: 'account-1', createdAt: 1, updatedAt: 1,
        };
        const renderEditor = (failed: boolean) => <ManagedOidcProviderEditorContent
            scope={{ serverId: 'home-1', accountId: 'account-1' }}
            owner={{ kind: 'home' }}
            provider={provider}
            mutationsAvailable
            refreshFailure={failed ? { code: 'home_unreachable', retryable: true } : null}
            onRefreshRequested={onRefreshRequested}
            onSaved={() => ({ kind: 'completed' })}
        />;
        const screen = await renderScreen(renderEditor(false));
        await act(async () => screen.changeTextByTestId('identity-provider-name', 'My unsaved changes'));
        await screen.update(renderEditor(true));
        expect(screen.findByTestId('identity-provider-name')?.props.value).toBe('My unsaved changes');
        expect(screen.findByTestId('identity-provider-name')?.props.editable).toBe(true);
        expect(screen.findByTestId('identity-provider-refresh-failed')).not.toBeNull();
        await screen.pressByTestIdAsync('identity-provider-refresh-retry');
        expect(onRefreshRequested).toHaveBeenCalledOnce();
    });

    it('clears obsolete field errors when the administrator discards a conflicting draft', async () => {
        const provider: ManagedOidcIdentityProviderV1 = {
            v: 1, owner: { kind: 'home' }, id: 'provider-1', kind: 'oidc',
            displayName: completeDraft.displayName, config: managedOidcConfigFromDraft(completeDraft),
            enabled: false, firstEnabledAt: null, securityRevision: 1, revision: 4,
            secret: { configured: true, health: 'configured' }, teamConsumers: [],
            lastSuccessfulTest: null, createdByAccountId: 'account-1', createdAt: 1, updatedAt: 1,
        };
        const editor = (revision: number) => <ManagedOidcProviderEditorContent
            scope={{ serverId: 'home-1', accountId: 'account-1' }} owner={{ kind: 'home' }}
            provider={{ ...provider, revision }} mutationsAvailable onSaved={() => ({ kind: 'completed' })}
        />;
        const screen = await renderScreen(editor(4));
        await screen.pressByTestIdAsync('identity-provider-advanced-toggle');
        await act(async () => screen.changeTextByTestId('identity-provider-scopes', 'profile'));
        await screen.pressByTestIdAsync('identity-provider-save');
        expect(screen.findByTestId('identity-provider-scopes.error')).not.toBeNull();
        await screen.update(editor(5));
        await screen.pressByTestIdAsync('identity-provider-reload-conflict');
        expect(screen.findByTestId('identity-provider-scopes')?.props.value).toBe('openid profile email');
        expect(screen.findByTestId('identity-provider-scopes.error')).toBeNull();
    });
});
