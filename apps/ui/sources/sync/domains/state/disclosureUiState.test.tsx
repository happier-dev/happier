import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { buildSessionListCollapseContextKey, buildSessionListCollapseKey, readSessionListCollapsedGroups } from '@/sync/domains/session/listing/sessionListCollapseState';
import { getStorage } from './storageStore';
import { clearPersistenceStorage, getPersistenceStorage } from './persistenceStorage';
import { createPersistentUiState } from './persistentUiState';
import { loadLocalSettings } from './settingsPersistence';
import { collapsedGroupsState, replaceCollapsedGroupKeys, sessionInfoDisclosuresState, useCollapsedGroupKeys, useSessionInfoSectionExpanded } from './disclosureUiState';

afterEach(() => { standardCleanup(); vi.restoreAllMocks(); clearPersistenceStorage(); });

describe('keyed disclosure state', () => {
    it('restores Setup disclosure at the real keyed consumer without rebuilding a Settings carrier', async () => {
        getPersistenceStorage().set('local-settings', JSON.stringify({ sessionInfoExpandedSectionsV1: { memory: true } }));
        const loaded = loadLocalSettings();
        const section = await renderHook(() => useSessionInfoSectionExpanded('memory'));
        expect(section.getCurrent()).toBe(true);
        expect(loaded).not.toHaveProperty('sessionInfoExpandedSectionsV1');
        expect(loaded).not.toHaveProperty('collapsedGroupKeysV1');
    });
    it('keeps mounted list-context and Bot readers idle for unrelated group keys', async () => {
        const context = buildSessionListCollapseContextKey({ retentionScopeKey: 'home/alice/global', corpusStorage: 'active' }, 'projects');
        const key = buildSessionListCollapseKey(context, 'group');
        let contextRenders = 0;
        let botRenders = 0;
        const botKeys = ['bot-node'];
        const contextHook = await renderHook(() => { contextRenders++; return useCollapsedGroupKeys(buildSessionListCollapseKey(context, '')); });
        const botHook = await renderHook(() => { botRenders++; return useCollapsedGroupKeys(botKeys); });
        const beforeContext = contextRenders;
        const beforeBot = botRenders;
        const scans = vi.spyOn(getPersistenceStorage(), 'getAllKeys');
        await act(async () => collapsedGroupsState.set('other-home-group', true));
        expect(contextRenders).toBe(beforeContext);
        expect(botRenders).toBe(beforeBot);
        expect(scans).toHaveBeenCalledTimes(0);
        await act(async () => collapsedGroupsState.set(key, true));
        expect(contextHook.getCurrent()).toEqual({ [key]: true });
        expect(botRenders).toBe(beforeBot);
        await act(async () => collapsedGroupsState.set('bot-node', false));
        expect(botHook.getCurrent()).toEqual({ 'bot-node': false });
        expect(scans).toHaveBeenCalledTimes(0);
        await act(async () => clearPersistenceStorage());
        expect(contextHook.getCurrent()).toEqual({});
        expect(botHook.getCurrent()).toEqual({});
    });

    it('changes one qualified group among 1000 without Settings publications or unrelated section renders', async () => {
        const context = buildSessionListCollapseContextKey({ retentionScopeKey: 'home/alice/global', corpusStorage: 'active' }, 'projects');
        const other = buildSessionListCollapseContextKey({ retentionScopeKey: 'home/bob/global', corpusStorage: 'active' }, 'projects');
        replaceCollapsedGroupKeys(Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [buildSessionListCollapseKey(context, `group-${index}`), true])));
        let sectionRenders = 0;
        const section = await renderHook(() => { sectionRenders++; return useSessionInfoSectionExpanded('memory'); });
        const initialRenders = sectionRenders;
        const groups = await renderHook(() => useCollapsedGroupKeys(buildSessionListCollapseKey(context, '')));
        const publications = vi.fn();
        const stop = getStorage().subscribe((next, previous) => {
            if (next.localSettings !== previous.localSettings || next.settings !== previous.settings) publications();
        });
        const writes = vi.spyOn(getPersistenceStorage(), 'set');
        try {
            await act(async () => collapsedGroupsState.set(buildSessionListCollapseKey(context, 'group-999'), false));
            expect(readSessionListCollapsedGroups(groups.getCurrent(), context)['group-999']).toBe(false);
            expect(readSessionListCollapsedGroups(groups.getCurrent(), other)).toEqual({});
            expect(sectionRenders).toBe(initialRenders);
            expect(writes).toHaveBeenCalledTimes(1);
            await act(async () => collapsedGroupsState.set(buildSessionListCollapseKey(context, 'group-999'), false));
            expect(writes).toHaveBeenCalledTimes(1);
            await act(async () => sessionInfoDisclosuresState.set('memory', true));
            expect(section.getCurrent()).toBe(true);
            expect(publications).toHaveBeenCalledTimes(0);
            const restored = createPersistentUiState('collapsed-groups-v1', value => value);
            expect(restored.read(buildSessionListCollapseKey(context, 'group-999'))).toBe(false);
        } finally { stop(); }
    });
});
