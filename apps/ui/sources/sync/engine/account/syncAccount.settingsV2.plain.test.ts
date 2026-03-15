import { describe, expect, it, vi } from 'vitest';

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

describe('handleUpdateAccountSocketUpdate settingsV2 (plain)', () => {
    it('applies settingsV2 plaintext content and preserves local server-selection keys', async () => {
        const { handleUpdateAccountSocketUpdate } = await import('./syncAccount');

        const applyProfile = vi.fn();
        const applySettings = vi.fn();
        const encryption = {
            getContentPrivateKey: () => new Uint8Array(32).fill(7),
            decryptRaw: vi.fn(),
        } as any;

        await handleUpdateAccountSocketUpdate({
            accountUpdate: {
                settingsV2: {
                    content: { t: 'plain', v: { analyticsOptOut: true } },
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
                serverSelectionGroups: [{ id: 'grp-dev', name: 'Dev', serverIds: ['server-a'], presentation: 'grouped' }],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'grp-dev',
            }),
            5,
        );
        expect(encryption.decryptRaw).not.toHaveBeenCalled();
    });
});
