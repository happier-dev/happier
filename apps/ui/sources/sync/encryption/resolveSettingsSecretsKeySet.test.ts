import { beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { deriveSettingsSecretsKeySetV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';

import { encodeBase64 } from '@/encryption/base64';

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
        const keysByAccount = [];

        for (const [index, secret] of [new Uint8Array(32).fill(21), new Uint8Array(32).fill(22)].entries()) {
            const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
            const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
            const scope = { serverId: 'server-a', accountId: `account-${index}` };
            const legacy = await resolveSettingsSecretsKeySet({
                credentials: { token: `token-${index}`, secret: encodeBase64(secret, 'base64url') },
                scope,
            });
            const dataKey = await resolveSettingsSecretsKeySet({
                credentials: {
                    token: `token-${index}`,
                    encryption: {
                        publicKey: encodeBase64(publicKey, 'base64'),
                        machineKey: encodeBase64(machineKey, 'base64'),
                    },
                },
                scope,
            });

            expect(legacy).toEqual(deriveSettingsSecretsKeySetV1({ type: 'legacy', secret }));
            expect(dataKey).toEqual(deriveSettingsSecretsKeySetV1({ type: 'dataKey', machineKey }));
            expect(legacy?.readKeys).toHaveLength(2);
            expect(dataKey?.readKeys).toHaveLength(1);
            expect(dataKey?.writeKey).toEqual(legacy?.writeKey);
            keysByAccount.push(dataKey?.writeKey);
        }

        expect(resolveDeviceLocalSettingsSecretsKey).not.toHaveBeenCalled();
        expect(keysByAccount[0]).not.toEqual(keysByAccount[1]);
    });
});
