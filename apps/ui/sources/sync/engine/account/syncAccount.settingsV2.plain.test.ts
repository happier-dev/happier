import { describe, expect, it, vi } from 'vitest';

import { profileDefaults } from '@/sync/domains/profiles/profile';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { EncryptionMaterialUnavailableError } from '@/sync/encryption/encryption';

vi.mock('expo-constants', () => ({
    default: {},
}));

vi.mock('expo-notifications', () => ({
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
}));

describe('handleUpdateAccountSocketUpdate settingsV2 (plain)', () => {
    it('applies settingsV2 plaintext content and preserves local server-selection keys', async () => {
        const { handleUpdateAccountSocketUpdate } = await import('./syncAccount');

        const applyProfile = vi.fn();
        const applySettings = vi.fn();
        const encryption = await createEncryptionFromAuthCredentials({ token: 'plain-token' });
        const secret = {
            id: 'secret-a', name: 'API key', kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, value: 'plain-secret' },
            createdAt: 1, updatedAt: 1,
        };

        await handleUpdateAccountSocketUpdate({
            accountUpdate: {
                settingsV2: {
                    content: { t: 'plain', v: { analyticsOptOut: true, secrets: [secret] } },
                    version: 5,
                },
            },
            updateCreatedAt: 123,
            currentProfile: { ...profileDefaults },
            encryption,
            applyProfile,
            applySettings,
            getLocalSettings: () => ({
                serverSelectionGroups: [{ id: 'grp-dev', name: 'Dev', serverIds: ['server-a'] }],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'grp-dev',
            }),
            log: { log: vi.fn() },
        });

        expect(applySettings).toHaveBeenCalledWith(
            expect.objectContaining({
                analyticsOptOut: true,
                secrets: [secret],
                serverSelectionGroups: [{ id: 'grp-dev', name: 'Dev', serverIds: ['server-a'], presentation: 'grouped' }],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'grp-dev',
            }),
            5,
        );
        expect(encryption.hasEncryptionMaterial()).toBe(false);
    });

    it('rejects encrypted socket settings when account encryption material is absent', async () => {
        const { handleUpdateAccountSocketUpdate } = await import('./syncAccount');
        const encryption = await createEncryptionFromAuthCredentials({ token: 'plain-token' });
        const applySettings = vi.fn();
        const log = { log: vi.fn() };

        await handleUpdateAccountSocketUpdate({
            accountUpdate: { settingsV2: { content: { t: 'encrypted', c: 'ciphertext' }, version: 6 } },
            updateCreatedAt: 123,
            currentProfile: { ...profileDefaults },
            encryption,
            applyProfile: vi.fn(),
            applySettings,
            log,
        });

        expect(applySettings).not.toHaveBeenCalled();
        expect(log.log).toHaveBeenCalledWith(expect.stringContaining(new EncryptionMaterialUnavailableError().message));
    });
});
