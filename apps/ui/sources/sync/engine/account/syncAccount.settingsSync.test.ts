import { describe, expect, it, vi, beforeEach } from 'vitest';

import { profileDefaults } from '@/sync/domains/profiles/profile';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

vi.mock('expo-constants', () => ({
    default: {},
}));

vi.mock('expo-notifications', () => ({
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
}));

const settingsState: { current: Record<string, unknown> } = {
    current: {
        serverSelectionGroups: [
            { id: 'grp-dev', name: 'Dev', serverIds: ['server-a', 'server-b'], presentation: 'grouped' },
        ],
        serverSelectionActiveTargetKind: 'group',
        serverSelectionActiveTargetId: 'grp-dev',
    },
};

describe('handleUpdateAccountSocketUpdate settings merge', () => {
    beforeEach(() => {
        settingsState.current = {
            serverSelectionGroups: [
                { id: 'grp-dev', name: 'Dev', serverIds: ['server-a', 'server-b'], presentation: 'grouped' },
            ],
            serverSelectionActiveTargetKind: 'group',
            serverSelectionActiveTargetId: 'grp-dev',
        };
    });

    it('preserves local server-selection keys when applying account socket settings updates', async () => {
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
            decryptRaw: vi.fn().mockResolvedValue({
                analyticsOptOut: true,
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
            getLocalSettings: () => settingsState.current,
            log: { log: vi.fn() },
        });

        expect(encryption.decryptRaw).not.toHaveBeenCalled();
        expect(applySettings).toHaveBeenCalledWith(
            expect.objectContaining({
                analyticsOptOut: true,
                serverSelectionGroups: [
                    { id: 'grp-dev', name: 'Dev', serverIds: ['server-a', 'server-b'], presentation: 'grouped' },
                ],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'grp-dev',
            }),
            7,
        );
    });
});
