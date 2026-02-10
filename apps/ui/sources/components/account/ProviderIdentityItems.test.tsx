import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { profileDefaults } from '@/sync/domains/profiles/profile';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

const canOpenURL = vi.fn(async () => true);
const openURL = vi.fn(async () => true);
vi.mock('react-native', () => ({
    Linking: { canOpenURL, openURL },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { textSecondary: '#888' } } }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

const setPendingExternalConnect = vi.fn(async () => true);
const clearPendingExternalConnect = vi.fn(async () => true);
vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        setPendingExternalConnect,
        clearPendingExternalConnect,
    },
    isLegacyAuthCredentials: (credentials: unknown) => Boolean(credentials),
}));

vi.mock('@/hooks/server/useOAuthProviderConfigured', () => ({
    useOAuthProviderConfigured: () => true,
}));

vi.mock('@/sync/sync', () => ({
    sync: { refreshProfile: async () => {} },
}));

vi.mock('@/sync/api/account/apiIdentity', () => ({
    setAccountIdentityShowOnProfile: async () => {},
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    storage: {
        getState: () => ({ profile: profileDefaults }),
    },
}));

const modalAlert = vi.fn(async () => {});
vi.mock('@/modal', () => ({
    Modal: {
        alert: modalAlert,
        confirm: vi.fn(async () => true),
    },
}));

vi.mock('@/auth/providers/registry', () => ({
    normalizeProviderId: (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null),
    authProviderRegistry: [{
        id: 'github',
        displayName: 'GitHub',
        badgeIconName: 'logo-github',
        supportsProfileBadge: true,
        getExternalSignupUrl: async () => '',
        getConnectUrl: async () => 'javascript:alert(1)',
        finalizeConnect: async () => {},
        cancelConnectPending: async () => {},
        disconnect: async () => {},
    }],
}));

let itemProps: any[] = [];
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => {
        itemProps.push(props);
        return null;
    },
}));

describe('ProviderIdentityItems', () => {
    it('clears pending connect state and blocks unsafe connect URLs', async () => {
        vi.resetModules();
        itemProps = [];
        modalAlert.mockClear();
        setPendingExternalConnect.mockClear();
        clearPendingExternalConnect.mockClear();
        canOpenURL.mockClear();
        openURL.mockClear();

        const { ProviderIdentityItems } = await import('./ProviderIdentityItems');

        await act(async () => {
            renderer.create(
                <ProviderIdentityItems
                    profile={profileDefaults}
                    credentials={{ token: 't', secret: 's' }}
                    applyProfile={() => {}}
                    returnTo="/settings/account"
                />,
            );
        });

        const connectItem = itemProps.find((p) => p.title === 'GitHub');
        expect(connectItem).toBeTruthy();

        await act(async () => {
            await connectItem.onPress();
        });

        expect(setPendingExternalConnect).toHaveBeenCalledWith({ provider: 'github', returnTo: '/settings/account' });
        expect(clearPendingExternalConnect).toHaveBeenCalled();
        expect(canOpenURL).not.toHaveBeenCalled();
        expect(openURL).not.toHaveBeenCalled();
        expect(modalAlert).toHaveBeenCalled();
    });
});
