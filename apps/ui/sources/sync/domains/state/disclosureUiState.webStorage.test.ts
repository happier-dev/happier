import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { buildSessionListCollapseContextKey, buildSessionListCollapseKey, readSessionListCollapsedGroups } from '@/sync/domains/session/listing/sessionListCollapseState';
import { buildSessionListViewCredentialScopeKey } from '@/components/sessions/shell/search/useSessionListViewFilters';
import { clearPersistenceStorage, getPersistenceStorage } from './persistenceStorage';
import { createPersistentUiState } from './persistentUiState';
import { collapsedGroupsState, sessionInfoDisclosuresState } from './disclosureUiState';
import { readLastNewSessionAgentPickerView, readOrdinaryNewSessionDraftId, rememberLastNewSessionAgentPickerView, rememberOrdinaryNewSessionDraftId } from './newSessionTargetUiState';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { loadLocalSettings } from './settingsPersistence';
import { selectCollectionSpace } from '@/sync/domains/session/listing/sessionListSpaces';
import { accountSettingsScopeKeySuffix } from '@/sync/domains/settings/scope/accountSettingsScope';
import { writeComposerBannerCollapse } from './composerBannerUiState';

let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
let webStorage: ReturnType<typeof import('../../../../../../node_modules/react-native-mmkv/src/createMMKV.web').createMMKV>;

beforeAll(async () => {
    browser = await installBrowserRuntimeForTests({ url: 'https://happier.test' });
    // Import the installed 3.3.3 web adapter directly: the normal MMKV test alias is native-like.
    const { createMMKV } = await import('../../../../../../node_modules/react-native-mmkv/src/createMMKV.web');
    webStorage = createMMKV({ id: 'perf-l12-j-web' });
});
beforeEach(() => {
    browser.activate();
    const storage = getPersistenceStorage();
    vi.spyOn(storage, 'getString').mockImplementation(webStorage.getString);
    vi.spyOn(storage, 'set').mockImplementation(webStorage.set);
    vi.spyOn(storage, 'delete').mockImplementation(webStorage.delete);
    vi.spyOn(storage, 'getAllKeys').mockImplementation(webStorage.getAllKeys);
    vi.spyOn(storage, 'clearAll').mockImplementation(webStorage.clearAll);
    clearPersistenceStorage();
});
afterEach(() => { clearPersistenceStorage(); vi.restoreAllMocks(); });
afterAll(() => browser.restore());

describe('disclosure keys through the real MMKV web boundary', () => {
    it('persists Pinned and qualified report groups, restores them and keeps unrelated contexts isolated', () => {
        const scope = { serverId: 'home-a', accountId: 'alice' };
        const retentionScopeKey = buildSessionListViewCredentialScopeKey('global', new Map([
            [scope.serverId, { kind: 'bound' as const, scope }],
        ]), [scope.serverId]);
        const context = buildSessionListCollapseContextKey({ retentionScopeKey, corpusStorage: 'active' }, 'projects');
        const other = buildSessionListCollapseContextKey({ retentionScopeKey, corpusStorage: 'archived' }, 'projects');
        const group = 'header:["project","C:\\work\\project","folder"]';
        const pinnedKey = buildSessionListCollapseKey(context, 'pinned');
        const reportKey = buildSessionListCollapseKey(context, group);
        collapsedGroupsState.set(pinnedKey, true);
        collapsedGroupsState.set(reportKey, false);
        const restored = createPersistentUiState('collapsed-groups-v1', value => z.boolean().parse(value));
        expect(readSessionListCollapsedGroups(restored.readAll(), context)).toEqual({ pinned: true, [group]: false });
        expect(readSessionListCollapsedGroups(restored.readAll(), other)).toEqual({});
        collapsedGroupsState.remove(pinnedKey);
        expect(createPersistentUiState('collapsed-groups-v1', value => value).read(pinnedKey)).toBeUndefined();
    });

    it('persists and restores every introduced interaction key on web', async () => {
        for (const key of ['instructions', 'memory', 'context', 'voice', 'roles', 'notes', 'about']) {
            sessionInfoDisclosuresState.set(key, false);
        }
        const scope = { serverId: 'home-a', accountId: 'alice' };
        const other = { ...scope, accountId: 'bob' };
        const draftId = '4a506d8a-85bd-4c42-a662-6f502f3acc45';
        rememberLastNewSessionAgentPickerView(scope, { kind: 'favoriteModels' });
        rememberLastNewSessionAgentPickerView(null, null);
        rememberOrdinaryNewSessionDraftId(scope, draftId);
        await selectCollectionSpace(scope, 'sessionWork', 'my-work');
        writeComposerBannerCollapse({ usageLimitRecovery: true });
        expect(readLastNewSessionAgentPickerView(scope)).toEqual({ kind: 'favoriteModels' });
        expect(readOrdinaryNewSessionDraftId(other)).toBeNull();
        expect(createPersistentUiState('new-session-picker-view-v1', value => value).read('legacy-unscoped')).toBeNull();
        expect(createPersistentUiState('session-info-disclosures-v1', value => value).readAll()).toEqual(
            Object.fromEntries(['instructions', 'memory', 'context', 'voice', 'roles', 'notes', 'about'].map(key => [key, false])),
        );
        expect(createPersistentUiState('new-session-picker-view-v1', value => value).read(serverAccountScopeKeySuffix(scope)))
            .toEqual({ kind: 'favoriteModels' });
        expect(createPersistentUiState('new-session-ordinary-draft-v1', value => value).read(serverAccountScopeKeySuffix(scope)))
            .toBe(draftId);
        expect(createPersistentUiState('collection-space-v1', value => value)
            .read(JSON.stringify([accountSettingsScopeKeySuffix(scope), 'sessionWork']))).toBe('my-work');
        expect(createPersistentUiState('composer-banner-collapse-v1', value => value).read('collapsed'))
            .toEqual({ usageLimitRecovery: true });
    });

    it('imports retained disclosure keys verbatim and does no repeated migration scans or writes', () => {
        const legacyKey = 'retained-project-group';
        getPersistenceStorage().set('local-settings', JSON.stringify({ collapsedGroupKeysV1: { [legacyKey]: true } }));
        loadLocalSettings();
        expect(collapsedGroupsState.read(legacyKey)).toBe(true);
        expect(JSON.parse(getPersistenceStorage().getString('local-settings')!)).not.toHaveProperty('collapsedGroupKeysV1');
        const scan = vi.spyOn(getPersistenceStorage(), 'getAllKeys');
        const write = vi.spyOn(getPersistenceStorage(), 'set');
        scan.mockClear();
        write.mockClear();
        loadLocalSettings();
        expect(scan).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
    });
});
