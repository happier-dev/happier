import {
    accountSettingsParse,
    decryptSecretValueWithKeysV1,
    deriveSettingsSecretsKeySetV1,
    encryptSecretStringV1,
    sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import {
    clearActiveAccountSettingsSnapshot,
    getActiveAccountSettingsSnapshot,
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';

import {
    updateActivePluginAccountSettings,
    updateActivePluginAccountSettingsOnce,
} from './accountSettingsStorage';

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
            {
                operations: [{
                    op: 'set',
                    key: 'sessionPendingQueueDeliveryTiming',
                    value: 'after_foreground_ready',
                }],
            },
            {
                readCredentials: async () => credentials,
                nowMs: () => 400,
                accountSettingsUpdateDeps: {
                    fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 3 }),
                    resolveAccountEncryptionMode: async () => 'plain',
                    updateSettings: async () => ({ success: true, version: 4 }),
                    writeCache: async () => {},
                    resolveCachePath: () => '/tmp/plugin-account-settings',
                },
            },
        );

        expect(returned).toMatchObject({
            status: 'applied',
            version: 4,
            settings: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' },
        });
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
            {
                operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }],
            },
            {
                readCredentials: async () => credentials,
                nowMs: () => 400,
                accountSettingsUpdateDeps: {
                    fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 3 }),
                    resolveAccountEncryptionMode: async () => 'plain',
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

    it('rejects a stale Account Settings version before a secret-style one-shot update reaches transport', async () => {
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 6,
            loadedAtMs: 600,
            settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(credentials),
        });
        const fetchSettings = vi.fn(async () => ({ content: { t: 'plain' as const, v: {} }, version: 6 }));

        const result = await updateActivePluginAccountSettingsOnce({
            expectedVersion: 5,
            mutate: (settings) => ({ ...settings, pluginSecretBinding: true }),
            deps: {
                readCredentials: async () => credentials,
                accountSettingsUpdateDeps: { fetchSettings },
            },
        });

        expect(result).toEqual({ status: 'conflict', currentVersion: 6 });
        expect(fetchSettings).not.toHaveBeenCalled();
    });

    it('returns an acknowledged one-shot conflict when cancellation starts during submission', async () => {
        const controller = new AbortController();
        const updateSettings = vi.fn(async () => {
            controller.abort();
            return {
                success: false as const,
                error: 'version-mismatch' as const,
                currentVersion: 6,
                currentContent: { t: 'plain' as const, v: { concurrent: true } },
            };
        });

        await expect(updateActivePluginAccountSettingsOnce({
            expectedVersion: 5,
            mutate: (settings) => ({ ...settings, pluginSecretBinding: true }),
            deps: {
                signal: controller.signal,
                readCredentials: async () => credentials,
                accountSettingsUpdateDeps: {
                    fetchSettings: async () => ({ content: { t: 'plain' as const, v: {} }, version: 5 }),
                    resolveAccountEncryptionMode: async () => 'plain',
                    updateSettings,
                },
            },
        })).resolves.toEqual({ status: 'conflict', currentVersion: 6 });
        expect(updateSettings).toHaveBeenCalledTimes(1);
    });

    it('publishes an acknowledged one-shot success without running a stale caller fence after the response', async () => {
        let acknowledged = false;
        const assertCurrent = vi.fn(() => {
            if (acknowledged) throw new Error('plugin invocation retired after submission');
        });

        await expect(updateActivePluginAccountSettingsOnce({
            expectedVersion: 5,
            mutate: (settings) => ({ ...settings, pluginSecretBinding: true }),
            deps: {
                assertCurrent,
                readCredentials: async () => credentials,
                nowMs: () => 400,
                accountSettingsUpdateDeps: {
                    fetchSettings: async () => ({ content: { t: 'plain' as const, v: {} }, version: 5 }),
                    resolveAccountEncryptionMode: async () => 'plain',
                    updateSettings: async () => {
                        acknowledged = true;
                        return { success: true as const, version: 6 };
                    },
                    writeCache: async () => {},
                    resolveCachePath: () => '/tmp/plugin-account-settings',
                },
            },
        })).resolves.toMatchObject({ status: 'applied', version: 6 });
    });

    it('does not republish an acknowledged one-shot write after the active Account lifetime is cleared during submission', async () => {
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 5,
            loadedAtMs: 500,
            settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(credentials),
        });
        let settleUpdate!: (response: { success: true; version: number }) => void;
        const initialContent = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: {
                type: 'legacy',
                secret: credentials.encryption.type === 'legacy'
                    ? credentials.encryption.secret
                    : new Uint8Array(),
            },
            payload: {},
            randomBytes: (length) => new Uint8Array(length).fill(1),
        });
        const cached = vi.fn();
        const updateSettings = vi.fn(() => new Promise<{ success: true; version: number }>((resolve) => {
            settleUpdate = resolve;
        }));

        const pending = updateActivePluginAccountSettingsOnce({
            expectedVersion: 5,
            mutate: (settings) => ({ ...settings, pluginSecretBinding: true }),
            deps: {
                readCredentials: async () => credentials,
                accountSettingsUpdateDeps: {
                    fetchSettings: async () => ({ content: { t: 'encrypted' as const, c: initialContent }, version: 5 }),
                    resolveAccountEncryptionMode: async () => 'e2ee',
                    randomBytes: (length) => new Uint8Array(length).fill(2),
                    updateSettings,
                    writeCache: async (_path, _cache, options) => {
                        if (options?.shouldCommit?.() !== false) cached();
                    },
                    resolveCachePath: () => '/tmp/plugin-account-settings',
                },
            },
        });

        await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
        clearActiveAccountSettingsSnapshot();
        settleUpdate({ success: true, version: 6 });

        await expect(pending).resolves.toMatchObject({ status: 'applied', version: 6 });
        expect(getActiveAccountSettingsSnapshot()).toBeNull();
        expect(cached).not.toHaveBeenCalled();
    });

    it('does not submit a one-shot write after its active lifetime retires while fetching settings', async () => {
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 5,
            loadedAtMs: 500,
            settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(credentials),
        });
        let releaseFetch!: (value: { content: { t: 'plain'; v: Record<string, never> }; version: number }) => void;
        const pendingFetch = new Promise<{ content: { t: 'plain'; v: Record<string, never> }; version: number }>((resolve) => {
            releaseFetch = resolve;
        });
        const fetchSettings = vi.fn(async () => await pendingFetch);
        const updateSettings = vi.fn(async () => ({ success: true as const, version: 6 }));

        const pending = updateActivePluginAccountSettingsOnce({
            expectedVersion: 5,
            mutate: (settings) => ({ ...settings, pluginSecretBinding: true }),
            deps: {
                readCredentials: async () => credentials,
                accountSettingsUpdateDeps: {
                    fetchSettings,
                    resolveAccountEncryptionMode: async () => 'plain',
                    updateSettings,
                    writeCache: async () => {},
                    resolveCachePath: () => '/tmp/plugin-account-settings',
                },
            },
        });

        await vi.waitFor(() => expect(fetchSettings).toHaveBeenCalledTimes(1));
        clearActiveAccountSettingsSnapshot();
        releaseFetch({ content: { t: 'plain', v: {} }, version: 5 });

        await expect(pending).resolves.toEqual({ status: 'cancelled', submitted: false });
        expect(updateSettings).not.toHaveBeenCalled();
        expect(getActiveAccountSettingsSnapshot()).toBeNull();
    });

    it('does not submit a one-shot write after its caller retires while fetching settings', async () => {
        let releaseFetch!: (value: { content: { t: 'plain'; v: Record<string, never> }; version: number }) => void;
        const pendingFetch = new Promise<{ content: { t: 'plain'; v: Record<string, never> }; version: number }>((resolve) => {
            releaseFetch = resolve;
        });
        const fetchSettings = vi.fn(async () => await pendingFetch);
        const updateSettings = vi.fn(async () => ({ success: true as const, version: 6 }));
        let current = true;

        const pending = updateActivePluginAccountSettingsOnce({
            expectedVersion: 5,
            mutate: (settings) => ({ ...settings, pluginSecretBinding: true }),
            deps: {
                assertCurrent: () => {
                    if (!current) throw new Error('plugin invocation retired before submission');
                },
                readCredentials: async () => credentials,
                accountSettingsUpdateDeps: {
                    fetchSettings,
                    resolveAccountEncryptionMode: async () => 'plain',
                    updateSettings,
                    writeCache: async () => {},
                    resolveCachePath: () => '/tmp/plugin-account-settings',
                },
            },
        });

        await vi.waitFor(() => expect(fetchSettings).toHaveBeenCalledTimes(1));
        current = false;
        releaseFetch({ content: { t: 'plain', v: {} }, version: 5 });

        await expect(pending).rejects.toThrow('plugin invocation retired before submission');
        expect(updateSettings).not.toHaveBeenCalled();
    });

    it('publishes an acknowledged replay-safe update without running a stale caller fence after the response', async () => {
        let acknowledged = false;
        const assertCurrent = vi.fn(() => {
            if (acknowledged) throw new Error('plugin invocation retired after submission');
        });

        await expect(updateActivePluginAccountSettings(
            {
                operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }],
            },
            {
                assertCurrent,
                readCredentials: async () => credentials,
                nowMs: () => 400,
                accountSettingsUpdateDeps: {
                    fetchSettings: async () => ({ content: { t: 'plain' as const, v: {} }, version: 5 }),
                    resolveAccountEncryptionMode: async () => 'plain',
                    updateSettings: async () => {
                        acknowledged = true;
                        return { success: true as const, version: 6 };
                    },
                    writeCache: async () => {},
                    resolveCachePath: () => '/tmp/plugin-account-settings',
                },
            },
        )).resolves.toMatchObject({ status: 'applied', version: 6 });
        expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(6);
    });
});
