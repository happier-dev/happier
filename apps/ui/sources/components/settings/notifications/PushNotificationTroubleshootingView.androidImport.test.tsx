import { describe, expect, it, vi } from 'vitest';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

vi.mock('expo-notifications', () => {
    throw new Error('expo-notifications must not be imported while loading the push troubleshooting route');
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: null }),
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({ serverUrl: 'https://api.happier.dev' }),
}));

vi.mock('@/sync/api/session/apiPush', () => ({
    fetchPushTokens: vi.fn(async () => []),
    deletePushToken: vi.fn(async () => {}),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: () => null,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: () => null,
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: () => null,
}));

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'android' },
            Linking: { openSettings: vi.fn(async () => {}) },
        });
    },
});

describe('PushNotificationTroubleshootingView Android route import', () => {
    it('does not load expo-notifications while importing the push troubleshooting route', async () => {
        await expect(import('@/app/(app)/settings/notifications/push')).resolves.toHaveProperty('default');
    });
});
