import { afterEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.mock('@/auth/storage/deviceLocalStorage', () => ({
    readDeviceLocalStorageString: vi.fn(async (key: string) => storage.get(key) ?? null),
    writeDeviceLocalStorageString: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
    removeDeviceLocalStorageString: vi.fn(async (key: string) => { storage.delete(key); }),
}));

describe('account directory credential storage', () => {
    afterEach(() => storage.clear());

    it('isolates credentials by endpoint and supports independent removal', async () => {
        const { accountDirectoryCredentialStorage } = await import('./accountDirectoryCredentialStorage');
        await accountDirectoryCredentialStorage.set('https://directory-a.test', { token: 'a' });
        await accountDirectoryCredentialStorage.set('https://directory-b.test', { token: 'b' });

        await expect(accountDirectoryCredentialStorage.get('https://directory-a.test')).resolves.toEqual({ token: 'a' });
        await expect(accountDirectoryCredentialStorage.get('https://directory-b.test')).resolves.toEqual({ token: 'b' });

        await accountDirectoryCredentialStorage.remove('https://directory-a.test');
        await expect(accountDirectoryCredentialStorage.get('https://directory-a.test')).resolves.toBeNull();
        await expect(accountDirectoryCredentialStorage.get('https://directory-b.test')).resolves.toEqual({ token: 'b' });
    });

    it('rejects malformed records instead of returning untyped secrets', async () => {
        const { writeDeviceLocalStorageString } = await import('@/auth/storage/deviceLocalStorage');
        await writeDeviceLocalStorageString('account_directory_auth_credentials', '{"bad":true}');
        const { accountDirectoryCredentialStorage } = await import('./accountDirectoryCredentialStorage');
        await expect(accountDirectoryCredentialStorage.get('https://directory.test')).resolves.toBeNull();
    });
});
