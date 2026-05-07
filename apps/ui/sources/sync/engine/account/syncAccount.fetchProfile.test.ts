import { afterEach, describe, expect, it, vi } from 'vitest';
const serverFetchMock = vi.hoisted(() => vi.fn());

vi.mock('expo-constants', () => ({
    default: {},
}));

vi.mock('expo-notifications', () => ({
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: (...args: unknown[]) => serverFetchMock(...args),
}));

vi.mock('@/sync/encryption/secretSettings', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/encryption/secretSettings')>();
    return {
        ...actual,
        deriveSettingsSecretsKey: async () => new Uint8Array(32).fill(9),
        sealSecretsDeep: (value: unknown) => value,
    };
});

describe('fetchAndApplyProfile', () => {
    afterEach(() => {
        serverFetchMock.mockReset();
        vi.resetModules();
    });

    it('drops fetched profile when the captured sync scope is stale before apply', async () => {
        const { fetchAndApplyProfile } = await import('./syncAccount');
        serverFetchMock.mockResolvedValue(new Response(JSON.stringify({
            id: 'account-a',
            email: 'a@example.test',
            name: 'Account A',
            avatarUrl: null,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        const applyProfile = vi.fn();
        await fetchAndApplyProfile({
            credentials: { token: 'token-a', secret: 'secret-a' },
            applyProfile,
            shouldContinue: () => false,
        } as Parameters<typeof fetchAndApplyProfile>[0] & { shouldContinue: () => boolean });

        expect(applyProfile).not.toHaveBeenCalled();
    });
});
