import { readThemeProfileLegacyAccountScope, writeThemeProfileLegacyAccountScope } from '@/sync/domains/state/themeProfileMigrationUiState';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import type { RawSettingsMutationOptions } from '@/sync/ops/actions/accountSettingsMutation';
import type { SettingOwnerMutation } from '@/components/settings/catalog/settingDeclarations';
import type { ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { syncSettings, requireOneShotAccountSettingsMutationApplied } = await import('./syncSettings');
const { persistThemeProfilesForSetting } = await import('@/components/settings/appearance/themeProfiles/themeProfilesSettingBinding');
const { resolveAccountThemeProfiles } = await import('@/sync/domains/settings/themeProfiles');
const { createAccountSettingsMutation } = await import('@/sync/ops/actions/accountSettingsMutation');
const { ThemeProfileMigrationSourceExpiredError } = await import('@/theme/profiles/themeProfileMigrationEdits');
const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
const { fetchAccountEncryptionMode } = await import('@/sync/api/account/apiAccountEncryptionMode');
const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { localSettingsParse } = await import('@/sync/domains/settings/localSettings');
const { storage } = await import('@/sync/domains/state/storageStore');
const { loadLocalSettings, saveLocalSettings } = await import('@/sync/domains/state/settingsPersistence');
const { loadThemeRuntimeLocalState } = await import('@/sync/domains/state/persistence');
const { loadPendingAccountSettingsState, saveActiveAccountSettingsScope, savePendingAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
const profile = (id: string, name = id): ThemeProfileV1 => ({ schemaVersion: 1, id, name,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    base: { light: 'light', dark: 'dark' }, assetAppearance: 'dark', overrides: { light: {}, dark: {} } });

afterEach(async () => { await harness.reset(); });
beforeEach(() => { installHomeGovernanceBoundaries(harness); });

describe('account theme library migration', () => {
    async function setup(initialLibrary: readonly ThemeProfileV1[] = [profile('cloud')]) {
        const serverId = await harness.addHome({ name: 'Themes', serverUrl: 'https://themes.example', accountId: 'owner', currentAccount: true });
        const scope = { serverId, accountId: 'owner' };
        writeThemeProfileLegacyAccountScope(null);
        const localSettings = localSettingsParse({ themeProfiles: { profiles: [profile('local')], activeProfileIds: { light: null, dark: 'local' } } });
        saveLocalSettings(localSettings);
        storage.setState({ settingsScope: scope, settingsVersion: 1, settings: settingsParse({}), localSettings });
        savePendingAccountSettings(scope, {});
        saveActiveAccountSettingsScope(scope);
        let library = initialLibrary;
        let version = 4;
        let posts = 0;
        let fail = false;
        let conflict = false;
        let loseReply = false;
        let nextPost: (() => Promise<void>) | null = null;
        harness.answer(serverId, '/v2/account/settings', { select: () => ({ body: { content: { t: 'plain', v: { themeProfiles: library } }, version } }) });
        harness.answer(serverId, 'POST /v2/account/settings', { select: async input => {
            const hook = nextPost; nextPost = null; if (hook) await hook();
            if (fail) return { status: 503, body: { error: 'offline' } };
            if (conflict) {
                conflict = false; library = [...library, profile('another-device')]; version++;
                return { body: { success: false, error: 'version-mismatch', currentVersion: version, currentContent: { t: 'plain', v: { themeProfiles: library } } } };
            }
            const request = AccountSettingsV2UpdateRequestSchema.parse(input);
            if (request.expectedVersion !== version) {
                return { body: { success: false, error: 'version-mismatch', currentVersion: version,
                    currentContent: { t: 'plain', v: { themeProfiles: library } } } };
            }
            const content = request.content;
            if (!content || content.t !== 'plain') throw new Error('Expected plain fixture');
            expect(content.v).not.toHaveProperty('themeProfileSelection');
            library = settingsParse(content.v).themeProfiles; posts++;
            version++;
            if (loseReply) { loseReply = false; throw new Error('Reply lost after server commit'); }
            return { body: { success: true, version } };
        } });
        const sync = (target = scope) => syncSettings({ credentials: { token: createAccountTokenForTests(target.accountId, { currentAccount: true }) },
            encryption: null, settingsScope: target, pendingSettings: {}, clearPendingSettings: next => savePendingAccountSettings(target, next) });
        return { scope, sync, onNextPost: (hook: () => Promise<void>) => { nextPost = hook; }, library: () => library, posts: () => posts, removeProfile: (id: string) => { library = library.filter(p => p.id !== id); version++; }, loseReply: () => { loseReply = true; }, fail: () => { fail = true; }, conflict: () => { conflict = true; } };
    }
    it('merges the account library and clears the backup only after CAS acknowledgement', async () => {
        const state = await setup(); await state.sync();
        expect(state.library().map(p => p.id)).toEqual(['cloud', 'local']);
        expect(state.posts()).toBe(1);
        expect(loadLocalSettings()).toMatchObject({ themeProfiles: { profiles: [] }, themeProfileSelection: { light: null, dark: 'local' } });
        await state.sync(); expect(state.posts()).toBe(1);
    });
    it('retains the backup and binding on failure, excluding a different account', async () => {
        const state = await setup(); state.fail();
        await expect(state.sync()).rejects.toThrow();
        expect(loadLocalSettings()).toMatchObject({ themeProfiles: { profiles: [profile('local')] } });
        expect(readThemeProfileLegacyAccountScope()).toEqual(state.scope);
        expect(loadLocalSettings()).not.toHaveProperty('themeProfileLegacyAccountScope');
        expect(JSON.parse(getPersistenceStorage().getString('ui-state:theme-profile-migration-v1:legacy-account-scope')!)).toEqual(state.scope);
        const otherScope = { ...state.scope, accountId: 'other' };
        storage.setState({ settingsScope: otherScope, settingsVersion: 1, settings: settingsParse({}) });
        await state.sync(otherScope);
        expect(state.posts()).toBe(0);
        expect(loadLocalSettings().themeProfiles.profiles).toEqual([profile('local')]);
    });
    it('merges with the winning account library after a CAS conflict', async () => {
        const state = await setup(); state.conflict(); await state.sync();
        expect(state.library().map(p => p.id)).toEqual(['cloud', 'another-device', 'local']);
        expect(loadLocalSettings().themeProfiles.profiles).toEqual([]);
    });
    it.each([
        [{ light: null, dark: { legacyProfileId: 'local' } }, 'local_2'],
        [{ light: null, dark: 'local' }, 'local'],
    ] as const)('canonicalizes a newer selection %j before clearing its legacy backup', async (selection, expectedId) => {
        const state = await setup([profile('local', 'Cloud local')]);
        const entered = createDeferred<void>(); const release = createDeferred<void>();
        state.onNextPost(async () => { entered.resolve(); await release.promise; });
        const migrating = state.sync();
        await entered.promise;
        try { storage.getState().applyLocalSettings({ themeProfileSelection: selection }); }
        finally { release.resolve(); await migrating; }
        expect(loadLocalSettings()).toMatchObject({ themeProfiles: { profiles: [] },
            themeProfileSelection: { light: null, dark: expectedId } });
        expect(loadThemeRuntimeLocalState().themeProfiles.activeProfileIds.dark).toBe(expectedId);
    });
    function createMutation(scope: { serverId: string; accountId: string }, onAdmitted?: () => void) {
        const credentials = { token: createAccountTokenForTests('owner', { currentAccount: true }) };
        const request = createServerFetchAtEndpoint({ endpointUrl: 'https://themes.example', credentials, serverId: scope.serverId });
        return createAccountSettingsMutation({ scope: scope, credentials,
            endpointUrl: 'https://themes.example', request, scopeSignal: new AbortController().signal,
            assertCurrent: () => { onAdmitted?.(); expect(storage.getState().settingsScope).toEqual(scope); },
            resolveAccountEncryption: async () => {
                const mode = await fetchAccountEncryptionMode(credentials, { request, usage: 'fresh-authority' });
                if (mode.mode !== 'plain') throw new Error('Expected plain fixture');
                return { accountMode: 'plain', encryption: null };
            },
        });
    }
    it.each(['cleanup failure', 'lost acknowledgement', 'checkpoint cleanup', 'lost acknowledgement and cloud deletion'] as const)('recovers an accepted legacy edit after %s without importing the old definition again', async failure => {
        const state = await setup([profile('local', 'Cloud local')]);
        const mutateAccount = createMutation(state.scope);
        const local = loadLocalSettings();
        const before = resolveAccountThemeProfiles({ profiles: [], legacy: local.themeProfiles,
            selection: local.themeProfileSelection, legacyScope: readThemeProfileLegacyAccountScope(), scope: state.scope });
        const next = { ...before, profiles: [profile('local', 'Edited local')] };
        const device = getPersistenceStorage(); const write = device.set.bind(device);
        if (failure.startsWith('lost acknowledgement')) state.loseReply();
        const refused = vi.spyOn(device, 'set').mockImplementation((key, value) => {
            if (failure === 'cleanup failure' && key === 'local-settings' && typeof value === 'string'
                && JSON.parse(value).themeProfiles?.profiles?.length === 0) throw new Error('Cleanup refused');
            write(key, value);
        });
        const remove = device.delete.bind(device);
        const refusedDelete = vi.spyOn(device, 'delete').mockImplementation(key => {
            if (failure === 'checkpoint cleanup' && key.startsWith('pending-account-settings:v2:')) throw new Error('Checkpoint cleanup refused');
            remove(key);
        });
        try {
            await expect(persistThemeProfilesForSetting({ local, before, next, legacyProfileIds: { local: 'local' },
                writeLocal: delta => storage.getState().applyLocalSettings(delta),
                context: { accountScope: state.scope, isCurrent: () => true, readLocalSettings: loadLocalSettings,
                    mutateSettings: async (mutate: SettingOwnerMutation, options?: RawSettingsMutationOptions) => {
                        await mutateAccount(raw => ({ ...raw, ...mutate(settingsParse(raw)) }), options);
                    } },
            })).rejects.toThrow();
        } finally { refused.mockRestore(); refusedDelete.mockRestore(); }
        expect(state.library().map(p => [p.id, p.name])).toEqual([['local', 'Cloud local'], ['local_2', 'Edited local']]);
        expect(loadPendingAccountSettingsState(state.scope).themeProfileMigration).toMatchObject({ legacyProfileIds: { local: 'local_2' },
            ...(!failure.startsWith('lost acknowledgement') ? { acknowledged: true } : {}) });
        expect(loadThemeRuntimeLocalState().themeProfiles.profiles.map(p => [p.id, p.name])).toEqual([['local', 'Cloud local'], ['local_2', 'Edited local']]);
        const afterCloudDeletion = failure === 'lost acknowledgement and cloud deletion';
        if (afterCloudDeletion) state.removeProfile('local');
        storage.setState({ localSettings: loadLocalSettings() });
        await state.sync();
        expect(state.library().map(p => [p.id, p.name])).toEqual(afterCloudDeletion
            ? [['local_2', 'Edited local']] : [['local', 'Cloud local'], ['local_2', 'Edited local']]);
        expect(loadLocalSettings()).toMatchObject({ themeProfiles: { profiles: [] },
            themeProfileSelection: { light: null, dark: 'local_2' } });
        expect(state.posts()).toBe(1);
        expect(loadPendingAccountSettingsState(state.scope).themeProfileMigration).toBeNull();
        await state.sync(); expect(state.posts()).toBe(1);
    });
    it.each(['cleanup failure', 'lost acknowledgement and cloud deletion'] as const)('recovers an automatic import after %s using its staged actual identities', async failure => {
        const state = await setup([profile('local', 'Cloud local')]);
        const device = getPersistenceStorage(); const write = device.set.bind(device);
        if (failure.startsWith('lost acknowledgement')) state.loseReply();
        const refused = vi.spyOn(device, 'set').mockImplementation((key, value) => {
            if (failure === 'cleanup failure' && key === 'local-settings' && typeof value === 'string'
                && JSON.parse(value).themeProfiles?.profiles?.length === 0) throw new Error('Cleanup refused');
            write(key, value);
        });
        try { await expect(state.sync()).rejects.toThrow(); }
        finally { refused.mockRestore(); }
        expect(loadPendingAccountSettingsState(state.scope).themeProfileMigration).toMatchObject({ edits: [], legacyProfileIds: { local: 'local_2' } });
        expect(state.library().map(p => [p.id, p.name])).toEqual([['local', 'Cloud local'], ['local_2', 'local']]);
        if (failure.startsWith('lost acknowledgement')) state.removeProfile('local');
        storage.setState({ localSettings: loadLocalSettings() });
        await state.sync();
        expect(state.library().map(p => [p.id, p.name])).toEqual(failure === 'cleanup failure'
            ? [['local', 'Cloud local'], ['local_2', 'local']] : [['local_2', 'local']]);
        expect(loadLocalSettings()).toMatchObject({ themeProfiles: { profiles: [] }, themeProfileSelection: { light: null, dark: 'local_2' } });
        expect(loadPendingAccountSettingsState(state.scope)).toMatchObject({ settings: {}, themeProfileMigration: null });
        expect(state.posts()).toBe(1);
    });
    it('refuses a legacy editor captured before an ordinary migration consumed its source', async () => {
        const state = await setup([profile('local', 'Cloud local')]);
        const entered = createDeferred<void>(); const release = createDeferred<void>();
        state.onNextPost(async () => { entered.resolve(); await release.promise; });
        const migrating = state.sync();
        await entered.promise;
        const local = loadLocalSettings();
        const before = resolveAccountThemeProfiles({ profiles: [], legacy: local.themeProfiles,
            selection: local.themeProfileSelection, legacyScope: readThemeProfileLegacyAccountScope(), scope: state.scope });
        let admitted = false;
        const mutateAccount = createMutation(state.scope, () => { admitted = true; });
        const editing = persistThemeProfilesForSetting({ local, before,
            next: { ...before, profiles: [profile('local', 'Edited local')] }, legacyProfileIds: { local: 'local' },
            writeLocal: delta => storage.getState().applyLocalSettings(delta),
            context: { accountScope: state.scope, isCurrent: () => true, readLocalSettings: loadLocalSettings,
                mutateSettings: async (mutate: SettingOwnerMutation, options?: RawSettingsMutationOptions) => {
                    await mutateAccount(raw => ({ ...raw, ...mutate(settingsParse(raw)) }), options);
                } },
        }).then(() => null, (error: unknown) => error);
        // The public currentness hook marks admission before any asynchronous
        // authority reads. Let an already admitted edit settle ahead of this POST;
        // a correctly queued editor stays unopened until the migration settles.
        try { await Promise.resolve(); if (admitted) await editing; }
        finally { release.resolve(); }
        await migrating;
        expect(await editing).toBeInstanceOf(ThemeProfileMigrationSourceExpiredError);
        expect(state.library().map(p => [p.id, p.name])).toEqual([['local', 'Cloud local'], ['local_2', 'local']]);
        expect(loadPendingAccountSettingsState(state.scope).themeProfileMigration).toBeNull();
        expect(state.posts()).toBe(1);
    });
    it('does not resurrect a captured legacy copy after an acknowledged editor CAS consumed it', async () => {
        const state = await setup();
        const entered = createDeferred<void>(); const release = createDeferred<void>();
        state.onNextPost(async () => { entered.resolve(); await release.promise; });
        const migrating = state.sync();
        await entered.promise;
        try {
            const local = loadLocalSettings();
            const before = resolveAccountThemeProfiles({ profiles: storage.getState().settings.themeProfiles, legacy: local.themeProfiles,
                selection: local.themeProfileSelection, legacyScope: readThemeProfileLegacyAccountScope(), scope: state.scope });
            const next = { ...before, profiles: before.profiles.map(p => p.id === 'local' ? { ...p, name: 'Edited local' } : p) };
            await persistThemeProfilesForSetting({ local, before, next,
                writeLocal: delta => storage.getState().applyLocalSettings(delta),
                context: { accountScope: state.scope, isCurrent: () => true, mutateSettings: async mutate => {
                    requireOneShotAccountSettingsMutationApplied(await syncSettings({
                        credentials: { token: createAccountTokenForTests('owner', { currentAccount: true }) },
                        encryption: null, settingsScope: state.scope, pendingSettings: {}, clearPendingSettings: () => {},
                        oneShotServerSettingsMutation: { expectedSettingsVersion: null, rebaseOnConflict: true,
                            mutate: raw => ({ settings: { ...raw, ...mutate(settingsParse(raw)) }, value: undefined }) },
                    }));
                } },
            });
            expect(loadLocalSettings().themeProfiles.profiles).toEqual([]);
        } finally { release.resolve(); await migrating; }
        expect(state.library().map(p => [p.id, p.name])).toEqual([['cloud', 'cloud'], ['local', 'Edited local']]);
    });


});
