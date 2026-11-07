import { describe, expect, it, vi } from 'vitest';

import { openAccountSettingsCiphertext, sealAccountSettingsCiphertext } from './accountSettingsCipher';
import { applySettings, SettingsSchema, settingsDefaults, SUPPORTED_SCHEMA_VERSION, type Settings } from './settings';
import { parseAccountSettings } from './parse/accountSettingsParse';
import { pruneSecretBindings } from './secretBindings';

describe('account settings cipher', () => {
    it('preserves the opaque retention choice through a released-reader encrypted unrelated update', async () => {
        // ui-web-v0.2.21 (f6f4032ffe21310f83a652c0c7dc07a205e66ee8)
        // uses this unchanged parser/merge/cipher owner. The UI schema does
        // not recognize this provider-owned field, matching its released reader.
        const schema = SettingsSchema;
        expect(Object.hasOwn(schema.shape, 'claudeSessionRetentionV1')).toBe(false);
        const { claudeSessionRetentionV1: _futureDefault, ...defaults } = settingsDefaults;
        const policy = { mode: 'days', days: 36500 };
        const machineKey = new Uint8Array(32).fill(9);
        const randomBytes = (length: number) => new Uint8Array(length).fill(1);
        const ciphertext = sealAccountSettingsCiphertext({ machineKey, randomBytes,
            settings: { claudeSessionRetentionV1: policy, analyticsOptOut: false } });
        const opened = await openAccountSettingsCiphertext({ machineKey, ciphertext });
        const parsed = parseAccountSettings({ settings: opened?.value, schema,
            defaults: defaults as Record<string, unknown>, supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
            pruneResult: settings => pruneSecretBindings(settings as Settings) as Record<string, unknown>,
            debugEnabled: false, isDev: false });
        const updated = applySettings(parsed as Settings, { analyticsOptOut: true });
        const resealed = sealAccountSettingsCiphertext({ machineKey, randomBytes, settings: updated });
        expect((await openAccountSettingsCiphertext({ machineKey, ciphertext: resealed }))?.value)
            .toMatchObject({ claudeSessionRetentionV1: policy, analyticsOptOut: true });
    });

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

