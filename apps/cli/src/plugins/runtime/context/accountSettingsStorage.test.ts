import {
    accountSettingsParse,
    decryptSecretValueWithKeysV1,
    deriveSettingsSecretsKeySetV1,
    encryptSecretStringV1,
} from '@happier-dev/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import {
    getActiveAccountSettingsSnapshot,
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';

import { updateActivePluginAccountSettings } from './accountSettingsStorage';

const credentials: Credentials = {
    token: 'account-a',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(4) },
};

describe('updateActivePluginAccountSettings', () => {
    beforeEach(() => {
        resetActiveAccountSettingsSnapshotForTests();
    });

    it('returns the canonical newer winner when its completed update is older', async () => {
        const winner = accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' });
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: winner,
            settingsVersion: 5,
            loadedAtMs: 500,
            settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(credentials),
        });

        const returned = await updateActivePluginAccountSettings(
            () => ({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
            {
                readCredentials: async () => credentials,
                nowMs: () => 400,
                accountSettingsUpdateDeps: {
                    fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 3 }),
                    updateSettings: async () => ({ success: true, version: 4 }),
                    writeCache: async () => {},
                    resolveCachePath: () => '/tmp/plugin-account-settings',
                },
            },
        );

        expect(returned).toBe(winner);
        expect(getActiveAccountSettingsSnapshot()?.settings).toBe(winner);
        expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(5);
    });

    it('publishes the authenticated secret read keys when no active snapshot exists', async () => {
        const encryptedValue = encryptSecretStringV1(
            'provider-secret',
            deriveSettingsSecretsKeySetV1({
                type: 'legacy',
                secret: credentials.encryption.type === 'legacy'
                    ? credentials.encryption.secret
                    : new Uint8Array(),
            }).writeKey,
            (length) => new Uint8Array(length).fill(3),
        );

        await updateActivePluginAccountSettings(
            (settings) => ({ ...settings, pluginSetting: true }),
            {
                readCredentials: async () => credentials,
                nowMs: () => 400,
                accountSettingsUpdateDeps: {
                    fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 3 }),
                    updateSettings: async () => ({ success: true, version: 4 }),
                    writeCache: async () => {},
                    resolveCachePath: () => '/tmp/plugin-account-settings',
                },
            },
        );

        const snapshot = getActiveAccountSettingsSnapshot();
        expect(snapshot?.settingsVersion).toBe(4);
        expect(decryptSecretValueWithKeysV1(
            { _isSecretValue: true, encryptedValue },
            snapshot?.settingsSecretsReadKeys ?? [],
        )).toBe('provider-secret');
    });
});
