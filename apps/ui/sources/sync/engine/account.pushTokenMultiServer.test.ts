import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-notifications', () => ({
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
}));

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
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: 'granted' } as any);
        vi.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({ status: 'granted' } as any);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ data: 'ExponentPushToken[secret-token]' } as any);

        const fetchSpy = vi.fn(async (_input: RequestInfo | URL) => ({
            ok: true,
            json: async () => ({ success: true }),
        }));
        vi.stubGlobal('fetch', fetchSpy as any);

        const { upsertServerProfile, setActiveServerId } = await import('@/sync/serverProfiles');
        const company = upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });

        const { TokenStorage } = await import('@/auth/tokenStorage');

        setActiveServerId('official', { scope: 'device' });
        await TokenStorage.setCredentials({ token: 't_official', secret: 's' });

        setActiveServerId(company.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: 't_company', secret: 's' });

        setActiveServerId('official', { scope: 'device' });

        const messages: string[] = [];
        const log = { log: (message: string) => messages.push(message) };

        const { registerPushTokenIfAvailable } = await import('./account');
        await registerPushTokenIfAvailable({
            credentials: { token: 't_official', secret: 's' } as any,
            log,
        });

        const urls = fetchSpy.mock.calls.map((call) => String(call[0]));
        expect(urls).toContain('https://api.happier.dev/v1/push-tokens');
        expect(urls).toContain('https://company.example.test/v1/push-tokens');
        expect(messages.join('\n')).not.toContain('ExponentPushToken[secret-token]');
    });
});
