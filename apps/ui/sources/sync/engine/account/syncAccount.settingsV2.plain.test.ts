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
    };
});

describe('handleUpdateAccountSocketUpdate settingsV2 (plain)', () => {
    it('applies settingsV2 plaintext content and preserves local server-selection keys', async () => {
        const { handleUpdateAccountSocketUpdate } = await import('./syncAccount');

        const applyProfile = vi.fn();
        const applySettings = vi.fn();
        await handleUpdateAccountSocketUpdate({
            accountUpdate: {
                settingsV2: {
                    content: { t: 'plain', v: { analyticsOptOut: true } },
                    version: 5,
                },
            },
            updateCreatedAt: 123,
            currentProfile: { ...profileDefaults },
            encryption: null,
            settingsSecretsKey: new Uint8Array(32).fill(9),
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
    });

    it('does not apply a raw secret-bearing socket snapshot when device-local custody is unavailable', async () => {
        const { handleUpdateAccountSocketUpdate } = await import('./syncAccount');
        const applySettings = vi.fn();
        const log = { log: vi.fn() };

        await handleUpdateAccountSocketUpdate({
            accountUpdate: {
                settingsV2: {
                    content: {
                        t: 'plain',
                        v: {
                            secrets: [{
                                id: 'secret-1',
                                name: 'Secret',
                                kind: 'apiKey',
                                encryptedValue: {
                                    _isSecretValue: true,
                                    value: 'must-not-persist-locally',
                                },
                                createdAt: 1,
                                updatedAt: 1,
                            }],
                        },
                    },
                    version: 6,
                },
            },
            updateCreatedAt: 124,
            currentProfile: { ...profileDefaults },
            encryption: null,
            settingsSecretsKey: null,
            applyProfile: vi.fn(),
            applySettings,
            getLocalSettings: () => ({}),
            log,
        });

        expect(applySettings).not.toHaveBeenCalled();
        expect(log.log).toHaveBeenCalledWith(
            'Failed to process settings v2 update: Local settings secret key is unavailable',
        );
    });

    it('device-seals a plaintext account secret before applying it to local persisted settings', async () => {
        const { handleUpdateAccountSocketUpdate } = await import('./syncAccount');
        const applySettings = vi.fn();

        await handleUpdateAccountSocketUpdate({
            accountUpdate: {
                settingsV2: {
                    content: {
                        t: 'plain',
                        v: {
                            secrets: [{
                                id: 'secret-1',
                                name: 'Secret',
                                kind: 'apiKey',
                                encryptedValue: {
                                    _isSecretValue: true,
                                    value: 'server-readable-plain-account-secret',
                                },
                                createdAt: 1,
                                updatedAt: 1,
                            }],
                        },
                    },
                    version: 7,
                },
            },
            updateCreatedAt: 125,
            currentProfile: { ...profileDefaults },
            encryption: null,
            settingsSecretsKey: new Uint8Array(32).fill(9),
            applyProfile: vi.fn(),
            applySettings,
            getLocalSettings: () => ({}),
            log: { log: vi.fn() },
        });

        const applied = applySettings.mock.calls[0]?.[0];
        const storedSecret = applied?.secrets?.[0]?.encryptedValue;
        expect(storedSecret?.value).toBeUndefined();
        expect(storedSecret?.encryptedValue).toMatchObject({
            t: 'enc-v1',
            c: expect.any(String),
        });
    });
});
