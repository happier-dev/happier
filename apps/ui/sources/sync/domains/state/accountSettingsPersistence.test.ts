import { beforeEach, describe, expect, it, vi } from 'vitest';

import { settingsDefaults, type Settings } from '../settings/settings';
import { accountSettingsScopeKeySuffix } from '../settings/scope/accountSettingsScope';

type AccountSettingsScope = Readonly<{
    serverId: string;
    accountId: string;
}>;

type AccountSettingsPersistenceModule = Readonly<{
    loadAccountSettings: (scope: AccountSettingsScope) => { settings: unknown; version: number | null };
    saveAccountSettings: (scope: AccountSettingsScope, settings: Settings, version: number) => void;
    prepareAccountSettingsScopeForActivation: (scope: AccountSettingsScope, legacyScopes?: readonly AccountSettingsScope[]) => void;
    loadPendingAccountSettings: (scope: AccountSettingsScope) => Partial<Settings>;
    savePendingAccountSettings: (scope: AccountSettingsScope, settings: Partial<Settings>) => void;
    subscribeAccountSettingsPersistenceMutations: (listener: (scope: AccountSettingsScope) => void,
        options?: Readonly<{ scope: AccountSettingsScope; keys: readonly (keyof Settings)[] }>) => () => void;
}>;

const store = vi.hoisted(() => new Map<string, string>());

function accountSettingsStorageKey(scope: AccountSettingsScope): string {
    return `account-settings:v2:${accountSettingsScopeKeySuffix(scope)}`;
}

function pendingAccountSettingsStorageKey(scope: AccountSettingsScope): string {
    return `pending-account-settings:v2:${accountSettingsScopeKeySuffix(scope)}`;
}

/** Simulates a cache written by an older UI that still persisted retired roots. */
function writeLegacyAccountSettingsCache(
    scope: AccountSettingsScope,
    settings: Record<string, unknown>,
    version: number,
): void {
    store.set(accountSettingsStorageKey(scope), JSON.stringify({ settings, version }));
}

/** Simulates an older pending cache; current public writers never receive these roots. */
function writeLegacyPendingAccountSettingsCache(
    scope: AccountSettingsScope,
    settings: Record<string, unknown>,
): void {
    store.set(pendingAccountSettingsStorageKey(scope), JSON.stringify(settings));
}

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

        getAllKeys() {
            return Array.from(store.keys(), (key) => `mmkv.default\\${key}`);
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

    it('retains the theme acknowledgement checkpoint across ordinary pending flushes', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod).not.toBeNull(); if (!mod) return;
        const profile = { schemaVersion: 1, id: 'local_2', name: 'Edited local',
            createdAt: '2026-10-01', updatedAt: '2026-10-01', base: { light: 'light', dark: 'dark' },
            overrides: { light: {}, dark: {} } };
        const checkpoint = { edits: [{ target: { kind: 'legacy', id: 'local' }, profile }],
            legacyProfileIds: { local: 'local_2' }, acknowledged: true };
        writeLegacyPendingAccountSettingsCache(scopeA, { themeProfiles: [profile], __themeProfileMigrationEditsV1: checkpoint });
        mod.savePendingAccountSettings(scopeA, { analyticsOptOut: true });
        const saved = JSON.parse(store.get(pendingAccountSettingsStorageKey(scopeA))!);
        expect(saved).toMatchObject({ analyticsOptOut: true, themeProfiles: [profile], __themeProfileMigrationEditsV1: checkpoint });
        mod.savePendingAccountSettings(scopeA, {});
        expect(JSON.parse(store.get(pendingAccountSettingsStorageKey(scopeA))!)).toMatchObject({ themeProfiles: [profile],
            __themeProfileMigrationEditsV1: checkpoint });
        expect(mod.loadPendingAccountSettings(scopeA)).not.toHaveProperty('__themeProfileMigrationEditsV1');
    });
    it('moves the pending theme acknowledgement with a proven server identity alias', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod).not.toBeNull(); if (!mod) return;
        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const legacyScope = { serverId: 'localhost-18829', accountId: 'account-a' };
        const profile = { schemaVersion: 1, id: 'local_2', name: 'Edited local', createdAt: '2026-10-01', updatedAt: '2026-10-01',
            base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} } };
        const checkpoint = { edits: [{ target: { kind: 'legacy', id: 'local' }, profile }],
            legacyProfileIds: { local: 'local_2' }, acknowledged: true };
        writeLegacyPendingAccountSettingsCache(legacyScope, { themeProfiles: [profile], __themeProfileMigrationEditsV1: checkpoint });
        await mod.prepareAccountSettingsScopeForActivation(identityScope, [legacyScope]);
        expect(JSON.parse(store.get(pendingAccountSettingsStorageKey(identityScope))!)).toMatchObject({ themeProfiles: [profile],
            __themeProfileMigrationEditsV1: checkpoint });
        expect(store.has(pendingAccountSettingsStorageKey(legacyScope))).toBe(false);
        expect(mod.loadPendingAccountSettings(sameServerDifferentAccount)).toEqual({});
    });
    it('recovers scoped pending preferences without giving retired fields mutation meaning', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod).not.toBeNull();
        if (!mod) return;
        writeLegacyPendingAccountSettingsCache(scopeA, {
            machineAdministrationSelectionsV1: {
                v: 1,
                pluginExecutionOriginsByPluginId: {},
                targetsByKey: { plugins: { machineId: 'retired-machine' } },
            },
        });
        expect(mod.loadPendingAccountSettings(scopeA)).toEqual({
            machineAdministrationSelectionsV1: { v: 1, pluginExecutionOriginsByPluginId: {} },
        });
        expect(mod.loadPendingAccountSettings(sameServerDifferentAccount)).toEqual({});
    });

    it('replaces native preview ceilings with the current settings, including an offline privacy change', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod).not.toBeNull();
        if (!mod) return;
        const policy = settingsDefaults.attentionDeliveryPolicyV1;
        const initial = {
            ...settingsDefaults,
            attentionDeliveryPolicyV1: {
                ...policy,
                events: { ...policy.events, ready: { ...policy.events.ready, previewBehavior: 'include_preview' as const } },
            },
        };
        mod.saveAccountSettings(scopeA, initial, 9);
        mod.saveAccountSettings(sameAccountDifferentServer, initial, 9);
        const readNativePolicy = (scope: AccountSettingsScope) => JSON.parse(store.get(accountSettingsStorageKey(scope)) ?? '{}').nativeNotificationPreviews;
        expect(readNativePolicy(scopeA)).toMatchObject({ v: 1, events: { ready: 'include_preview' } });

        // Local edits persist before a Home CAS succeeds, so the version is deliberately unchanged.
        mod.saveAccountSettings(scopeA, {
            ...initial,
            attentionDeliveryPolicyV1: {
                ...initial.attentionDeliveryPolicyV1,
                events: { ...initial.attentionDeliveryPolicyV1.events, ready: { ...policy.events.ready, previewBehavior: 'status_only' } },
            },
        }, 9);
        expect(readNativePolicy(scopeA)).toMatchObject({ v: 1, events: { ready: 'status_only' } });
        expect(readNativePolicy(sameAccountDifferentServer)).toMatchObject({ v: 1, events: { ready: 'include_preview' } });

        // A predecessor replaces the whole envelope; its write cannot retain a permissive projection.
        writeLegacyAccountSettingsCache(scopeA, { ...settingsDefaults }, 10);
        expect(readNativePolicy(scopeA)).toBeUndefined();
    });

    it('invalidates native consumers immediately after an exact Account settings write', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod).not.toBeNull();
        if (!mod) return;
        const mutations: AccountSettingsScope[] = [];
        const unsubscribe = mod.subscribeAccountSettingsPersistenceMutations((scope) => mutations.push(scope));

        mod.saveAccountSettings(scopeA, settingsDefaults, 3);
        unsubscribe();
        mod.saveAccountSettings(sameServerDifferentAccount, settingsDefaults, 4);

        expect(mutations).toEqual([scopeA]);
    });

    it('notifies only for changed persisted content, version or scope', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod).not.toBeNull();
        if (!mod) return;
        mod.saveAccountSettings(scopeA, settingsDefaults, 3);
        const previousBytes = store.get(accountSettingsStorageKey(scopeA));
        const mutations: AccountSettingsScope[] = [];
        const unsubscribe = mod.subscribeAccountSettingsPersistenceMutations((scope) => mutations.push(scope));
        try {
            mod.saveAccountSettings({ ...scopeA }, structuredClone(settingsDefaults), 3);
            const reorderedSettings = Object.fromEntries(Object.entries(structuredClone(settingsDefaults)).reverse()) as Settings;
            mod.saveAccountSettings(scopeA, reorderedSettings, 3);
            expect(mutations).toEqual([]);
            expect(store.get(accountSettingsStorageKey(scopeA))).toBe(previousBytes);

            mod.saveAccountSettings(scopeA, settingsDefaults, 4);
            mod.saveAccountSettings(scopeA, { ...settingsDefaults, analyticsOptOut: true }, 4);
            mod.saveAccountSettings(sameServerDifferentAccount, settingsDefaults, 4);
            expect(mutations).toEqual([scopeA, scopeA, sameServerDifferentAccount]);
        } finally {
            unsubscribe();
        }
    });

    it('publishes keyed demand only for a changed preference on its exact Account', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod).not.toBeNull();
        if (!mod) return;
        const mutations: AccountSettingsScope[] = [];
        const unsubscribe = mod.subscribeAccountSettingsPersistenceMutations(scope => mutations.push(scope), {
            scope: scopeA, keys: ['managedMachineCreationEnabled', 'machineRetentionDefaultsV1'],
        });
        try {
            mod.saveAccountSettings(scopeA, settingsDefaults, 1);
            expect(mutations).toEqual([scopeA]);
            mutations.length = 0;
            for (let version = 2; version <= 33; version++) {
                mod.saveAccountSettings(scopeA, { ...settingsDefaults, analyticsOptOut: version % 2 === 0 }, version);
                mod.saveAccountSettings(sameAccountDifferentServer, settingsDefaults, version);
                mod.saveAccountSettings(sameServerDifferentAccount, settingsDefaults, version);
            }
            expect(mutations).toHaveLength(0);
            const changed = { ...settingsDefaults, managedMachineCreationEnabled: !settingsDefaults.managedMachineCreationEnabled };
            mod.saveAccountSettings(scopeA, changed, 34);
            expect(mutations).toEqual([scopeA]);
            mod.saveAccountSettings(scopeA, structuredClone(changed), 35);
            expect(mutations).toHaveLength(1);
            const retained: Settings = { ...changed, machineRetentionDefaultsV1: { v: 1, local: {
                retention: { kind: 'unused', afterMs: 17_500, effect: 'stop' }, wakeOnAcceptedMessage: true,
            } } };
            mod.saveAccountSettings(scopeA, retained, 36);
            expect(mutations).toHaveLength(2);
            mod.saveAccountSettings(scopeA, structuredClone(retained), 37);
            expect(mutations).toHaveLength(2);
        } finally { unsubscribe(); }
        mod.saveAccountSettings(scopeA, settingsDefaults, 38);
        expect(mutations).toHaveLength(2);
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

    it('seeds Home selection once and ignores later stale scoped selection saves across restart', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        writeLegacyAccountSettingsCache(scopeA, {
            ...settingsDefaults,
            serverSelectionGroups: [{ id: 'focused', name: 'Focused', serverIds: ['server-a', 'server-b'] }],
            serverSelectionActiveTargetKind: 'group',
            serverSelectionActiveTargetId: 'focused',
        }, 1);
        mod.prepareAccountSettingsScopeForActivation(scopeA);

        mod.saveAccountSettings(sameAccountDifferentServer, {
            ...settingsDefaults,
            serverSelectionGroups: [{ id: 'stale', name: 'Stale', serverIds: ['server-b'], presentation: 'grouped' }],
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: 'server-b',
        }, 2);

        vi.resetModules();
        const restarted = await loadAccountSettingsPersistenceModule();
        expect(restarted, 'account settings persistence module should survive restart').not.toBeNull();
        if (!restarted) return;
        expect(restarted.loadAccountSettings(sameAccountDifferentServer).settings).toMatchObject({
            serverSelectionGroups: [{ id: 'focused', name: 'Focused', serverIds: ['server-a', 'server-b'] }],
            serverSelectionActiveTargetKind: 'group',
            serverSelectionActiveTargetId: 'focused',
        });

        const staleEnvelope = JSON.parse(store.get(accountSettingsStorageKey(sameAccountDifferentServer)) ?? '{}') as {
            settings?: Record<string, unknown>;
        };
        expect(staleEnvelope.settings).not.toHaveProperty('serverSelectionGroups');
        expect(staleEnvelope.settings).not.toHaveProperty('serverSelectionActiveTargetKind');
        expect(staleEnvelope.settings).not.toHaveProperty('serverSelectionActiveTargetId');
    });

    it('does not mirror device-global Home selection into legacy settings persistence', async () => {
        const { saveHomeViewState } = await import('../server/serverProfiles');
        const { loadSettings, saveSettings } = await import('./settingsPersistence');
        await saveHomeViewState({
            version: 1,
            groups: [{ id: 'global', name: 'Global', serverIds: ['server-a'] }],
            activeTargetKind: 'server',
            activeTargetId: 'server-a',
        });

        saveSettings({
            ...settingsDefaults,
            serverSelectionGroups: [{ id: 'stale', name: 'Stale', serverIds: ['server-b'], presentation: 'grouped' }],
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: 'server-b',
        }, 3);

        const persisted = loadSettings().settings as Record<string, unknown>;
        expect(persisted).not.toHaveProperty('serverSelectionGroups');
        expect(persisted).not.toHaveProperty('serverSelectionActiveTargetKind');
        expect(persisted).not.toHaveProperty('serverSelectionActiveTargetId');
    });

    it('typed-refuses raw secret-string values without changing cached or pending account settings', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const rawSecret = 'must-never-reach-device-settings-storage';
        const secret = {
            id: 'secret-a',
            name: 'Secret A',
            kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, value: rawSecret },
            createdAt: 1,
            updatedAt: 1,
        };
        mod.saveAccountSettings(scopeA, { ...settingsDefaults, analyticsOptOut: true }, 1);
        mod.savePendingAccountSettings(scopeA, { crashReportsOptOut: true });
        const before = new Map(store);

        expect(() => mod.saveAccountSettings(scopeA, {
            ...settingsDefaults,
            secrets: [secret],
        } as Settings, 2)).toThrow(expect.objectContaining({
            code: 'local_secret_unavailable',
        }));
        expect(() => mod.savePendingAccountSettings(scopeA, {
            secrets: [secret],
        } as Partial<Settings>)).toThrow(expect.objectContaining({
            code: 'local_secret_unavailable',
        }));

        expect(store).toEqual(before);
        expect([...store.values()].join('\n')).not.toContain(rawSecret);
    });

    it('typed-refuses hydration from a legacy persisted snapshot containing a raw secret', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        mod.saveAccountSettings(scopeA, { ...settingsDefaults, analyticsOptOut: true }, 1);
        const accountSettingsKey = [...store.keys()].find((key) => key.includes('account-settings:v2:'));
        expect(accountSettingsKey).toBeTypeOf('string');
        if (!accountSettingsKey) return;
        store.set(accountSettingsKey, JSON.stringify({
            version: 2,
            settings: {
                secrets: [{
                    id: 'secret-a',
                    name: 'Secret A',
                    kind: 'apiKey',
                    encryptedValue: {
                        _isSecretValue: true,
                        value: 'legacy-raw-secret',
                    },
                    createdAt: 1,
                    updatedAt: 1,
                }],
            },
        }));

        expect(() => mod.loadAccountSettings(scopeA)).toThrow(expect.objectContaining({
            code: 'local_secret_unavailable',
        }));
    });

    it('preserves already device-sealed secret values through persistence hydration', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const sealedSecret = {
            id: 'secret-sealed',
            name: 'Sealed secret',
            kind: 'apiKey',
            encryptedValue: {
                _isSecretValue: true,
                encryptedValue: {
                    t: 'enc-v1',
                    c: 'opaque-device-ciphertext',
                },
            },
            createdAt: 1,
            updatedAt: 1,
        };
        mod.saveAccountSettings(scopeA, {
            ...settingsDefaults,
            secrets: [sealedSecret],
        } as Settings, 3);

        expect(mod.loadAccountSettings(scopeA)).toMatchObject({
            version: 3,
            settings: {
                secrets: [sealedSecret],
            },
        });
    });

    it('strips migrated session organization fields from account settings persistence', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        mod.saveAccountSettings(scopeA, {
            ...settingsDefaults,
            analyticsOptOut: true,
            pinnedSessionKeysV1: ['server-a:s1'],
            workspaceLabelsV1: { workspaceA: 'Workspace A' },
            sessionTagsV1: { 'server-a:s1': ['urgent'] },
            sessionListGroupOrderV1: { groupA: ['server-a:s1'] },
            sessionWorkspaceOrderV1: { workspaceA: ['workspace:item'] },
            sessionFoldersV1: {
                v: 1,
                folders: [{
                    id: 'folder-a',
                    workspace: {
                        t: 'workspaceScope',
                        serverId: 'server-a',
                        machineId: 'machine-a',
                        rootPath: '/repo',
                    },
                    parentId: null,
                    name: 'Folder A',
                    createdAt: 1,
                    updatedAt: 1,
                }],
            },
            collapsedGroupKeysV1: { groupA: true },
        } as Settings, 3);
        mod.savePendingAccountSettings(scopeA, {
            crashReportsOptOut: true,
            pinnedSessionKeysV1: ['server-a:s2'],
            sessionTagsV1: { 'server-a:s2': ['later'] },
        } as Partial<Settings>);

        expect(mod.loadAccountSettings(scopeA)).toEqual({
            version: 3,
            settings: expect.objectContaining({
                analyticsOptOut: true,
            }),
        });
        expect(mod.loadAccountSettings(scopeA).settings).not.toMatchObject({
            pinnedSessionKeysV1: expect.anything(),
            workspaceLabelsV1: expect.anything(),
            collapsedGroupKeysV1: expect.anything(),
            sessionTagsV1: expect.anything(),
            sessionListGroupOrderV1: expect.anything(),
            sessionWorkspaceOrderV1: expect.anything(),
            sessionFoldersV1: expect.anything(),
        });
        expect(mod.loadPendingAccountSettings(scopeA)).toEqual({ crashReportsOptOut: true });
    });

    it('persists pending settings separately for each server/account scope', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        mod.savePendingAccountSettings(scopeA, { analyticsOptOut: true });
        mod.savePendingAccountSettings(sameAccountDifferentServer, { showLineNumbers: true });

        expect(mod.loadPendingAccountSettings(scopeA)).toEqual({ analyticsOptOut: true });
        expect(mod.loadPendingAccountSettings(sameAccountDifferentServer)).toEqual({ showLineNumbers: true });
        expect(mod.loadPendingAccountSettings(sameServerDifferentAccount)).toEqual({});
    });

    it('migrates legacy pending settings into the first activated account scope before deleting the legacy key', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        store.set('pending-settings', JSON.stringify({ analyticsOptOut: true, showLineNumbers: true }));

        mod.prepareAccountSettingsScopeForActivation(scopeA);

        expect(mod.loadPendingAccountSettings(scopeA)).toEqual({ analyticsOptOut: true, showLineNumbers: true });
        expect(store.has('pending-settings')).toBe(false);
    });

    it('ignores obsolete local keyboard shortcut preferences during account scope activation', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        store.set('local-settings', JSON.stringify({
            commandPaletteEnabled: true,
            keyboardShortcutsV2Enabled: true,
            keyboardSingleKeyShortcutsEnabled: true,
            keyboardShortcutDisabledCommandIdsV1: ['session.new', '', 42],
            keyboardShortcutOverridesV1: {
                'commandPalette.open': [{ binding: 'Alt+K' }],
                'bad.command': [{ binding: '' }],
            },
            sessionMruOrderV1: ['server-a:session-a'],
        }));

        mod.prepareAccountSettingsScopeForActivation(scopeA);

        expect(mod.loadAccountSettings(scopeA)).toEqual({ settings: {}, version: null });
        expect(mod.loadPendingAccountSettings(scopeA)).toEqual({});
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

    it('absorbs host-derived legacy pending deltas into an identity scope without baking server-backed settings', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const legacyScope = { serverId: 'localhost-18829', accountId: 'account-a' };

        mod.saveAccountSettings(legacyScope, {
            ...settingsDefaults,
            analyticsOptOut: true,
            lastUsedAgent: 'codex',
        }, 17);
        mod.savePendingAccountSettings(legacyScope, { crashReportsOptOut: true });

        mod.prepareAccountSettingsScopeForActivation(identityScope, [legacyScope]);

        expect(mod.loadPendingAccountSettings(identityScope)).toEqual({ crashReportsOptOut: true });
        expect(mod.loadPendingAccountSettings(legacyScope)).toEqual({});
        expect(mod.loadAccountSettings(identityScope)).toMatchObject({
            version: null,
        });
        // newSessionTargetUiState.ts:87–114 owns observation import and scope adoption.
        const { readLastUsedBackendSelection } = await import('./newSessionTargetUiState');
        expect(readLastUsedBackendSelection(identityScope).lastUsedAgent).toBe('codex');
        expect(mod.loadAccountSettings(identityScope).settings).not.toHaveProperty('lastUsedAgent');
        expect(mod.loadAccountSettings(identityScope).settings).not.toMatchObject({
            analyticsOptOut: true,
        });

        mod.prepareAccountSettingsScopeForActivation(identityScope, [legacyScope]);
        expect(mod.loadPendingAccountSettings(identityScope)).toEqual({ crashReportsOptOut: true });
    });

    it('drops host-derived pending migrated organization collections during identity scope activation', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const legacyScope = { serverId: 'localhost-18829', accountId: 'account-a' };

        writeLegacyPendingAccountSettingsCache(identityScope, {
            pinnedSessionKeysV1: ['s1:canonical'],
            sessionListGroupOrderV1: {
                'folder:shared': ['s1:canonical'],
                'folder:canonical': ['s1:canonical-only'],
            },
        });
        writeLegacyPendingAccountSettingsCache(legacyScope, {
            pinnedSessionKeysV1: ['s1:legacy', 's1:canonical'],
            sessionListGroupOrderV1: {
                'folder:shared': ['s1:legacy'],
                'folder:legacy': ['s1:legacy-only'],
            },
        });

        mod.prepareAccountSettingsScopeForActivation(identityScope, [legacyScope]);

        expect(mod.loadPendingAccountSettings(identityScope)).toEqual({});
        expect(mod.loadPendingAccountSettings(legacyScope)).toEqual({});
    });

    it('does not replay migrated organization fields into identity pending or visible settings', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const legacyScope = { serverId: 'localhost-18829', accountId: 'account-a' };

        writeLegacyAccountSettingsCache(identityScope, {
            ...settingsDefaults,
            pinnedSessionKeysV1: ['identity-session'],
            workspaceLabelsV1: {
                shared: 'Identity label',
                identityOnly: 'Identity only',
            },
            collapsedGroupKeysV1: {
                shared: false,
                identityOnly: true,
            },
            sessionTagsV1: {
                sharedSession: ['identity-tag'],
                identitySession: ['identity-only'],
            },
            sessionListGroupOrderV1: {
                sharedGroup: ['identity-session'],
                identityGroup: ['identity-session'],
            },
        }, 22);
        writeLegacyAccountSettingsCache(legacyScope, {
            ...settingsDefaults,
            analyticsOptOut: true,
            pinnedSessionKeysV1: ['legacy-session', 'identity-session'],
            workspaceLabelsV1: {
                shared: 'Legacy label',
                legacyOnly: 'Legacy only',
            },
            collapsedGroupKeysV1: {
                shared: true,
                legacyOnly: true,
            },
            sessionTagsV1: {
                sharedSession: ['legacy-tag'],
                legacySession: ['legacy-only'],
            },
            sessionListGroupOrderV1: {
                sharedGroup: ['legacy-session'],
                legacyGroup: ['legacy-session'],
            },
        }, 17);

        mod.prepareAccountSettingsScopeForActivation(identityScope, [legacyScope]);

        expect(mod.loadPendingAccountSettings(identityScope)).toEqual({});
        expect(mod.loadPendingAccountSettings(identityScope)).not.toMatchObject({
            analyticsOptOut: true,
        });
        expect(mod.loadAccountSettings(identityScope)).toMatchObject({
            version: 22,
            settings: expect.objectContaining({}),
        });
        expect(mod.loadAccountSettings(identityScope).settings).not.toMatchObject({
            pinnedSessionKeysV1: expect.anything(),
            workspaceLabelsV1: expect.anything(),
            collapsedGroupKeysV1: expect.anything(),
            sessionTagsV1: expect.anything(),
            sessionListGroupOrderV1: expect.anything(),
        });

        mod.prepareAccountSettingsScopeForActivation(identityScope, [legacyScope]);
        expect(mod.loadPendingAccountSettings(identityScope)).toEqual({});
    });

    it('does not resurrect legacy cached session presentation after the identity scope removes it', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const legacyScope = { serverId: 'localhost-18829', accountId: 'account-a' };

        writeLegacyAccountSettingsCache(legacyScope, {
            ...settingsDefaults,
            pinnedSessionKeysV1: ['localhost-18829:session-a'],
            sessionTagsV1: {
                'localhost-18829:session-a': ['legacy-tag'],
            },
            sessionListGroupOrderV1: {
                'server:localhost-18829:active:project:p1': ['localhost-18829:session-a'],
            },
        }, 17);

        mod.prepareAccountSettingsScopeForActivation(identityScope, [legacyScope]);

        expect(mod.loadPendingAccountSettings(identityScope)).toEqual({});

        mod.savePendingAccountSettings(identityScope, {});
        writeLegacyAccountSettingsCache(identityScope, {
            ...settingsDefaults,
            pinnedSessionKeysV1: [],
            sessionTagsV1: {},
            sessionListGroupOrderV1: {},
        }, 23);

        mod.prepareAccountSettingsScopeForActivation(identityScope, [legacyScope]);

        expect(mod.loadPendingAccountSettings(identityScope)).toEqual({});
        expect(mod.loadAccountSettings(identityScope).settings).not.toMatchObject({
            pinnedSessionKeysV1: expect.anything(),
            sessionTagsV1: expect.anything(),
            sessionListGroupOrderV1: expect.anything(),
        });
    });

    it('does not replay a changed legacy cached envelope after that legacy cache was consumed', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const legacyScope = { serverId: 'localhost-18829', accountId: 'account-a' };

        writeLegacyAccountSettingsCache(legacyScope, {
            ...settingsDefaults,
            pinnedSessionKeysV1: ['localhost-18829:session-a'],
        }, 17);
        mod.prepareAccountSettingsScopeForActivation(identityScope, [legacyScope]);

        mod.savePendingAccountSettings(identityScope, {});
        writeLegacyAccountSettingsCache(identityScope, {
            ...settingsDefaults,
            pinnedSessionKeysV1: [],
            workspaceLabelsV1: {
                workspaceA: 'Canonical label',
            },
        }, 23);
        writeLegacyAccountSettingsCache(legacyScope, {
            ...settingsDefaults,
            pinnedSessionKeysV1: ['localhost-18829:session-a'],
            workspaceLabelsV1: {
                workspaceB: 'Late legacy label',
            },
        }, 18);

        mod.prepareAccountSettingsScopeForActivation(identityScope, [legacyScope]);

        expect(mod.loadPendingAccountSettings(identityScope)).toEqual({});
        expect(mod.loadAccountSettings(identityScope).settings).not.toMatchObject({
            pinnedSessionKeysV1: expect.anything(),
            workspaceLabelsV1: expect.anything(),
        });
    });

    it('rewrites nested legacy server ids in migrated session presentation settings', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const localhostScope = { serverId: 'localhost-52753', accountId: 'account-a' };
        const lanScope = { serverId: '192.168.1.115-52753', accountId: 'account-a' };
        const otherAccountScope = { serverId: 'other-server', accountId: 'account-b' };

        writeLegacyAccountSettingsCache(identityScope, {
            ...settingsDefaults,
            pinnedSessionKeysV1: ['srv_identity:session-existing'],
            sessionTagsV1: {
                'srv_identity:session-existing': ['identity-tag'],
            },
            sessionListGroupOrderV1: {
                'server:srv_identity:active:project:p1': ['srv_identity:session-existing'],
            },
            sessionWorkspaceOrderV1: {
                'server:srv_identity:workspaces': ['workspace:identity'],
            },
            serverSelectionGroups: [{
                id: 'group-a',
                name: 'Group A',
                serverIds: ['srv_identity'],
                presentation: 'grouped',
            }],
        }, 22);
        writeLegacyAccountSettingsCache(localhostScope, {
            ...settingsDefaults,
            pinnedSessionKeysV1: ['localhost-52753:session-localhost', 'srv_identity:session-existing'],
            sessionTagsV1: {
                'localhost-52753:session-localhost': ['localhost-tag'],
                'srv_identity:session-existing': ['legacy-identity-tag'],
            },
            sessionListGroupOrderV1: {
                'server:localhost-52753:active:project:p1': ['localhost-52753:session-localhost'],
                'pinned-v1': ['localhost-52753:session-localhost'],
            },
            sessionWorkspaceOrderV1: {
                'server:localhost-52753:workspaces': ['workspace:localhost'],
            },
            sessionFoldersV1: {
                v: 1,
                folders: [{
                    id: 'localhost-folder',
                    workspace: {
                        t: 'workspaceRef',
                        serverId: 'localhost-52753',
                        workspaceRefId: 'workspace-localhost',
                    },
                    parentId: null,
                    name: 'Localhost',
                    createdAt: 1,
                    updatedAt: 1,
                }],
            },
            serverSelectionGroups: [{
                id: 'group-a',
                name: 'Group A',
                serverIds: ['localhost-52753', 'srv_identity'],
                presentation: 'grouped',
            }],
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: 'localhost-52753',
        }, 17);
        writeLegacyPendingAccountSettingsCache(lanScope, {
            pinnedSessionKeysV1: ['192.168.1.115-52753:session-lan'],
            sessionTagsV1: {
                '192.168.1.115-52753:session-lan': ['lan-tag'],
            },
            serverSelectionGroups: [{
                id: 'group-b',
                name: 'Group B',
                serverIds: ['192.168.1.115-52753', 'unrelated-server'],
                presentation: 'grouped',
            }],
        });
        writeLegacyPendingAccountSettingsCache(otherAccountScope, {
            pinnedSessionKeysV1: ['other-server:session-other'],
        });

        mod.prepareAccountSettingsScopeForActivation(identityScope, [localhostScope, lanScope]);

        expect(mod.loadPendingAccountSettings(identityScope)).toEqual({});
        expect(mod.loadPendingAccountSettings(identityScope)).not.toHaveProperty('serverSelectionGroups');
        expect(mod.loadPendingAccountSettings(identityScope)).not.toHaveProperty('serverSelectionActiveTargetKind');
        expect(mod.loadPendingAccountSettings(identityScope)).not.toHaveProperty('serverSelectionActiveTargetId');
        expect(mod.loadPendingAccountSettings(otherAccountScope)).toEqual({});
        const identitySettings = mod.loadAccountSettings(identityScope).settings as Settings;
        expect(identitySettings.serverSelectionGroups).toEqual([
            expect.objectContaining({
                id: 'group-b',
                serverIds: ['srv_identity', 'unrelated-server'],
            }),
            expect.objectContaining({
                id: 'group-a',
                serverIds: ['srv_identity'],
            }),
        ]);
        expect(identitySettings).toMatchObject({
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: 'srv_identity',
        });
    });

    it('rewrites payload-discovered nested server ids in the identity cache without explicit legacy scopes', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        writeLegacyAccountSettingsCache(identityScope, {
            ...settingsDefaults,
            pinnedSessionKeysV1: ['127.0.0.1-52753:session-a'],
            sessionTagsV1: {
                '127.0.0.1-52753:session-a': ['local-tag'],
            },
            serverSelectionGroups: [{
                id: 'group-a',
                name: 'Group A',
                serverIds: ['127.0.0.1-52753'],
                presentation: 'grouped',
            }],
        }, 9);

        mod.prepareAccountSettingsScopeForActivation(identityScope);

        expect(mod.loadAccountSettings(identityScope).settings).toMatchObject({
            serverSelectionGroups: [{
                id: 'group-a',
                name: 'Group A',
                serverIds: ['127.0.0.1-52753'],
                presentation: 'grouped',
            }],
        });
        expect(mod.loadAccountSettings(identityScope).settings).not.toMatchObject({
            pinnedSessionKeysV1: expect.anything(),
            sessionTagsV1: expect.anything(),
        });
        expect(mod.loadPendingAccountSettings(identityScope)).toEqual({});
        expect(mod.loadPendingAccountSettings(identityScope)).not.toHaveProperty('serverSelectionGroups');
    });

    it('migrates legacy cached local-only server selection fields into the identity cache only', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const legacyScope = { serverId: 'localhost-52753', accountId: 'account-a' };
        mod.saveAccountSettings(legacyScope, {
            ...settingsDefaults,
            serverSelectionGroups: [{
                id: 'group-a',
                name: 'Group A',
                serverIds: ['localhost-52753'],
                presentation: 'grouped',
            }],
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: 'localhost-52753',
        }, 3);

        mod.prepareAccountSettingsScopeForActivation(identityScope, [legacyScope]);

        expect(mod.loadAccountSettings(identityScope).settings).toMatchObject({
            serverSelectionGroups: [{
                id: 'group-a',
                name: 'Group A',
                serverIds: ['srv_identity'],
                presentation: 'grouped',
            }],
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: 'srv_identity',
        });
        expect(mod.loadPendingAccountSettings(identityScope)).not.toHaveProperty('serverSelectionGroups');
        expect(mod.loadPendingAccountSettings(identityScope)).not.toHaveProperty('serverSelectionActiveTargetId');
    });

    it('deduplicates migrated legacy session folders by folder id while preserving legacy-only folders', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const legacyScope = { serverId: 'localhost-18829', accountId: 'account-a' };
        const workspace = {
            t: 'workspaceRef' as const,
            serverId: 'srv_identity',
            workspaceRefId: 'workspace-a',
        };

        writeLegacyPendingAccountSettingsCache(identityScope, {
            sessionFoldersV1: {
                v: 1,
                folders: [
                    {
                        id: 'shared-folder',
                        workspace,
                        parentId: null,
                        name: 'Identity name',
                        createdAt: 10,
                        updatedAt: 30,
                    },
                    {
                        id: 'identity-only-folder',
                        workspace,
                        parentId: null,
                        name: 'Identity only',
                        createdAt: 20,
                        updatedAt: 20,
                    },
                ],
            },
            sessionWorkspaceOrderV1: {
                workspaceA: ['identity-session'],
            },
        });
        writeLegacyPendingAccountSettingsCache(legacyScope, {
            sessionFoldersV1: {
                v: 1,
                folders: [
                    {
                        id: 'shared-folder',
                        workspace,
                        parentId: null,
                        name: 'Legacy name',
                        createdAt: 10,
                        updatedAt: 15,
                    },
                    {
                        id: 'legacy-only-folder',
                        workspace,
                        parentId: 'shared-folder',
                        name: 'Legacy only',
                        createdAt: 25,
                        updatedAt: 25,
                    },
                ],
            },
            sessionWorkspaceOrderV1: {
                workspaceA: ['legacy-session'],
                workspaceLegacy: ['legacy-only-session'],
            },
        });

        mod.prepareAccountSettingsScopeForActivation(identityScope, [legacyScope]);

        expect(mod.loadPendingAccountSettings(identityScope)).toEqual({});
        expect(mod.loadPendingAccountSettings(legacyScope)).toEqual({});
    });

    it('absorbs a later-discovered legacy sparse pending scope without dropping identity pending settings', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const lateLegacyScope = { serverId: 'public-host-18829', accountId: 'account-a' };

        writeLegacyPendingAccountSettingsCache(identityScope, {
            pinnedSessionKeysV1: ['first-legacy-session'],
            sessionTagsV1: {
                firstLegacySession: ['first-tag'],
            },
        });
        writeLegacyAccountSettingsCache(lateLegacyScope, {
            ...settingsDefaults,
            analyticsOptOut: true,
            pinnedSessionKeysV1: ['late-cached-session'],
        }, 8);
        writeLegacyPendingAccountSettingsCache(lateLegacyScope, {
            workspaceLabelsV1: {
                lateWorkspace: 'Late workspace',
            },
        });

        mod.prepareAccountSettingsScopeForActivation(identityScope, [lateLegacyScope]);

        expect(mod.loadPendingAccountSettings(identityScope)).toEqual({});
        expect(mod.loadPendingAccountSettings(identityScope)).not.toMatchObject({
            analyticsOptOut: true,
        });
        expect(mod.loadPendingAccountSettings(lateLegacyScope)).toEqual({});
    });

    it('absorbs a legacy cached scope that appears after an earlier empty migration check', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const lateLegacyScope = { serverId: 'public-host-18829', accountId: 'account-a' };

        mod.prepareAccountSettingsScopeForActivation(identityScope, [lateLegacyScope]);

        writeLegacyAccountSettingsCache(lateLegacyScope, {
            ...settingsDefaults,
            pinnedSessionKeysV1: ['public-host-18829:late-session'],
            sessionTagsV1: {
                'public-host-18829:late-session': ['late-tag'],
            },
        }, 8);

        mod.prepareAccountSettingsScopeForActivation(identityScope, [lateLegacyScope]);

        expect(mod.loadPendingAccountSettings(identityScope)).toEqual({});
    });

    it('does not merge unproven same-account host scopes into an identity scope', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const orphanedHostScope = { serverId: 'lan-host-18829', accountId: 'account-a' };
        const otherAccountScope = { serverId: 'lan-host-18829', accountId: 'account-b' };

        writeLegacyAccountSettingsCache(orphanedHostScope, {
            ...settingsDefaults,
            pinnedSessionKeysV1: ['orphaned-session'],
            sessionTagsV1: {
                orphanedSession: ['orphaned-tag'],
            },
        }, 12);
        writeLegacyPendingAccountSettingsCache(orphanedHostScope, {
            workspaceLabelsV1: {
                orphanedWorkspace: 'Orphaned workspace',
            },
        });
        writeLegacyPendingAccountSettingsCache(otherAccountScope, {
            pinnedSessionKeysV1: ['other-account-session'],
        });

        mod.prepareAccountSettingsScopeForActivation(identityScope);

        expect(mod.loadPendingAccountSettings(identityScope)).toEqual({});
        expect(mod.loadAccountSettings(identityScope)).toEqual({
            version: null,
            settings: {},
        });
        expect(mod.loadPendingAccountSettings(orphanedHostScope)).toEqual({});
        expect(mod.loadPendingAccountSettings(otherAccountScope)).toEqual({});
    });

    it('does not discover same-account host scopes when activating a host-derived fallback scope', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const hostScope = { serverId: 'localhost-18829', accountId: 'account-a' };
        const unrelatedHostScope = { serverId: 'staging-18829', accountId: 'account-a' };

        writeLegacyPendingAccountSettingsCache(unrelatedHostScope, {
            pinnedSessionKeysV1: ['staging-18829:session-staging'],
            workspaceLabelsV1: {
                stagingWorkspace: 'Staging workspace',
            },
        });

        mod.prepareAccountSettingsScopeForActivation(hostScope);

        expect(mod.loadPendingAccountSettings(hostScope)).toEqual({});
        expect(mod.loadPendingAccountSettings(unrelatedHostScope)).toEqual({});
    });

    it('deletes pending settings only for the requested scope', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        mod.savePendingAccountSettings(scopeA, { analyticsOptOut: true });
        mod.savePendingAccountSettings(sameAccountDifferentServer, { showLineNumbers: true });
        mod.savePendingAccountSettings(scopeA, {});

        expect(mod.loadPendingAccountSettings(scopeA)).toEqual({});
        expect(mod.loadPendingAccountSettings(sameAccountDifferentServer)).toEqual({ showLineNumbers: true });
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
