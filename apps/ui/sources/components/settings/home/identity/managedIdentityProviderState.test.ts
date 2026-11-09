import { describe, expect, it } from 'vitest';
import type { ManagedIdentityProviderV1 } from '@happier-dev/protocol/identity/providers';

import {
    beginManagedIdentityProviderRefresh,
    INITIAL_MANAGED_IDENTITY_PROVIDER_STATE,
    settleManagedIdentityProviderRefresh,
} from './managedIdentityProviderState';

function provider(id: string): ManagedIdentityProviderV1 {
    return {
        v: 1,
        owner: { kind: 'home' },
        id,
        kind: 'oidc',
        displayName: id,
        enabled: true,
        firstEnabledAt: 1,
        securityRevision: 1,
        revision: 1,
        config: {
            v: 1,
            kind: 'oidc',
            issuer: 'https://id.example',
            clientId: 'client',
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
        lastSuccessfulTest: { at: 1, testedSecurityRevision: 1, current: true },
        createdByAccountId: 'account-1',
        createdAt: 1,
        updatedAt: 1,
    };
}

describe('managedIdentityProviderState', () => {
    it('sorts stable rows and retains them after a refresh failure', () => {
        const loaded = settleManagedIdentityProviderRefresh(INITIAL_MANAGED_IDENTITY_PROVIDER_STATE, {
            kind: 'succeeded',
            value: {
                items: [provider('Zulu'), provider('Alpha')],
                unreadableCount: 0,
            },
        });
        const failed = settleManagedIdentityProviderRefresh(beginManagedIdentityProviderRefresh(loaded), {
            kind: 'failed',
            failure: { code: 'home_unreachable', retryable: true },
        });

        expect(failed.kind).toBe('ready');
        expect(failed.kind === 'ready' && failed.items.map((item) => item.id)).toEqual(['Alpha', 'Zulu']);
        expect(failed.kind === 'ready' && failed.stale).toBe(true);
    });

    it('surfaces a settled read failure without treating it as provider data', () => {
        const state = settleManagedIdentityProviderRefresh(INITIAL_MANAGED_IDENTITY_PROVIDER_STATE, {
            kind: 'failed',
            failure: { code: 'approval_rejected', retryable: true },
        });

        expect(state).toEqual({
            kind: 'unavailable',
            failure: { code: 'approval_rejected', retryable: true },
        });
    });
});
