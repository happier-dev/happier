import { describe, expect, it } from 'vitest';

import { resolveFriendsIdentityConnectOption, resolveFriendsIdentityGate } from './resolveFriendsIdentityGate';

describe('resolveFriendsIdentityGate', () => {
    it('requires provider connect when username-only support is off and required provider is not connected', () => {
        expect(
            resolveFriendsIdentityGate({
                friendsAllowUsernameSupport: false,
                profileUsername: null,
                requiredProviderLogin: null,
                requiredProviderConnected: false,
            }),
        ).toEqual({
            isReady: false,
            gateVariant: 'provider',
        });
    });

    it('requires username when provider is connected but no username is reserved (provider-required mode)', () => {
        expect(
            resolveFriendsIdentityGate({
                friendsAllowUsernameSupport: false,
                profileUsername: null,
                requiredProviderLogin: 'Alice',
                requiredProviderConnected: true,
            }),
        ).toEqual({
            isReady: false,
            gateVariant: 'username',
            initialUsername: 'Alice',
            usernameHint: {
                key: 'friends.username.preferredNotAvailableWithLogin',
                params: { login: 'Alice' },
            },
        });
    });

    it('is ready when provider is connected and a username exists (provider-required mode)', () => {
        expect(
            resolveFriendsIdentityGate({
                friendsAllowUsernameSupport: false,
                profileUsername: 'alice_2',
                requiredProviderLogin: 'Alice',
                requiredProviderConnected: true,
            }),
        ).toEqual({
            isReady: true,
            gateVariant: 'username',
        });
    });

    it('requires username when username-only mode is enabled and username is missing (prefills from provider login when present)', () => {
        expect(
            resolveFriendsIdentityGate({
                friendsAllowUsernameSupport: true,
                profileUsername: null,
                requiredProviderLogin: 'Bob',
                requiredProviderConnected: true,
            }),
        ).toEqual({
            isReady: false,
            gateVariant: 'username',
            initialUsername: 'Bob',
        });
    });

    it('returns a generic preferred-username hint when provider login is missing (provider-required mode)', () => {
        expect(
            resolveFriendsIdentityGate({
                friendsAllowUsernameSupport: false,
                profileUsername: null,
                requiredProviderLogin: null,
                requiredProviderConnected: true,
            }),
        ).toEqual({
            isReady: false,
            gateVariant: 'username',
            usernameHint: {
                key: 'friends.username.preferredNotAvailable',
            },
        });
    });
});

describe('resolveFriendsIdentityConnectOption', () => {
    const github = { requiredProviderId: 'github', requiredProviderName: 'GitHub', providerConnected: false } as const;

    it('offers the provider by name when this Home configured it', () => {
        for (const gateVariant of ['provider', 'username'] as const) {
            expect(resolveFriendsIdentityConnectOption({ ...github, gateVariant, providerConfigured: true }))
                .toEqual({ kind: 'connect', providerId: 'github', providerName: 'GitHub' });
        }
    });

    it('hides the option on the username step when this Home did not configure the provider', () => {
        expect(resolveFriendsIdentityConnectOption({ ...github, gateVariant: 'username', providerConfigured: false }))
            .toEqual({ kind: 'none' });
    });

    it('says the provider is missing when Friends requires it and this Home did not configure it', () => {
        expect(resolveFriendsIdentityConnectOption({ ...github, gateVariant: 'provider', providerConfigured: false }))
            .toEqual({ kind: 'notConfigured', providerName: 'GitHub' });
    });

    it('offers nothing while the Home is still answering, without a provider, or once it is connected', () => {
        expect(resolveFriendsIdentityConnectOption({ ...github, gateVariant: 'provider', providerConfigured: null })).toEqual({ kind: 'none' });
        expect(resolveFriendsIdentityConnectOption({
            gateVariant: 'username', requiredProviderId: null, requiredProviderName: null, providerConnected: false, providerConfigured: true,
        })).toEqual({ kind: 'none' });
        expect(resolveFriendsIdentityConnectOption({ ...github, providerConnected: true, gateVariant: 'username', providerConfigured: true }))
            .toEqual({ kind: 'none' });
    });
});
