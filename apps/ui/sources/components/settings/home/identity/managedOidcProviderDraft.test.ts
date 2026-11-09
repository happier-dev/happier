import { describe, expect, it } from 'vitest';
import type { ManagedOidcIdentityProviderV1 } from '@happier-dev/protocol/identity/providers';
import {
    EMPTY_MANAGED_OIDC_PROVIDER_DRAFT,
    managedOidcConfigFromDraft,
    managedOidcDraftFromProvider,
    validateManagedIdentityProviderDraft,
} from './managedOidcProviderDraft';

const draft = {
    ...EMPTY_MANAGED_OIDC_PROVIDER_DRAFT,
    displayName: 'Company identity', issuer: 'https://identity.example', clientId: 'client', clientSecret: 'secret',
    clientAuthenticationMethod: 'client_secret_basic' as const,
    usersAllowlist: 'Alice\nBob\nCarol', emailDomains: 'example.com\nexample.org',
    groupsAny: 'Engineering\nSupport', groupsAll: 'Employees', storeRefreshToken: true,
    buttonColor: '#123456', iconHint: 'business',
};

describe('managed OIDC draft', () => {
    it('authors and round-trips all supported configuration without retaining a client secret', () => {
        const config = managedOidcConfigFromDraft(draft);
        expect(config).toMatchObject({
            clientAuthenticationMethod: 'client_secret_basic',
            allow: { usersAllowlist: ['Alice', 'Bob', 'Carol'], emailDomains: ['example.com', 'example.org'], groupsAny: ['Engineering', 'Support'], groupsAll: ['Employees'] },
            storeRefreshToken: true, ui: { buttonColor: '#123456', iconHint: 'business' },
        });
        const provider: ManagedOidcIdentityProviderV1 = {
            v: 1, owner: { kind: 'team', teamId: 'team-1' }, id: 'provider-1', kind: 'oidc', displayName: draft.displayName,
            config: { ...config, httpTimeoutSeconds: 37 }, enabled: false, firstEnabledAt: null, securityRevision: 1, revision: 4,
            secret: { configured: true, health: 'configured' }, teamConsumers: [], lastSuccessfulTest: null,
            createdByAccountId: 'account-1', createdAt: 1, updatedAt: 1,
        };
        const restored = managedOidcDraftFromProvider(provider);
        expect(restored.clientSecret).toBe('');
        expect(managedOidcConfigFromDraft(restored, provider)).toEqual(provider.config);
        expect(managedOidcConfigFromDraft({ ...restored, buttonColor: ' ', iconHint: '' }).ui).toEqual({ buttonColor: null, iconHint: null });
    });

    it('identifies the scope field when openid is missing before submission', () => {
        expect(validateManagedIdentityProviderDraft({ ...draft, scopes: 'profile email' }, true)).toEqual({ code: 'scopes', field: 'scopes' });
        expect(validateManagedIdentityProviderDraft(draft, true)).toBeNull();
    });

    it('does not split a configured group name containing a comma', () => {
        expect(managedOidcConfigFromDraft({ ...draft, groupsAny: 'Sales, Europe\nSupport' }).allow.groupsAny)
            .toEqual(['Sales, Europe', 'Support']);
    });
});
