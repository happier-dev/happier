import { afterEach, describe, expect, it, vi } from 'vitest';

import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
});

function randomScope(): string {
    return `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

describe('removeServerProfileUiAction', () => {
    it('clears server-scoped credentials before removing the profile', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const localStorageHandle = installLocalStorageMock();

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const profile = profiles.upsertServerProfile({
            serverUrl: 'https://server-a.example.test',
            name: 'Server A',
        });
        profiles.setActiveServerId(profile.id, { scope: 'device' });

        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await expect(TokenStorage.setCredentials({ token: 'token-a', secret: 'secret-a' })).resolves.toBe(true);
        await expect(TokenStorage.getCredentialsForServerUrl(profile.serverUrl)).resolves.toEqual({
            token: 'token-a',
            secret: 'secret-a',
        });

        const { removeServerProfileUiAction } = await import('./removeServerProfileUiAction');
        await removeServerProfileUiAction({ profileId: profile.id, serverUrl: profile.serverUrl });

        const readded = profiles.upsertServerProfile({ serverUrl: profile.serverUrl, name: 'Server A (again)' });
        expect(readded.id).toBe(profile.id);
        await expect(TokenStorage.getCredentialsForServerUrl(profile.serverUrl)).resolves.toBeNull();

        localStorageHandle.restore();
    });

    it('blocks marked nonactive server removal before credentials or the profile are mutated', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const localStorageHandle = installLocalStorageMock();

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const targetProfile = profiles.upsertServerProfile({
            serverUrl: 'https://marked.example.test',
            name: 'Marked',
        });
        const activeProfile = profiles.upsertServerProfile({
            serverUrl: 'https://active.example.test',
            name: 'Active',
        });
        profiles.setActiveServerId(targetProfile.id, { scope: 'device' });

        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await expect(TokenStorage.setCredentials({
            token: 'marked-token',
            secret: 'marked-secret',
        })).resolves.toBe(true);
        const createdAt = Date.now();
        await expect(TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'proof',
            secret: 'marked-secret',
            serverId: targetProfile.id,
            serverUrl: targetProfile.serverUrl,
            returnTo: '/settings/account',
            accountEncryptionFirstKey: {
                accountId: 'account-1',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{"toMode":"e2ee"}',
                createdAt,
                expiresAt: createdAt + 10 * 60 * 1000,
                pending: 'oauth-pending',
                migrationSubmissionAttempted: true,
            },
        })).resolves.toBe(true);
        profiles.setActiveServerId(activeProfile.id, { scope: 'device' });

        const { removeServerProfileUiAction } = await import('./removeServerProfileUiAction');
        const result = await removeServerProfileUiAction({
            profileId: targetProfile.id,
            serverUrl: targetProfile.serverUrl,
        });

        expect(result).toMatchObject({
            kind: 'finish_encryption_setup',
        });
        expect(profiles.getServerProfileById(targetProfile.id)).not.toBeNull();
        await expect(TokenStorage.getCredentialsForServerUrl(
            targetProfile.serverUrl,
            { serverId: targetProfile.id },
        )).resolves.toEqual({
            token: 'marked-token',
            secret: 'marked-secret',
        });

        localStorageHandle.restore();
    });

    it('does not remove the profile when target credential deletion fails', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
        const localStorageHandle = installLocalStorageMock();

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const profile = profiles.upsertServerProfile({
            serverUrl: 'https://delete-failure.example.test',
            name: 'Delete failure',
        });
        profiles.setActiveServerId(profile.id, { scope: 'device' });

        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        vi.spyOn(TokenStorage, 'removeCredentialsForServerUrl')
            .mockResolvedValue(false);

        const { removeServerProfileUiAction } = await import('./removeServerProfileUiAction');
        await expect(removeServerProfileUiAction({
            profileId: profile.id,
            serverUrl: profile.serverUrl,
        })).rejects.toThrow('Failed to remove server credentials');

        expect(profiles.getServerProfileById(profile.id)).not.toBeNull();
        localStorageHandle.restore();
    });
});
