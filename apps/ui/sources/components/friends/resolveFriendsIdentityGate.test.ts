import { describe, expect, it } from 'vitest';

import { resolveFriendsIdentityGate } from './resolveFriendsIdentityGate';

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
