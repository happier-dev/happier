import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => new Map<string, string>());
const writeDeviceLocalStorageString = vi.hoisted(() => vi.fn(async (key: string, value: string) => {
    storage.set(key, value);
}));
const readDeviceLocalStorageString = vi.hoisted(() => vi.fn(async (key: string) => storage.get(key) ?? null));
const getRandomBytes = vi.hoisted(() => vi.fn((length: number) => new Uint8Array(length).fill(7)));

vi.mock('./deviceLocalStorage', () => ({
    readDeviceLocalStorageString,
    writeDeviceLocalStorageString,
}));

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytes,
}));

describe('resolveDeviceLocalSettingsSecretsKey', () => {
    beforeEach(() => {
        storage.clear();
        readDeviceLocalStorageString.mockClear();
        writeDeviceLocalStorageString.mockClear();
        writeDeviceLocalStorageString.mockImplementation(async (key: string, value: string) => {
            storage.set(key, value);
        });
        getRandomBytes.mockClear();
    });

    it('creates one random device-local key and reuses it for the same server-account scope', async () => {
        const { resolveDeviceLocalSettingsSecretsKey } = await import('./deviceLocalSecretKey');
        const scope = { serverId: 'server-a', accountId: 'account-a' };

        const first = await resolveDeviceLocalSettingsSecretsKey(scope);
        const second = await resolveDeviceLocalSettingsSecretsKey(scope);

        expect(first).toEqual(new Uint8Array(32).fill(7));
        expect(second).toEqual(first);
        expect(getRandomBytes).toHaveBeenCalledTimes(1);
        expect(writeDeviceLocalStorageString).toHaveBeenCalledTimes(1);
    });

    it('does not reuse a device-local key across account scopes', async () => {
        const { resolveDeviceLocalSettingsSecretsKey } = await import('./deviceLocalSecretKey');

        await resolveDeviceLocalSettingsSecretsKey({ serverId: 'server-a', accountId: 'account-a' });
        await resolveDeviceLocalSettingsSecretsKey({ serverId: 'server-a', accountId: 'account-b' });

        expect(writeDeviceLocalStorageString).toHaveBeenCalledTimes(2);
        expect([...storage.keys()]).toHaveLength(2);
    });

    it('fails closed when device-local key custody is unavailable', async () => {
        const { resolveDeviceLocalSettingsSecretsKey } = await import('./deviceLocalSecretKey');
        writeDeviceLocalStorageString.mockRejectedValueOnce(new Error('secure storage unavailable'));

        await expect(resolveDeviceLocalSettingsSecretsKey({
            serverId: 'server-a',
            accountId: 'account-c',
        })).resolves.toBeNull();
    });

    it.each([
        ['malformed JSON', '{not-json'],
        ['unsupported version', JSON.stringify({ v: 2, key: 'ignored' })],
        ['invalid key length', JSON.stringify({ v: 1, key: 'c2hvcnQ=' })],
    ])('preserves an existing %s key record and reports typed unavailability', async (_case, raw) => {
        const { resolveDeviceLocalSettingsSecretsKey } = await import('./deviceLocalSecretKey');
        const scope = { serverId: 'server-a', accountId: `account-corrupt-${_case}` };

        readDeviceLocalStorageString.mockImplementationOnce(async (storageKey: string) => {
            storage.set(storageKey, raw);
            return raw;
        });

        await expect(resolveDeviceLocalSettingsSecretsKey(scope)).rejects.toMatchObject({
            code: 'local_secret_unavailable',
            reason: 'stored_key_corrupt',
        });
        expect(getRandomBytes).not.toHaveBeenCalled();
        expect(writeDeviceLocalStorageString).not.toHaveBeenCalled();
        expect(readDeviceLocalStorageString).toHaveBeenCalledTimes(1);
        expect([...storage.values()]).toEqual([raw]);
    });
});
