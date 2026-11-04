import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { buildSessionListCollapseContextKey, buildSessionListCollapseKey, readSessionListCollapsedGroups } from '@/sync/domains/session/listing/sessionListCollapseState';
import { buildSessionListViewCredentialScopeKey } from '@/components/sessions/shell/search/useSessionListViewFilters';
import { clearPersistenceStorage, getPersistenceStorage } from './persistenceStorage';
import { createPersistentUiState } from './persistentUiState';
import { collapsedGroupsState } from './disclosureUiState';
import { loadLocalSettings } from './settingsPersistence';

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

    it('imports retained list seeds before web storage and does no repeated migration scans or writes', () => {
        const legacyKey = String.raw`sessionList:"[\"home/alice/global\",\"active\",\"projects\",null]":pinned`;
        const context = buildSessionListCollapseContextKey({ retentionScopeKey: 'home/alice/global', corpusStorage: 'active' }, 'projects');
        getPersistenceStorage().set('local-settings', JSON.stringify({ collapsedGroupKeysV1: { [legacyKey]: true } }));
        loadLocalSettings();
        expect(readSessionListCollapsedGroups(collapsedGroupsState.readAll(), context)).toEqual({ pinned: true });
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
