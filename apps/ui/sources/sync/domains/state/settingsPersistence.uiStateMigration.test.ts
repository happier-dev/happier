import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPersistenceStorage, getPersistenceStorage } from './persistenceStorage';
import { loadLocalSettings, saveLocalSettings } from './settingsPersistence';
import { collapsedGroupsState, removeCollapsedGroupKey, replaceCollapsedGroupKeys } from './disclosureUiState';
import { UiStatePersistenceError } from './persistentUiState';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { buildSessionListCollapseContextKey, buildSessionListCollapseKey, readSessionListCollapsedGroups } from '@/sync/domains/session/listing/sessionListCollapseState';
import { installLegacyNativeMmkvBoundaryForTest } from '@/dev/testkit/harness/persistentUiState';

afterEach(() => { vi.restoreAllMocks(); clearPersistenceStorage(); });

const initializedProjectNavigation = { navigationSurfacePlacementsV1: { detailPages: { project: { phone: { items: { orderedIds: [], placements: {} } } } } } };

describe('retained workspace settings migration', () => {
    it('saves the mapped notch dock without keeping never-shipped position inputs', () => {
        const device = getPersistenceStorage();
        device.set('local-settings', JSON.stringify({ desktopOverlayPresentationMode: 'floating_overlay',
            desktopOverlayPlacementMode: 'custom', desktopOverlayAnchor: 'bottom_right',
            desktopOverlayDensity: 'comfortable', desktopOverlayCompactStyle: 'panel' }));
        const settings = loadLocalSettings();
        saveLocalSettings({ ...settings, themePreference: 'dark' });
        expect(JSON.parse(device.getString('local-settings')!)).toHaveProperty('desktopOverlayDock', 'floating');
        expect(loadLocalSettings().desktopOverlayDock).toBe('floating');
        expect(JSON.parse(device.getString('local-settings')!)).not.toHaveProperty('desktopOverlayAnchor');
        expect(loadLocalSettings()).toMatchObject({ desktopOverlayDock: 'floating', themePreference: 'dark' });
    });

    it.each(['bottom_left', 'bottom_center', 'bottom_right'] as const)(
        'maps %s to the Floating dock', (anchor) => {
            getPersistenceStorage().set('local-settings', JSON.stringify({ desktopOverlayAnchor: anchor }));
            expect(loadLocalSettings().desktopOverlayDock).toBe('floating');
        },
    );

    it('does not replay old position inputs over an explicit dock preference', () => {
        getPersistenceStorage().set('local-settings', JSON.stringify({ desktopOverlayDock: 'left',
            desktopOverlayPresentationMode: 'floating_overlay', desktopOverlayPlacementMode: 'custom', desktopOverlayAnchor: 'bottom_right' }));
        expect(loadLocalSettings().desktopOverlayDock).toBe('left');
    });

    it('keeps a deliberate dock edit over the historical mode mapping', () => {
        const device = getPersistenceStorage();
        device.set('local-settings', JSON.stringify({ desktopOverlayAnchor: 'bottom_right' }));
        const settings = loadLocalSettings();
        saveLocalSettings({ ...settings, desktopOverlayDock: 'left' });
        expect(loadLocalSettings().desktopOverlayDock).toBe('left');
        expect(JSON.parse(device.getString('local-settings')!)).not.toHaveProperty('desktopOverlayAnchor');
    });

    it('imports admitted navigation while another device-state seed is invalid', () => {
        const device = getPersistenceStorage();
        const opaqueHistory = { future: true };
        device.set('local-settings', JSON.stringify({ brandHeroSeenAt: opaqueHistory,
            sessionMruOrderV1: ['retained-home:session'], themePreference: 'dark' }));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        loadLocalSettings();
        expect(JSON.parse(device.getString('ui-state:session-navigation-mru-v1:order') ?? 'null')).toEqual(['retained-home:session']);
        expect(JSON.parse(device.getString('local-settings')!)).toEqual({ brandHeroSeenAt: opaqueHistory, themePreference: 'dark', ...initializedProjectNavigation });
    });

    it('does not treat an unreadable legacy source as completed admission before clearing', () => {
        const storage = getPersistenceStorage();
        const raw = '{invalid';
        storage.set('local-settings', raw);
        collapsedGroupsState.set('current', true);
        expect(() => replaceCollapsedGroupKeys({})).toThrow(UiStatePersistenceError);
        expect(storage.getString('local-settings')).toBe(raw);
        expect(collapsedGroupsState.read('current')).toBe(true);
        storage.set('local-settings', JSON.stringify({ collapsedGroupKeysV1: { retained: true } }));
        replaceCollapsedGroupKeys({ current: false });
        expect(collapsedGroupsState.read('current')).toBe(false);
        expect(collapsedGroupsState.read('retained')).toBeUndefined();
    });
    it('reads the legacy source once per storage lifetime across repeated collapse writes and removals', () => {
        const storage = getPersistenceStorage();
        storage.set('local-settings', JSON.stringify({ collapsedGroupKeysV1: { retained: true } }));
        const reads = vi.spyOn(storage, 'getString');
        replaceCollapsedGroupKeys({ current: true });
        expect(collapsedGroupsState.read('retained')).toBeUndefined();
        expect(reads.mock.calls.filter(([key]) => key === 'local-settings')).toHaveLength(1);
        reads.mockClear();
        for (let index = 0; index < 100; index++) {
            replaceCollapsedGroupKeys({ current: index % 2 === 0 });
            removeCollapsedGroupKey('current');
        }
        expect(reads.mock.calls.filter(([key]) => key === 'local-settings')).toHaveLength(0);
        clearPersistenceStorage();
        storage.set('local-settings', JSON.stringify({ collapsedGroupKeysV1: { afterClear: true } }));
        replaceCollapsedGroupKeys({ afterClear: false });
        expect(collapsedGroupsState.read('afterClear')).toBe(false);
        expect(JSON.parse(storage.getString('local-settings')!)).not.toHaveProperty('collapsedGroupKeysV1');
        expect(reads.mock.calls.filter(([key]) => key === 'local-settings')).toHaveLength(2);
    });

    it('adopts native and Settings list-collapse seeds without replacing a current qualified choice', async () => {
        await installLegacyNativeMmkvBoundaryForTest();
        const storage = getPersistenceStorage();
        const context = buildSessionListCollapseContextKey({ retentionScopeKey: 'home/alice/global', corpusStorage: 'active' }, 'projects');
        // Captured pre-fix sessionListCollapseState writer (QA-FIXWAVE 2026-10-28).
        const legacyPrefix = String.raw`sessionList:"[\"home/alice/global\",\"active\",\"projects\",null]":`;
        const currentKey = buildSessionListCollapseKey(context, 'pinned');
        storage.set(`ui-state:collapsed-groups-v1:${legacyPrefix}pinned`, 'true');
        storage.set(`ui-state:collapsed-groups-v1:${currentKey}`, 'false');
        storage.set('local-settings', JSON.stringify({ collapsedGroupKeysV1: { [`${legacyPrefix}recent`]: true,
            'connectedServices:["home","account","plugin","service","account","profile"]': false } }));
        loadLocalSettings();
        expect(readSessionListCollapsedGroups(collapsedGroupsState.readAll(), context)).toEqual({ pinned: false, recent: true });
        expect(storage.getString(`ui-state:collapsed-groups-v1:${legacyPrefix}pinned`)).toBeUndefined();
        expect(storage.getString('ui-state:collapsed-groups-v1:connectedServices:["home","account","plugin","service","account","profile"]')).toBe('false');
        expect(JSON.parse(storage.getString('local-settings')!)).not.toHaveProperty('collapsedGroupKeysV1');
    });

    it('retains a native list seed on refused migration and retries even without a LocalSettings blob', async () => {
        const native = await installLegacyNativeMmkvBoundaryForTest();
        const storage = getPersistenceStorage();
        const context = buildSessionListCollapseContextKey({ retentionScopeKey: 'home/alice/global', corpusStorage: 'active' }, 'projects');
        const legacyKey = String.raw`sessionList:"[\"home/alice/global\",\"active\",\"projects\",null]":pinned`;
        storage.delete('local-settings');
        storage.set(`ui-state:collapsed-groups-v1:${legacyKey}`, 'true');
        const write = native.set;
        const refusal = vi.spyOn(storage, 'set').mockImplementation((key, value) => {
            if (key === `ui-state:collapsed-groups-v1:${buildSessionListCollapseKey(context, 'pinned')}`) throw new Error('device full');
            write(key, value);
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        loadLocalSettings();
        expect(storage.getString(`ui-state:collapsed-groups-v1:${legacyKey}`)).toBe('true');
        storage.set('local-settings', JSON.stringify({ themePreference: 'dark' }));
        expect(loadLocalSettings().themePreference).toBe('dark');
        expect(() => replaceCollapsedGroupKeys({})).toThrow(UiStatePersistenceError);
        refusal.mockImplementation(native.set);
        loadLocalSettings();
        expect(collapsedGroupsState.read(buildSessionListCollapseKey(context, 'pinned'))).toBe(true);
        expect(storage.getString(`ui-state:collapsed-groups-v1:${legacyKey}`)).toBeUndefined();
        replaceCollapsedGroupKeys({});
        loadLocalSettings();
        expect(collapsedGroupsState.read(buildSessionListCollapseKey(context, 'pinned'))).toBeUndefined();
    });

    it('still heals malformed LocalSettings through an explicit preference save', () => {
        const storage = getPersistenceStorage();
        storage.set('local-settings', '{invalid');
        vi.spyOn(console, 'error').mockImplementation(() => {});
        saveLocalSettings({ ...localSettingsDefaults, themePreference: 'dark' });
        expect(loadLocalSettings().themePreference).toBe('dark');
    });

    it('does not resurrect an explicitly cleared group after a partial legacy import retries', () => {
        const storage = getPersistenceStorage();
        storage.set('local-settings', JSON.stringify({ collapsedGroupKeysV1: { 'partial-copy-first': true, 'partial-copy-refused': true } }));
        const write = storage.set.bind(storage);
        const refusal = vi.spyOn(storage, 'set').mockImplementation((key, value) => {
            if (key === 'ui-state:collapsed-groups-v1:partial-copy-refused') throw new Error('device full');
            write(key, value);
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        loadLocalSettings();
        expect(collapsedGroupsState.read('partial-copy-first')).toBe(true);
        expect(() => replaceCollapsedGroupKeys({})).toThrow(UiStatePersistenceError);
        expect(collapsedGroupsState.read('partial-copy-first')).toBe(true);
        refusal.mockRestore();
        const read = storage.getString.bind(storage);
        const refusedSourceRead = vi.spyOn(storage, 'getString').mockImplementation(key => {
            if (key === 'local-settings') throw new Error('device read refused');
            return read(key);
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => replaceCollapsedGroupKeys({})).toThrow(UiStatePersistenceError);
        expect(collapsedGroupsState.read('partial-copy-first')).toBe(true);
        expect(() => saveLocalSettings({ ...localSettingsDefaults, themePreference: 'dark' })).toThrow();
        refusedSourceRead.mockRestore();
        replaceCollapsedGroupKeys({});
        loadLocalSettings();
        expect(collapsedGroupsState.read('partial-copy-first')).toBeUndefined();
        expect(collapsedGroupsState.read('partial-copy-refused')).toBeUndefined();
        expect(storage.getString('ui-state:collapsed-groups-v1:partial-copy-first')).toBeUndefined();
        expect(storage.getString('ui-state:collapsed-groups-v1:partial-copy-refused')).toBeUndefined();
    });

    it('migrates seeded disclosures without changing qualified keys or replacing current choices', () => {
        const storage = getPersistenceStorage();
        const qualified = 'connectedServices:["home","account","plugin","service","pool","group","member"]';
        storage.set(`ui-state:collapsed-groups-v1:${qualified}`, JSON.stringify(false));
        storage.set('local-settings', JSON.stringify({ themePreference: 'dark',
            collapsedGroupKeysV1: { [qualified]: true, 'sessionList:retained-context:group': true, 'bots:home:group': false },
            sessionInfoExpandedSectionsV1: { instructions: false, memory: true } }));
        loadLocalSettings();
        expect(JSON.parse(storage.getString(`ui-state:collapsed-groups-v1:${qualified}`)!)).toBe(false);
        expect(JSON.parse(storage.getString('ui-state:collapsed-groups-v1:sessionList:retained-context:group')!)).toBe(true);
        expect(JSON.parse(storage.getString('ui-state:collapsed-groups-v1:bots:home:group')!)).toBe(false);
        expect(JSON.parse(storage.getString('ui-state:session-info-disclosures-v1:instructions')!)).toBe(false);
        expect(JSON.parse(storage.getString('ui-state:session-info-disclosures-v1:memory')!)).toBe(true);
        expect(JSON.parse(storage.getString('local-settings')!)).toEqual({ themePreference: 'dark', ...initializedProjectNavigation });
        const writes = vi.spyOn(storage, 'set');
        loadLocalSettings();
        expect(writes).not.toHaveBeenCalled();
    });

    it('keeps legacy disclosures across a refused import and an unrelated preference save, then retries', () => {
        const storage = getPersistenceStorage();
        const raw = JSON.stringify({ collapsedGroupKeysV1: { 'migration-refused-group': true },
            sessionInfoExpandedSectionsV1: { about: true } });
        storage.set('local-settings', raw);
        const write = storage.set.bind(storage);
        const refusal = vi.spyOn(storage, 'set').mockImplementation((key, value) => {
            if (key.startsWith('ui-state:collapsed-groups-v1:')) throw new Error('device full');
            write(key, value);
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const loaded = loadLocalSettings();
        expect(JSON.parse(storage.getString('local-settings')!)).toEqual({ ...JSON.parse(raw), ...initializedProjectNavigation });
        saveLocalSettings({ ...loaded, themePreference: 'dark' });
        expect(JSON.parse(storage.getString('local-settings')!)).toMatchObject(JSON.parse(raw));
        refusal.mockRestore();
        loadLocalSettings();
        expect(JSON.parse(storage.getString('ui-state:collapsed-groups-v1:migration-refused-group')!)).toBe(true);
        expect(JSON.parse(storage.getString('ui-state:session-info-disclosures-v1:about')!)).toBe(true);
        expect(JSON.parse(storage.getString('local-settings')!)).not.toHaveProperty('collapsedGroupKeysV1');
    });
});


describe('Project phone placement initialization', () => {
    it('initializes an empty phone branch before a later desktop preference is saved', () => {
        const device = getPersistenceStorage();
        device.set('local-settings', JSON.stringify({ themePreference: 'dark' }));
        const initial = loadLocalSettings();
        expect(initial.navigationSurfacePlacementsV1.detailPages?.project?.phone?.items)
            .toEqual({ orderedIds: [], placements: {} });
        saveLocalSettings({ ...initial, navigationSurfacePlacementsV1: {
            ...initial.navigationSurfacePlacementsV1, projectTabBar: { orderedIds: ['changes'], placements: { changes: 'hidden' } },
        } });
        expect(loadLocalSettings().navigationSurfacePlacementsV1.detailPages?.project?.phone?.items)
            .toEqual({ orderedIds: [], placements: {} });
    });
    it('seeds once at load, normalizes aliases and preserves phone edits after desktop changes and reload', () => {
        const device = getPersistenceStorage();
        const desktop = { orderedIds: ['overview', 'git', 'browse', 'plugin:acme.tools:notes'],
            placements: { git: 'overflow', browse: 'hidden' } };
        device.set('local-settings', JSON.stringify({ navigationSurfacePlacementsV1: { projectTabBar: desktop } }));
        const initial = loadLocalSettings();
        expect(initial.navigationSurfacePlacementsV1.detailPages?.project?.phone?.items).toEqual({
            orderedIds: ['overview', 'changes', 'code', 'plugin:acme.tools:notes'], placements: { changes: 'overflow', code: 'hidden' } });
        const saved = JSON.parse(device.getString('local-settings')!);
        expect(saved.navigationSurfacePlacementsV1.projectTabBar).toEqual(desktop);
        const phone = { orderedIds: [], placements: {} };
        device.set('local-settings', JSON.stringify({ ...saved, navigationSurfacePlacementsV1: {
            ...saved.navigationSurfacePlacementsV1, projectTabBar: { orderedIds: ['memory'], placements: {} },
            detailPages: { project: { phone: { items: phone } } } } }));
        const writes = vi.spyOn(device, 'set');
        expect(loadLocalSettings().navigationSurfacePlacementsV1.detailPages?.project?.phone?.items).toEqual(phone);
        expect(writes).not.toHaveBeenCalled();
    });
});
