import {
    AccountSettingsSchema,
    type AccountSettings,
} from '@happier-dev/protocol';

import type {
    PluginAuthIdentityV1,
    PluginAuthMaterializeRequestV1,
    PluginAuthMaterializedServiceV1,
    PluginContextV1,
    PluginSettingsChangeListenerV1,
    PluginSettingsFormProjectionV1,
} from '../context.js';
import { createSubscription } from './subscription.js';

export function createSettingsService(): PluginContextV1['settings'] {
    const settingsStore = new Map<string, unknown>();
    const listeners = new Set<PluginSettingsChangeListenerV1>();
    const snapshotSettings = (): Readonly<Record<string, unknown>> => Object.freeze(Object.fromEntries(settingsStore.entries()));

    function readSettings(): Promise<Readonly<Record<string, unknown>>>;
    function readSettings<T = unknown>(key: string): Promise<T | null>;
    async function readSettings<T = unknown>(key?: string): Promise<Readonly<Record<string, unknown>> | T | null> {
        if (typeof key === 'string') {
            return settingsStore.has(key) ? (settingsStore.get(key) as T) ?? null : null;
        }
        return snapshotSettings();
    }
    return {
        get: readSettings,
        async set(key: string, value: unknown) {
            settingsStore.set(key, value);
            const next = snapshotSettings();
            for (const listener of listeners) {
                listener(next);
            }
        },
        onChange(listener: PluginSettingsChangeListenerV1) {
            listeners.add(listener);
            return createSubscription(() => {
                listeners.delete(listener);
            });
        },
        describeFields() {
            return [];
        },
        projectForm(): PluginSettingsFormProjectionV1 {
            return { storageScope: 'pluginLocal', fields: [] };
        },
    };
}

export function createAuthService(): PluginContextV1['auth'] {
    const authIdentity: PluginAuthIdentityV1 | null = null;
    return {
        async getIdentity() {
            return authIdentity;
        },
        onChange() {
            return createSubscription();
        },
        services: {
            async materialize(_request: PluginAuthMaterializeRequestV1): Promise<PluginAuthMaterializedServiceV1 | null> {
                return null;
            },
        },
    };
}

export function createAccountSettingsService(): PluginContextV1['account']['settings'] {
    const accountSettingsStore = new Map<string, unknown>();
    function readAccountSettings(): Promise<AccountSettings>;
    function readAccountSettings(key: string): Promise<unknown>;
    async function readAccountSettings(key?: string): Promise<AccountSettings | unknown> {
        if (typeof key === 'string') return accountSettingsStore.get(key) ?? null;
        return AccountSettingsSchema.parse(Object.fromEntries(accountSettingsStore.entries()));
    }
    return {
        get: readAccountSettings,
        async set(key, value) {
            accountSettingsStore.set(key, value);
        },
        onChange() {
            return createSubscription();
        },
    };
}
