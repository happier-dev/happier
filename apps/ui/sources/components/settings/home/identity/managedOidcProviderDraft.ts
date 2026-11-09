import type { ManagedIdentityProviderV1, ManagedOidcProviderConfigV1 } from '@happier-dev/protocol/identity/providers';

export type ManagedOidcProviderDraft = Readonly<{
    displayName: string;
    issuer: string;
    clientId: string;
    clientSecret: string;
    clientAuthenticationMethod: ManagedOidcProviderConfigV1['clientAuthenticationMethod'];
    scopes: string;
    loginClaim: string;
    emailClaim: string;
    groupsClaim: string;
    fetchUserInfo: boolean;
    usersAllowlist: string;
    emailDomains: string;
    groupsAny: string;
    groupsAll: string;
    storeRefreshToken: boolean;
    buttonColor: string;
    iconHint: string;
}>;

export const EMPTY_MANAGED_OIDC_PROVIDER_DRAFT: ManagedOidcProviderDraft = Object.freeze({
    displayName: '', issuer: '', clientId: '', clientSecret: '',
    scopes: 'openid profile email', loginClaim: 'preferred_username', emailClaim: 'email', groupsClaim: 'groups',
    fetchUserInfo: true,
    clientAuthenticationMethod: 'client_secret_post',
    usersAllowlist: '', emailDomains: '', groupsAny: '', groupsAll: '',
    storeRefreshToken: false, buttonColor: '', iconHint: '',
});

export function managedOidcDraftFromProvider(provider: ManagedIdentityProviderV1): ManagedOidcProviderDraft {
    if (provider.kind !== 'oidc') throw new Error('identity_provider_not_oidc');
    return {
        displayName: provider.displayName,
        issuer: provider.config.issuer,
        clientId: provider.config.clientId,
        clientSecret: '',
        scopes: provider.config.scopes,
        loginClaim: provider.config.claims.login,
        emailClaim: provider.config.claims.email,
        groupsClaim: provider.config.claims.groups,
        fetchUserInfo: provider.config.fetchUserInfo,
        clientAuthenticationMethod: provider.config.clientAuthenticationMethod,
        usersAllowlist: provider.config.allow.usersAllowlist.join('\n'),
        emailDomains: provider.config.allow.emailDomains.join('\n'),
        groupsAny: provider.config.allow.groupsAny.join('\n'),
        groupsAll: provider.config.allow.groupsAll.join('\n'),
        storeRefreshToken: provider.config.storeRefreshToken,
        buttonColor: provider.config.ui.buttonColor ?? '',
        iconHint: provider.config.ui.iconHint ?? '',
    };
}

export function managedOidcConfigFromDraft(draft: ManagedOidcProviderDraft, current?: ManagedIdentityProviderV1): ManagedOidcProviderConfigV1 {
    if (current && current.kind !== 'oidc') throw new Error('identity_provider_not_oidc');
    return {
        v: 1, kind: 'oidc', issuer: draft.issuer.trim(), clientId: draft.clientId.trim(),
        clientAuthenticationMethod: draft.clientAuthenticationMethod,
        scopes: draft.scopes.trim(),
        httpTimeoutSeconds: current?.config.httpTimeoutSeconds ?? 15,
        claims: { login: draft.loginClaim.trim(), email: draft.emailClaim.trim(), groups: draft.groupsClaim.trim() },
        allow: {
            usersAllowlist: splitAllowEntries(draft.usersAllowlist),
            emailDomains: splitAllowEntries(draft.emailDomains),
            groupsAny: splitAllowEntries(draft.groupsAny),
            groupsAll: splitAllowEntries(draft.groupsAll),
        },
        fetchUserInfo: draft.fetchUserInfo,
        storeRefreshToken: draft.storeRefreshToken,
        ui: { buttonColor: draft.buttonColor.trim() || null, iconHint: draft.iconHint.trim() || null },
    };
}

export function validateManagedIdentityProviderDraft(
    draft: ManagedOidcProviderDraft,
    requiresSecret: boolean,
): Readonly<{ code: 'required' | 'issuer' | 'secret' | 'scopes'; field: keyof ManagedOidcProviderDraft }> | null {
    if (!draft.displayName.trim()) return { code: 'required', field: 'displayName' };
    try {
        const issuer = new URL(draft.issuer.trim());
        if (issuer.protocol !== 'https:') return { code: 'issuer', field: 'issuer' };
    } catch {
        return { code: 'issuer', field: 'issuer' };
    }
    if (!draft.clientId.trim()) return { code: 'required', field: 'clientId' };
    if (requiresSecret && !draft.clientSecret) return { code: 'secret', field: 'clientSecret' };
    if (!draft.scopes.trim()) return { code: 'required', field: 'scopes' };
    if (!draft.scopes.split(/\s+/u).some((scope) => scope.toLowerCase() === 'openid')) return { code: 'scopes', field: 'scopes' };
    if (!draft.loginClaim.trim()) return { code: 'required', field: 'loginClaim' };
    if (!draft.emailClaim.trim()) return { code: 'required', field: 'emailClaim' };
    if (!draft.groupsClaim.trim()) return { code: 'required', field: 'groupsClaim' };
    return null;
}

// This is field syntax only. Eligibility comparison/normalization stays with the provider owner.
function splitAllowEntries(value: string): string[] {
    return value.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
}
