import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPersistenceStorage, getPersistenceStorage } from './persistenceStorage';
import { migrateDisclosureUiStateFromSettings } from './disclosureUiState';
import { migrateNewSessionUiState } from './newSessionTargetUiState';
import { loadLocalSettings, saveLocalSettings } from './settingsPersistence';
import { accountSettingsScopeKeySuffix } from '@/sync/domains/settings/scope/accountSettingsScope';
import { readCollectionSpaceId, selectCollectionSpace } from '@/sync/domains/session/listing/sessionListSpaces';
import { readComposerBannerCollapse, writeComposerBannerCollapse } from './composerBannerUiState';

afterEach(() => { vi.restoreAllMocks(); clearPersistenceStorage(); });
describe('interaction state admission', () => {
    it('ignores never-shipped collection Settings seeds while current device choices stay scoped', () => {
        const alice = { serverId: 'collection-import', accountId: 'alice' };
        const aliceKey = accountSettingsScopeKeySuffix(alice);
        const bobKey = accountSettingsScopeKeySuffix({ ...alice, accountId: 'bob' });
        selectCollectionSpace(alice, 'sessionWork', 'my-work');
        const device = getPersistenceStorage();
        device.set('local-settings', JSON.stringify({ sidebarCollapsed: true,
            collectionSpaceV1: { v: 1, byAccountScope: {
                [aliceKey]: { workflow: { spaceId: 'flows' } },
                [bobKey]: { discussion: { spaceId: 'threads' } },
            } }, sessionComposerCollapsedBannerKinds: { usageLimitRecovery: true } }));
        const loaded = loadLocalSettings();
        expect(loaded.sidebarCollapsed).toBe(true);
        expect(loaded).not.toHaveProperty('collectionSpaceV1');
        expect(readCollectionSpaceId(aliceKey, 'sessionWork')).toBe('my-work');
        expect(readCollectionSpaceId(aliceKey, 'workflow')).toBeUndefined();
        expect(readCollectionSpaceId(bobKey, 'discussion')).toBeUndefined();
        expect(readComposerBannerCollapse()).toEqual({ usageLimitRecovery: true });
        selectCollectionSpace(alice, 'workflow', 'current-flows');
        expect(readCollectionSpaceId(aliceKey, 'workflow')).toBe('current-flows');
        expect(readCollectionSpaceId(bobKey, 'workflow')).toBeUndefined();
    });

    it('keeps released banner source on a refused import and retries without replacing a current choice', () => {
        const device = getPersistenceStorage();
        const seed = { sessionComposerCollapsedBannerKinds: { usageLimitRecovery: true } };
        const raw = JSON.stringify(seed);
        device.set('local-settings', raw);
        const set = device.set.bind(device);
        const refusal = vi.spyOn(device, 'set').mockImplementation((key, value) => {
            if (key.startsWith('ui-state:composer-banner-collapse-v1:')) throw new Error('device full');
            set(key, value);
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const loaded = loadLocalSettings();
        saveLocalSettings({ ...loaded, sidebarCollapsed: true });
        expect(JSON.parse(device.getString('local-settings')!)).toMatchObject(seed);
        refusal.mockRestore();
        writeComposerBannerCollapse({});
        loadLocalSettings();
        expect(readComposerBannerCollapse()).toEqual({});
        expect(JSON.parse(device.getString('local-settings')!)).not.toHaveProperty('sessionComposerCollapsedBannerKinds');
    });

    it('keeps unadmitted released banner source bytes', () => {
        const seed = { sessionComposerCollapsedBannerKinds: { usageLimitRecovery: 'yes' } };
        const device = getPersistenceStorage();
        const raw = JSON.stringify(seed);
        device.set('local-settings', raw);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const loaded = loadLocalSettings();
        expect(device.getString('local-settings')).toBe(raw);
        saveLocalSettings({ ...loaded, sidebarCollapsed: true });
        expect(JSON.parse(device.getString('local-settings')!)).toMatchObject(seed);
    });
    it('refuses malformed disclosure seeds instead of retiring an unadmitted source', () => {
        const collapsedGroupKeysV1 = { valid: true, invalid: 'yes' };
        expect(migrateDisclosureUiStateFromSettings({ collapsedGroupKeysV1 })).toEqual({ collapsedGroupKeysV1 });
    });
    it('refuses malformed New Session memory instead of retiring unadmitted source bytes', () => {
        const scope = { serverId: 'interaction-admission', accountId: 'alice' };
        expect(() => migrateNewSessionUiState(scope, { newSessionOrdinaryEntryDraftId: 'not-a-draft-id' })).toThrow();
        expect(() => migrateNewSessionUiState(scope, { lastNewSessionAgentPickerViewV1: { kind: 'unknown' } })).toThrow();
    });
    it('keeps a refused disclosure seed through the real loader and an unrelated preference save', () => {
        const device = getPersistenceStorage();
        const seed = { collapsedGroupKeysV1: { retained: 'yes' } };
        const raw = JSON.stringify(seed);
        device.set('local-settings', raw);
        const loaded = loadLocalSettings();
        expect(device.getString('local-settings')).toBe(raw);
        saveLocalSettings({ ...loaded, sidebarCollapsed: true });
        expect(JSON.parse(device.getString('local-settings')!)).toMatchObject(seed);
    });
});
