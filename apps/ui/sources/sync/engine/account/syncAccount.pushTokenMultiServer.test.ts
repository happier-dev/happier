import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionStatus } from 'expo-modules-core';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';

const SECURE_STORE_DEV_FALLBACK_ENV = 'EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK';
let originalSecureStoreDevFallback: string | undefined;
const runtimeFetchWithServerReachabilityMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: runtimeFetchWithServerReachabilityMock,
}));

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

const Notifications = await import('expo-notifications');
const serverProfiles = await import('@/sync/domains/server/serverProfiles');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { registerPushTokenIfAvailable } = await import('./syncAccount');

beforeEach(() => {
    originalSecureStoreDevFallback = process.env[SECURE_STORE_DEV_FALLBACK_ENV];
    process.env[SECURE_STORE_DEV_FALLBACK_ENV] = '0';
    runtimeFetchWithServerReachabilityMock.mockReset();
    runtimeFetchWithServerReachabilityMock.mockResolvedValue(Response.json({ success: true }));
});

afterEach(() => {
    if (originalSecureStoreDevFallback === undefined) {
        delete process.env[SECURE_STORE_DEV_FALLBACK_ENV];
    } else {
        process.env[SECURE_STORE_DEV_FALLBACK_ENV] = originalSecureStoreDevFallback;
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('registerPushTokenIfAvailable (multi-server)', () => {
    it('registers for all saved servers with credentials', async () => {
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

        const { upsertServerProfile, setActiveServerId } = serverProfiles;
        const defaultServer = upsertServerProfile({ serverUrl: 'https://remote-a.example.test', name: 'Primary' });
        const company = upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });

        setActiveServerId(defaultServer.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: 't_primary', secret: 's' });

        setActiveServerId(company.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: 't_company', secret: 's' });

        setActiveServerId(defaultServer.id, { scope: 'device' });

        const messages: string[] = [];
        const log = { log: (message: string) => messages.push(message) };

        await registerPushTokenIfAvailable({
            credentials: { token: 't_primary', secret: 's' } satisfies AuthCredentials,
            log,
        });

        const urls = runtimeFetchWithServerReachabilityMock.mock.calls.map(([request]) => String(request.url));
        expect(urls).toContain('https://remote-a.example.test/v1/push-tokens');
        expect(urls).toContain('https://company.example.test/v1/push-tokens');
        expect(messages.join('\n')).not.toContain('ExponentPushToken[secret-token]');

        const bodiesByUrl = new Map<string, any>();
        for (const [request] of runtimeFetchWithServerReachabilityMock.mock.calls) {
            const url = String(request.url);
            const init = (request.init ?? {}) as any;
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

    it('does not reuse another same-origin profile credentials when only one alternate profile is authenticated', async () => {
        vi.resetModules();
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

        const state = {
            activeServerId: 'server-a',
            profiles: [
                { id: 'server-a', serverUrl: 'https://shared.example.test', name: 'Primary', createdAt: 0, updatedAt: 0, lastUsedAt: 0 },
                { id: 'server-b', serverUrl: 'https://shared.example.test', name: 'Alternate', createdAt: 0, updatedAt: 0, lastUsedAt: 0 },
            ],
        };

        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                listServerProfiles: () => state.profiles,
                getActiveServerSnapshot: () => ({
                    serverId: state.activeServerId,
                    serverUrl: 'https://shared.example.test',
                    generation: 1,
                }),
            };
        });

        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (_serverUrl, options) => {
            if (options?.serverId === 'server-a') {
                return { token: 't_primary', secret: 's' };
            }
            if (!options?.serverId) {
                return { token: 't_primary', secret: 's' };
            }
            return null;
        });

        const messages: string[] = [];
        const log = { log: (message: string) => messages.push(message) };

        const { registerPushTokenIfAvailable } = await import('./syncAccount');
        await registerPushTokenIfAvailable({
            credentials: { token: 't_primary', secret: 's' } satisfies AuthCredentials,
            log,
        });

        const registerCalls = runtimeFetchWithServerReachabilityMock.mock.calls.filter(([request]) => request.init?.method === 'POST');
        expect(registerCalls).toHaveLength(1);
        const [request] = registerCalls[0]!;
        expect(String(request.url)).toBe('https://shared.example.test/v1/push-tokens');
        expect(request.init?.headers).toMatchObject({
            Authorization: 'Bearer t_primary',
        });
        expect(messages.join('\n')).not.toContain('ExponentPushToken[secret-token]');

        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });
});
