import { describe, expect, it, vi } from 'vitest';

const credentialSet = vi.hoisted(() => vi.fn(async () => true));
const credentialRemove = vi.hoisted(() => vi.fn(async () => true));

vi.mock('./accountDirectoryCredentialStorage', () => ({
    accountDirectoryCredentialStorage: {
        set: credentialSet,
        remove: credentialRemove,
    },
}));

vi.mock('@/sync/api/accountDirectory/accountDirectoryClient', () => ({
    createAccountDirectoryClient: vi.fn(),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    adoptHomeProfile: vi.fn(),
}));

describe('accountDirectoryAuthClient', () => {
    it('stores Account Service credentials in its endpoint namespace without touching Home runtime', async () => {
        const { accountDirectoryAuthClient } = await import('./accountDirectoryAuthClient');

        await expect(accountDirectoryAuthClient.completeOAuth({
            endpoint: 'https://accounts.example.test',
            token: 'account-token',
            purpose: 'account_directory',
        })).resolves.toBe(true);

        expect(credentialSet).toHaveBeenCalledWith(
            'https://accounts.example.test',
            { token: 'account-token' },
        );
        expect(credentialRemove).not.toHaveBeenCalled();
    });

    it('keeps Account Service disconnect scoped to the Account Service endpoint', async () => {
        const { accountDirectoryAuthClient } = await import('./accountDirectoryAuthClient');

        await expect(accountDirectoryAuthClient.logout('https://accounts.example.test')).resolves.toBe(true);
        expect(credentialRemove).toHaveBeenCalledWith('https://accounts.example.test');
    });
});
