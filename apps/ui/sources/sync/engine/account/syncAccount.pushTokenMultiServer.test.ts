import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionStatus } from 'expo-modules-core';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';

vi.mock('expo-notifications', () => ({
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                Platform: {
                    OS: 'ios',
                },
            }
    );
});

vi.mock('expo-constants', () => ({
    default: { expoConfig: { extra: { eas: { projectId: 'test-project' } } } },
}));

vi.mock('expo-secure-store', () => {
    const store = new Map<string, string>();
    return {
        getItemAsync: async (key: string) => store.get(key) ?? null,
        setItemAsync: async (key: string, value: string) => {
            store.set(key, value);
        },
        deleteItemAsync: async (key: string) => {
            store.delete(key);
        },
    };
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('registerPushTokenIfAvailable (multi-server)', () => {
    it('registers for all saved servers with credentials', async () => {
        const Notifications = await import('expo-notifications');
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
            status: PermissionStatus.GRANTED,
            expires: 'never',
            granted: true,
            canAskAgain: false,
        } satisfies Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>);
        vi.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({
            status: PermissionStatus.GRANTED,
            expires: 'never',
            granted: true,
            canAskAgain: false,
        } satisfies Awaited<ReturnType<typeof Notifications.requestPermissionsAsync>>);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({
            type: 'expo',
            data: 'ExponentPushToken[secret-token]',
        } satisfies Awaited<ReturnType<typeof Notifications.getExpoPushTokenAsync>>);

        const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
            ok: true,
            json: async () => ({ success: true }),
        }));
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const defaultServer = upsertServerProfile({ serverUrl: 'https://remote-a.example.test', name: 'Primary' });
        const company = upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });

        const { TokenStorage } = await import('@/auth/storage/tokenStorage');

        setActiveServerId(defaultServer.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: 't_primary', secret: 's' });

        setActiveServerId(company.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: 't_company', secret: 's' });

        setActiveServerId(defaultServer.id, { scope: 'device' });

        const messages: string[] = [];
        const log = { log: (message: string) => messages.push(message) };

        const { registerPushTokenIfAvailable } = await import('./syncAccount');
        await registerPushTokenIfAvailable({
            credentials: { token: 't_primary', secret: 's' } satisfies AuthCredentials,
            log,
        });

        const urls = fetchSpy.mock.calls.map((call) => String(call[0]));
        expect(urls).toContain('https://remote-a.example.test/v1/push-tokens');
        expect(urls).toContain('https://company.example.test/v1/push-tokens');
        expect(messages.join('\n')).not.toContain('ExponentPushToken[secret-token]');

        const bodiesByUrl = new Map<string, any>();
        for (const call of fetchSpy.mock.calls) {
            const url = String(call[0]);
            const init = (call[1] ?? {}) as any;
            const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
            bodiesByUrl.set(url, body);
        }
        expect(bodiesByUrl.get('https://remote-a.example.test/v1/push-tokens')).toMatchObject({
            token: 'ExponentPushToken[secret-token]',
            clientServerUrl: 'https://remote-a.example.test',
        });
        expect(bodiesByUrl.get('https://company.example.test/v1/push-tokens')).toMatchObject({
            token: 'ExponentPushToken[secret-token]',
            clientServerUrl: 'https://company.example.test',
        });
    });
});
