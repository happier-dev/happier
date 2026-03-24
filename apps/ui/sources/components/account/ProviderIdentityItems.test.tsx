import React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { installAccountCommonModuleMocks } from './accountTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    canOpenURL: vi.fn(async () => true),
    openURL: vi.fn(async () => true),
    setPendingExternalConnect: vi.fn(async () => true),
    clearPendingExternalConnect: vi.fn(async () => true),
}));

installAccountCommonModuleMocks({
    icons: () => ({
        Ionicons: 'Ionicons',
    }),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Linking: {
                canOpenURL: shared.canOpenURL,
                openURL: shared.openURL,
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ confirmResult: true }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    },
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        setPendingExternalConnect: shared.setPendingExternalConnect,
        clearPendingExternalConnect: shared.clearPendingExternalConnect,
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

vi.mock('@/sync/domains/state/storageStore', () => {
    const storage = {
        getState: () => ({ profile: profileDefaults }),
    };
    return { storage, getStorage: () => storage };
});

vi.mock('@/auth/providers/registry', () => ({
    normalizeProviderId: (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null),
    authProviderRegistry: [{
        id: 'github',
        displayName: 'GitHub',
        badgeIconName: 'logo-github',
        supportsProfileBadge: true,
        getExternalAuthUrl: async () => '',
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
        itemProps = [];
        shared.setPendingExternalConnect.mockClear();
        shared.clearPendingExternalConnect.mockClear();
        shared.canOpenURL.mockClear();
        shared.openURL.mockClear();

        const { Modal } = await import('@/modal');
        const { ProviderIdentityItems } = await import('./ProviderIdentityItems');
        vi.mocked(Modal.alert).mockReset();
        vi.mocked(Modal.confirm).mockReset();
        vi.mocked(Modal.confirm).mockResolvedValue(true);

        await renderScreen(
            <ProviderIdentityItems
                profile={profileDefaults}
                credentials={{ token: 't', secret: 's' }}
                applyProfile={() => {}}
                returnTo="/settings/account"
            />,
        );

        const connectItem = itemProps.find((p) => p.title === 'GitHub');
        expect(connectItem).toBeTruthy();

        await act(async () => {
            await connectItem.onPress();
        });

        expect(shared.setPendingExternalConnect).toHaveBeenCalledWith({ provider: 'github', returnTo: '/settings/account' });
        expect(shared.clearPendingExternalConnect).toHaveBeenCalled();
        expect(shared.canOpenURL).not.toHaveBeenCalled();
        expect(shared.openURL).not.toHaveBeenCalled();
        expect(Modal.alert).toHaveBeenCalled();
    });
});
