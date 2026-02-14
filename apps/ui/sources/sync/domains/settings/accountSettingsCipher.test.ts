import { describe, expect, it, vi } from 'vitest';

import { openAccountSettingsCiphertext, sealAccountSettingsCiphertext } from './accountSettingsCipher';

describe('account settings cipher', () => {
    it('seals and opens canonical account_scoped_v1 ciphertext', async () => {
        const machineKey = new Uint8Array(32).fill(9);
        const randomBytes = (length: number) => new Uint8Array(length).fill(1);
        const ciphertext = sealAccountSettingsCiphertext({
            machineKey,
            settings: { analyticsOptOut: true, claudeLocalPermissionBridgeEnabled: true },
            randomBytes,
        });

        const fallbackDecryptRaw = vi.fn(async () => null);
        const opened = await openAccountSettingsCiphertext({ machineKey, ciphertext, fallbackDecryptRaw });

        expect(opened?.format).toBe('account_scoped_v1');
        expect(opened?.value).toEqual({ analyticsOptOut: true, claudeLocalPermissionBridgeEnabled: true });
        expect(fallbackDecryptRaw).not.toHaveBeenCalled();
    });

    it('falls back to decryptRaw when ciphertext is not in the canonical format', async () => {
        const machineKey = new Uint8Array(32).fill(9);
        const fallbackDecryptRaw = vi.fn(async () => ({
            analyticsOptOut: false,
            claudeLocalPermissionBridgeEnabled: true,
        }));

        const opened = await openAccountSettingsCiphertext({
            machineKey,
            ciphertext: 'legacy-ciphertext',
            fallbackDecryptRaw,
        });

        expect(opened?.format).toBe('unknown');
        expect(opened?.value).toEqual({
            analyticsOptOut: false,
            claudeLocalPermissionBridgeEnabled: true,
        });
        expect(fallbackDecryptRaw).toHaveBeenCalledTimes(1);
    });

    it('returns null when ciphertext cannot be decrypted to an object', async () => {
        const machineKey = new Uint8Array(32).fill(9);
        const opened = await openAccountSettingsCiphertext({
            machineKey,
            ciphertext: 'legacy-ciphertext',
            fallbackDecryptRaw: async () => null,
        });
        expect(opened).toBeNull();
    });
});

