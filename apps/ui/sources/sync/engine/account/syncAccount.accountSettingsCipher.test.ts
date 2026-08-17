import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    decryptSecretValueV1,
    encryptSecretStringV1,
    sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';
import { profileDefaults } from '@/sync/domains/profiles/profile';

vi.mock('expo-constants', () => ({
    default: {},
}));

vi.mock('expo-notifications', () => ({
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
}));

vi.mock('@/sync/encryption/secretSettings', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/encryption/secretSettings')>();
    return {
        ...actual,
        deriveSettingsSecretsKey: async () => new Uint8Array(32).fill(9),
        sealSecretsDeep: (value: unknown) => value,
    };
});

describe('handleUpdateAccountSocketUpdate account settings ciphertext', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('opens canonical account_scoped_v1 settings without calling decryptRaw', async () => {
        const { handleUpdateAccountSocketUpdate } = await import('./syncAccount');

        const applyProfile = vi.fn();
        const applySettings = vi.fn();
        const machineKey = new Uint8Array(32).fill(7);
        const ciphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey },
            payload: { analyticsOptOut: true },
            randomBytes: () => new Uint8Array(24).fill(1),
        });

        const encryption = {
            getContentPrivateKey: () => machineKey,
            decryptRaw: vi.fn(async () => {
                throw new Error('decryptRaw should not be used for canonical ciphertext');
            }),
        } as any;

        await handleUpdateAccountSocketUpdate({
            accountUpdate: {
                settings: {
                    value: ciphertext,
                    version: 7,
                },
            },
            updateCreatedAt: 123,
            currentProfile: { ...profileDefaults },
            encryption,
            applyProfile,
            applySettings,
            log: { log: vi.fn() },
        });

        expect(encryption.decryptRaw).not.toHaveBeenCalled();
        expect(applySettings).toHaveBeenCalledWith(expect.objectContaining({ analyticsOptOut: true }), 7);
    });

    it('applies settingsV2 plain content without calling decryptRaw', async () => {
        const { handleUpdateAccountSocketUpdate } = await import('./syncAccount');

        const applyProfile = vi.fn();
        const applySettings = vi.fn();
        const machineKey = new Uint8Array(32).fill(7);

        const encryption = {
            getContentPrivateKey: () => machineKey,
            decryptRaw: vi.fn(async () => {
                throw new Error('decryptRaw should not be used for plaintext settings');
            }),
        } as any;

        await handleUpdateAccountSocketUpdate({
            accountUpdate: {
                settingsV2: {
                    content: { t: 'plain', v: { analyticsOptOut: true } },
                    version: 9,
                },
            },
            updateCreatedAt: 123,
            currentProfile: { ...profileDefaults },
            encryption,
            applyProfile,
            applySettings,
            log: { log: vi.fn() },
        });

        expect(encryption.decryptRaw).not.toHaveBeenCalled();
        expect(applySettings).toHaveBeenCalledWith(expect.objectContaining({ analyticsOptOut: true }), 9);
    });

    it('opens canonical account_scoped_v1 settingsV2 encrypted content without calling decryptRaw', async () => {
        const { handleUpdateAccountSocketUpdate } = await import('./syncAccount');

        const applyProfile = vi.fn();
        const applySettings = vi.fn();
        const machineKey = new Uint8Array(32).fill(7);
        const ciphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey },
            payload: { analyticsOptOut: true },
            randomBytes: () => new Uint8Array(24).fill(1),
        });

        const encryption = {
            getContentPrivateKey: () => machineKey,
            decryptRaw: vi.fn(async () => {
                throw new Error('decryptRaw should not be used for canonical ciphertext');
            }),
        } as any;

        await handleUpdateAccountSocketUpdate({
            accountUpdate: {
                settingsV2: {
                    content: { t: 'encrypted', c: ciphertext },
                    version: 11,
                },
            },
            updateCreatedAt: 123,
            currentProfile: { ...profileDefaults },
            encryption,
            applyProfile,
            applySettings,
            log: { log: vi.fn() },
        });

        expect(encryption.decryptRaw).not.toHaveBeenCalled();
        expect(applySettings).toHaveBeenCalledWith(expect.objectContaining({ analyticsOptOut: true }), 11);
    });

    it('rejects a raw cross-domain object without calling the ambiguous decryptor', async () => {
        const { handleUpdateAccountSocketUpdate } = await import('./syncAccount');
        const applySettings = vi.fn();
        const decryptRaw = vi.fn(async () => ({
            name: 'automation',
            prompt: 'not account settings',
        }));
        const log = vi.fn();

        await handleUpdateAccountSocketUpdate({
            accountUpdate: {
                settings: {
                    value: 'untagged-cross-domain-ciphertext',
                    version: 12,
                },
            },
            updateCreatedAt: 123,
            currentProfile: { ...profileDefaults },
            encryption: {
                getContentPrivateKey: () =>
                    new Uint8Array(32).fill(7),
                decryptRaw,
            } as any,
            applyProfile: vi.fn(),
            applySettings,
            log: { log },
        });

        expect(decryptRaw).not.toHaveBeenCalled();
        expect(applySettings).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith(
            expect.stringContaining('no authenticated settings domain'),
        );
    });

    it('rejects a malformed settingsV2 envelope without replacing local settings with defaults', async () => {
        const { handleUpdateAccountSocketUpdate } = await import('./syncAccount');
        const applySettings = vi.fn();
        const log = vi.fn();

        await handleUpdateAccountSocketUpdate({
            accountUpdate: {
                settingsV2: {
                    content: { t: 'unexpected', v: { analyticsOptOut: true } },
                    version: 13,
                },
            },
            updateCreatedAt: 123,
            currentProfile: { ...profileDefaults },
            encryption: null,
            applyProfile: vi.fn(),
            applySettings,
            log: { log },
        });

        expect(applySettings).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith(
            expect.stringContaining('Invalid account settings stored content'),
        );
    });

    it('re-seals socket settings secrets through the canonical local key set', async () => {
        const { handleUpdateAccountSocketUpdate } = await import('./syncAccount');
        const applySettings = vi.fn();
        const machineKey = new Uint8Array(32).fill(7);
        const previousSettingsKey = new Uint8Array(32).fill(8);
        const currentSettingsKey = new Uint8Array(32).fill(9);
        const encryptedValue = encryptSecretStringV1(
            'retained-secret',
            previousSettingsKey,
            (length) => new Uint8Array(length).fill(1),
        );
        const ciphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey },
            payload: {
                secrets: [{
                    id: 'secret-1',
                    name: 'Secret',
                    kind: 'apiKey',
                    encryptedValue: {
                        _isSecretValue: true,
                        encryptedValue,
                    },
                    createdAt: 1,
                    updatedAt: 1,
                }],
            },
            randomBytes: () => new Uint8Array(24).fill(2),
        });

        await handleUpdateAccountSocketUpdate({
            accountUpdate: {
                settingsV2: {
                    content: { t: 'encrypted', c: ciphertext },
                    version: 14,
                },
            },
            updateCreatedAt: 123,
            currentProfile: { ...profileDefaults },
            encryption: {
                getContentPrivateKey: () => machineKey,
            } as any,
            settingsSecretsKey: currentSettingsKey,
            settingsSecretsReadKeys: [previousSettingsKey],
            applyProfile: vi.fn(),
            applySettings,
            log: { log: vi.fn() },
        });

        const appliedSecret = applySettings.mock.calls[0]?.[0]?.secrets?.[0]?.encryptedValue;
        expect(decryptSecretValueV1(appliedSecret, currentSettingsKey)).toBe('retained-secret');
    });
});
