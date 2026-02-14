import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { profileDefaults } from '@/sync/domains/profiles/profile';

vi.mock('expo-constants', () => ({
    default: {},
}));

vi.mock('expo-notifications', () => ({
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
}));

vi.mock('@/sync/domains/settings/localOnlyServerSelectionSettings', () => ({
    pickLocalOnlyServerSelectionSettings: () => ({}),
}));

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
});

