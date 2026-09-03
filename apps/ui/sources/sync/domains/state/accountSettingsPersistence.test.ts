import { beforeEach, describe, expect, it, vi } from 'vitest';

import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';

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

    it('keeps the guidance default absent from pending deltas and persists an explicit opt-out', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        mod.savePendingAccountSettings(scopeA, {});
        expect(mod.loadPendingAccountSettings(scopeA)).toEqual({});

        mod.savePendingAccountSettings(scopeA, { executionRunsGuidanceEnabled: false });
        expect(mod.loadPendingAccountSettings(scopeA)).toEqual({ executionRunsGuidanceEnabled: false });
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
            settings: expect.objectContaining({
                lastUsedAgent: 'codex',
            }),
        });
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

        mod.savePendingAccountSettings(identityScope, {
            pinnedSessionKeysV1: ['s1:canonical'],
            sessionListGroupOrderV1: {
                'folder:shared': ['s1:canonical'],
                'folder:canonical': ['s1:canonical-only'],
            },
        });
        mod.savePendingAccountSettings(legacyScope, {
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

    it('does not replay migrated session organization fields into active account pending or cached settings', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const legacyScope = { serverId: 'localhost-18829', accountId: 'account-a' };

        mod.saveAccountSettings(identityScope, {
            ...settingsDefaults,
            pinnedSessionKeysV1: ['srv_identity:identity-session'],
        } as Settings, 22);
        mod.saveAccountSettings(legacyScope, {
            ...settingsDefaults,
            pinnedSessionKeysV1: ['localhost-18829:legacy-session'],
            sessionTagsV1: {
                'localhost-18829:legacy-session': ['legacy-tag'],
            },
            sessionListGroupOrderV1: {
                'pinned-v1': ['localhost-18829:legacy-session'],
            },
            workspaceLabelsV1: {
                legacyWorkspace: 'Legacy workspace',
            },
        } as Settings, 17);
        mod.savePendingAccountSettings(legacyScope, {
            sessionFoldersV1: {
                v: 1,
                folders: [],
            },
            sessionWorkspaceOrderV1: {
                'server:localhost-18829:workspaces': ['workspace:legacy'],
            },
        } as Partial<Settings>);

        mod.prepareAccountSettingsScopeForActivation(identityScope, [legacyScope]);

        expect(mod.loadPendingAccountSettings(identityScope)).toEqual({});
        expect(mod.loadPendingAccountSettings(legacyScope)).toEqual({});
        const identitySettings = mod.loadAccountSettings(identityScope).settings as Record<string, unknown>;
        expect(identitySettings).not.toHaveProperty('pinnedSessionKeysV1');
        expect(identitySettings).not.toHaveProperty('sessionTagsV1');
        expect(identitySettings).not.toHaveProperty('sessionListGroupOrderV1');
        expect(identitySettings).not.toHaveProperty('sessionWorkspaceOrderV1');
        expect(identitySettings).not.toHaveProperty('sessionFoldersV1');
        expect(identitySettings).not.toHaveProperty('workspaceLabelsV1');
    });

    it('does not replay non-default legacy cached organization settings into identity pending or visible settings', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const legacyScope = { serverId: 'localhost-18829', accountId: 'account-a' };

        mod.saveAccountSettings(identityScope, {
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
        mod.saveAccountSettings(legacyScope, {
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
        const identitySettings = mod.loadAccountSettings(identityScope).settings as Record<string, unknown>;
        expect(identitySettings).not.toHaveProperty('pinnedSessionKeysV1');
        expect(identitySettings).not.toHaveProperty('workspaceLabelsV1');
        expect(identitySettings).not.toHaveProperty('collapsedGroupKeysV1');
        expect(identitySettings).not.toHaveProperty('sessionTagsV1');
        expect(identitySettings).not.toHaveProperty('sessionListGroupOrderV1');

        mod.prepareAccountSettingsScopeForActivation(identityScope, [legacyScope]);
        expect(mod.loadPendingAccountSettings(identityScope)).toEqual({});
    });

    it('does not resurrect legacy cached organization settings after the identity scope removes them', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const legacyScope = { serverId: 'localhost-18829', accountId: 'account-a' };

        mod.saveAccountSettings(legacyScope, {
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
        mod.saveAccountSettings(identityScope, {
            ...settingsDefaults,
            pinnedSessionKeysV1: [],
            sessionTagsV1: {},
            sessionListGroupOrderV1: {},
        }, 23);

        mod.prepareAccountSettingsScopeForActivation(identityScope, [legacyScope]);

        expect(mod.loadPendingAccountSettings(identityScope)).toEqual({});
        const identitySettings = mod.loadAccountSettings(identityScope).settings as Record<string, unknown>;
        expect(identitySettings).not.toHaveProperty('pinnedSessionKeysV1');
        expect(identitySettings).not.toHaveProperty('sessionTagsV1');
        expect(identitySettings).not.toHaveProperty('sessionListGroupOrderV1');
    });

    it('does not replay a changed legacy cached envelope after that legacy cache was consumed', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const legacyScope = { serverId: 'localhost-18829', accountId: 'account-a' };

        mod.saveAccountSettings(legacyScope, {
            ...settingsDefaults,
            pinnedSessionKeysV1: ['localhost-18829:session-a'],
        }, 17);
        mod.prepareAccountSettingsScopeForActivation(identityScope, [legacyScope]);

        mod.savePendingAccountSettings(identityScope, {});
        mod.saveAccountSettings(identityScope, {
            ...settingsDefaults,
            pinnedSessionKeysV1: [],
            workspaceLabelsV1: {
                workspaceA: 'Canonical label',
            },
        }, 23);
        mod.saveAccountSettings(legacyScope, {
            ...settingsDefaults,
            pinnedSessionKeysV1: ['localhost-18829:session-a'],
            workspaceLabelsV1: {
                workspaceB: 'Late legacy label',
            },
        }, 18);

        mod.prepareAccountSettingsScopeForActivation(identityScope, [legacyScope]);

        expect(mod.loadPendingAccountSettings(identityScope)).toEqual({});
        const identitySettings = mod.loadAccountSettings(identityScope).settings as Record<string, unknown>;
        expect(identitySettings).not.toHaveProperty('pinnedSessionKeysV1');
        expect(identitySettings).not.toHaveProperty('workspaceLabelsV1');
    });

    it('keeps server-selection migration while dropping nested migrated organization settings', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const localhostScope = { serverId: 'localhost-52753', accountId: 'account-a' };
        const lanScope = { serverId: '192.168.1.115-52753', accountId: 'account-a' };
        const otherAccountScope = { serverId: 'other-server', accountId: 'account-b' };

        mod.saveAccountSettings(identityScope, {
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
        mod.saveAccountSettings(localhostScope, {
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
        mod.savePendingAccountSettings(lanScope, {
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
        mod.savePendingAccountSettings(otherAccountScope, {
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
        mod.saveAccountSettings(identityScope, {
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

        const identitySettings = mod.loadAccountSettings(identityScope).settings as Record<string, unknown>;
        expect(identitySettings).toMatchObject({
            serverSelectionGroups: [{
                id: 'group-a',
                name: 'Group A',
                serverIds: ['127.0.0.1-52753'],
                presentation: 'grouped',
            }],
        });
        expect(identitySettings).not.toHaveProperty('pinnedSessionKeysV1');
        expect(identitySettings).not.toHaveProperty('sessionTagsV1');
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

    it('drops migrated legacy session folders from active pending settings', async () => {
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

        mod.savePendingAccountSettings(identityScope, {
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
        mod.savePendingAccountSettings(legacyScope, {
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

    it('drops a later-discovered legacy sparse organization scope from identity pending settings', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const lateLegacyScope = { serverId: 'public-host-18829', accountId: 'account-a' };

        mod.savePendingAccountSettings(identityScope, {
            pinnedSessionKeysV1: ['first-legacy-session'],
            sessionTagsV1: {
                firstLegacySession: ['first-tag'],
            },
        });
        mod.saveAccountSettings(lateLegacyScope, {
            ...settingsDefaults,
            analyticsOptOut: true,
            pinnedSessionKeysV1: ['late-cached-session'],
        }, 8);
        mod.savePendingAccountSettings(lateLegacyScope, {
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

    it('drops a legacy cached organization scope that appears after an earlier empty migration check', async () => {
        const mod = await loadAccountSettingsPersistenceModule();
        expect(mod, 'account settings persistence module should exist').not.toBeNull();
        if (!mod) return;

        const identityScope = { serverId: 'srv_identity', accountId: 'account-a' };
        const lateLegacyScope = { serverId: 'public-host-18829', accountId: 'account-a' };

        mod.prepareAccountSettingsScopeForActivation(identityScope, [lateLegacyScope]);

        mod.saveAccountSettings(lateLegacyScope, {
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

        mod.saveAccountSettings(orphanedHostScope, {
            ...settingsDefaults,
            pinnedSessionKeysV1: ['orphaned-session'],
            sessionTagsV1: {
                orphanedSession: ['orphaned-tag'],
            },
        }, 12);
        mod.savePendingAccountSettings(orphanedHostScope, {
            workspaceLabelsV1: {
                orphanedWorkspace: 'Orphaned workspace',
            },
        });
        mod.savePendingAccountSettings(otherAccountScope, {
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

        mod.savePendingAccountSettings(unrelatedHostScope, {
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
