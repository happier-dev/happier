import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';

const mocks = vi.hoisted(() => {
    return {
        registerPushToken: vi.fn(),
        deletePushToken: vi.fn(),
        getCredentialsForServerUrl: vi.fn(),
        listServerProfiles: vi.fn(),
        getActiveServerSnapshot: vi.fn(),
    };
});

vi.mock('expo-constants', () => ({
    default: { expoConfig: { extra: { eas: { projectId: 'test-project' } } } },
}));

vi.mock('expo-notifications', () => ({
    getPermissionsAsync: vi.fn(async () => ({ status: 'granted', granted: true, canAskAgain: false })),
    requestPermissionsAsync: vi.fn(async () => ({ status: 'granted', granted: true, canAskAgain: false })),
    getExpoPushTokenAsync: vi.fn(async () => ({ data: 'ExponentPushToken[new]' })),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                        Platform: { OS: 'ios' },
                    }
    );
});

vi.mock('@/sync/api/session/apiPush', () => ({
    registerPushToken: (...args: unknown[]) => mocks.registerPushToken(...args),
    deletePushToken: (...args: unknown[]) => mocks.deletePushToken(...args),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: () => mocks.listServerProfiles(),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => mocks.getActiveServerSnapshot(),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: (serverUrl: string) => mocks.getCredentialsForServerUrl(serverUrl),
    },
}));

describe('registerPushTokenIfAvailable rotation cleanup', () => {
    beforeEach(() => {
        mocks.registerPushToken.mockReset();
        mocks.deletePushToken.mockReset();
        mocks.getCredentialsForServerUrl.mockReset();
        mocks.listServerProfiles.mockReset();
        mocks.getActiveServerSnapshot.mockReset();
    });

    it('unregisters the previous token when Expo rotates tokens', async () => {
        const { saveLastRegisteredExpoPushToken, loadLastRegisteredExpoPushToken } = await import('@/sync/domains/state/pushTokenRegistration');
        saveLastRegisteredExpoPushToken('ExponentPushToken[old]');

        mocks.listServerProfiles.mockReturnValue([
            { id: 'server-1', serverUrl: 'https://api.happier.dev' },
            { id: 'server-2', serverUrl: 'https://company.example.test' },
        ]);
        mocks.getActiveServerSnapshot.mockReturnValue({ serverId: 'server-1', serverUrl: 'https://api.happier.dev', generation: 1 });
        mocks.getCredentialsForServerUrl.mockImplementation(async (url: string) => ({ token: `t:${url}`, secret: 's' }));
        mocks.registerPushToken.mockResolvedValue(undefined);
        mocks.deletePushToken.mockResolvedValue(undefined);

        const { registerPushTokenIfAvailable } = await import('./syncAccount');
        await registerPushTokenIfAvailable({
            credentials: { token: 't:active', secret: 's' } satisfies AuthCredentials,
            log: { log: () => {} },
        });

        expect(loadLastRegisteredExpoPushToken()).toBe('ExponentPushToken[new]');

        expect(mocks.deletePushToken).toHaveBeenCalledWith({ token: 't:https://api.happier.dev', secret: 's' }, 'ExponentPushToken[old]', { apiEndpoint: 'https://api.happier.dev' });
        expect(mocks.deletePushToken).toHaveBeenCalledWith({ token: 't:https://company.example.test', secret: 's' }, 'ExponentPushToken[old]', { apiEndpoint: 'https://company.example.test' });
    });
});
