import { beforeEach, describe, expect, it, vi } from 'vitest';

const deviceKey = new Uint8Array(32).fill(9);
const resolveDeviceLocalSettingsSecretsKey = vi.hoisted(() =>
    vi.fn(async (): Promise<Uint8Array | null> => deviceKey),
);

vi.mock('@/auth/storage/deviceLocalSecretKey', () => ({
    resolveDeviceLocalSettingsSecretsKey,
}));

describe('resolveSettingsSecretsKeySet', () => {
    beforeEach(() => {
        resolveDeviceLocalSettingsSecretsKey.mockClear();
        resolveDeviceLocalSettingsSecretsKey.mockResolvedValue(deviceKey);
    });

    it('uses device-local custody for token-only credentials', async () => {
        const { resolveSettingsSecretsKeySet } = await import('./resolveSettingsSecretsKeySet');
        const scope = { serverId: 'server-a', accountId: 'account-a' };

        const resolved = await resolveSettingsSecretsKeySet({
            credentials: { token: 'token-a' },
            scope,
        });

        expect(resolveDeviceLocalSettingsSecretsKey).toHaveBeenCalledWith(scope);
        expect(resolved).toEqual({ writeKey: deviceKey, readKeys: [deviceKey] });
    });

    it('returns null rather than allowing raw local secret persistence when device custody fails', async () => {
        const { resolveSettingsSecretsKeySet } = await import('./resolveSettingsSecretsKeySet');
        resolveDeviceLocalSettingsSecretsKey.mockResolvedValueOnce(null);

        await expect(resolveSettingsSecretsKeySet({
            credentials: { token: 'token-a' },
            scope: { serverId: 'server-a', accountId: 'account-a' },
        })).resolves.toBeNull();
    });

    it('preserves typed corrupt-key unavailability for the sync owner', async () => {
        const { resolveSettingsSecretsKeySet } = await import('./resolveSettingsSecretsKeySet');
        resolveDeviceLocalSettingsSecretsKey.mockRejectedValueOnce(Object.assign(
            new Error('Device-local settings secret key is unavailable'),
            {
                code: 'local_secret_unavailable',
                reason: 'stored_key_corrupt',
            },
        ));

        await expect(resolveSettingsSecretsKeySet({
            credentials: { token: 'token-a' },
            scope: { serverId: 'server-a', accountId: 'account-a' },
        })).rejects.toMatchObject({
            code: 'local_secret_unavailable',
            reason: 'stored_key_corrupt',
        });
    });

    it('keeps E2EE settings secrets account-scoped and does not consult device-local custody', async () => {
        const { resolveSettingsSecretsKeySet } = await import('./resolveSettingsSecretsKeySet');

        const resolved = await resolveSettingsSecretsKeySet({
            credentials: {
                token: 'token-a',
                encryption: {
                    publicKey: 'cHVibGljLWtleQ==',
                    machineKey: 'bWFjaGluZS1rZXktMzItYnl0ZXMtbG9uZy0wMDAwMDA=',
                },
            },
            scope: { serverId: 'server-a', accountId: 'account-a' },
        });

        expect(resolveDeviceLocalSettingsSecretsKey).not.toHaveBeenCalled();
        expect(resolved?.writeKey).toBeInstanceOf(Uint8Array);
        expect(resolved?.readKeys[0]).toEqual(resolved?.writeKey);
    });
});
