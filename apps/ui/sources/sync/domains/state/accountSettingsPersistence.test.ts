import { beforeEach, describe, expect, it, vi } from 'vitest';

import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';

type AccountSettingsScope = Readonly<{
    serverId: string;
    accountId: string;
}>;

type AccountSettingsPersistenceModule = Readonly<{
    loadAccountSettings: (scope: AccountSettingsScope) => { settings: unknown; version: number | null };
    saveAccountSettings: (scope: AccountSettingsScope, settings: Settings, version: number) => void;
    prepareAccountSettingsScopeForActivation: (scope: AccountSettingsScope) => void;
    loadPendingAccountSettings: (scope: AccountSettingsScope) => Partial<Settings>;
    savePendingAccountSettings: (scope: AccountSettingsScope, settings: Partial<Settings>) => void;
}>;

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return store.get(key);
        }

        set(key: string, value: string) {
            store.set(key, value);
        }

        delete(key: string) {
            store.delete(key);
        }

        clearAll() {
            store.clear();
        }
    }

    return { MMKV };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
        translateLoose: (key: string) => key,
        getPreferredLanguage: () => 'en',
    });
});

async function loadAccountSettingsPersistenceModule(): Promise<AccountSettingsPersistenceModule | null> {
    const loaded: unknown = await import('./accountSettingsPersistence').catch(() => null);
    if (!loaded || typeof loaded !== 'object') return null;
    return loaded as AccountSettingsPersistenceModule;
}

describe('accountSettingsPersistence', () => {
    const scopeA = { serverId: 'server-a', accountId: 'account-a' };
    const sameAccountDifferentServer = { serverId: 'server-b', accountId: 'account-a' };
    const sameServerDifferentAccount = { serverId: 'server-a', accountId: 'account-b' };

    beforeEach(() => {
        store.clear();
    });

    it('persists account settings separately for each server/account scope', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        mod.saveAccountSettings(scopeA, { ...settingsDefaults, analyticsOptOut: true }, 9);
        mod.saveAccountSettings(sameAccountDifferentServer, { ...settingsDefaults, analyticsOptOut: false }, 4);
        mod.saveAccountSettings(sameServerDifferentAccount, { ...settingsDefaults, crashReportsOptOut: true }, 2);

        expect(mod.loadAccountSettings(scopeA)).toMatchObject({
            settings: expect.objectContaining({ analyticsOptOut: true }),
            version: 9,
        });
        expect(mod.loadAccountSettings(sameAccountDifferentServer)).toMatchObject({
            settings: expect.objectContaining({ analyticsOptOut: false }),
            version: 4,
        });
        expect(mod.loadAccountSettings(sameServerDifferentAccount)).toMatchObject({
            settings: expect.objectContaining({ crashReportsOptOut: true }),
            version: 2,
        });
    });

    it('persists pending settings separately for each server/account scope', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        mod.savePendingAccountSettings(scopeA, { analyticsOptOut: true });
        mod.savePendingAccountSettings(sameAccountDifferentServer, { viewInline: true });

        expect(mod.loadPendingAccountSettings(scopeA)).toEqual({ analyticsOptOut: true });
        expect(mod.loadPendingAccountSettings(sameAccountDifferentServer)).toEqual({ viewInline: true });
        expect(mod.loadPendingAccountSettings(sameServerDifferentAccount)).toEqual({});
    });

    it('migrates legacy pending settings into the first activated account scope before deleting the legacy key', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        store.set('pending-settings', JSON.stringify({ analyticsOptOut: true, viewInline: true }));

        mod.prepareAccountSettingsScopeForActivation(scopeA);

        expect(mod.loadPendingAccountSettings(scopeA)).toEqual({ analyticsOptOut: true, viewInline: true });
        expect(store.has('pending-settings')).toBe(false);
    });

    it('keeps existing scoped pending settings when activation sees legacy pending settings', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        mod.savePendingAccountSettings(scopeA, { crashReportsOptOut: true });
        store.set('pending-settings', JSON.stringify({ analyticsOptOut: true }));

        mod.prepareAccountSettingsScopeForActivation(scopeA);

        expect(mod.loadPendingAccountSettings(scopeA)).toEqual({ crashReportsOptOut: true });
        expect(store.has('pending-settings')).toBe(false);
    });

    it('deletes pending settings only for the requested scope', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        mod.savePendingAccountSettings(scopeA, { analyticsOptOut: true });
        mod.savePendingAccountSettings(sameAccountDifferentServer, { viewInline: true });
        mod.savePendingAccountSettings(scopeA, {});

        expect(mod.loadPendingAccountSettings(scopeA)).toEqual({});
        expect(mod.loadPendingAccountSettings(sameAccountDifferentServer)).toEqual({ viewInline: true });
    });

    it('falls back safely when scoped persisted data is malformed', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        mod.saveAccountSettings(scopeA, { ...settingsDefaults, analyticsOptOut: true }, 9);
        for (const key of store.keys()) {
            if (key.includes('account-settings')) {
                store.set(key, '{ not json');
            }
        }

        expect(mod.loadAccountSettings(scopeA)).toEqual({ settings: {}, version: null });
    });
});
