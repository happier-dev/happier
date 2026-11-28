import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPersistenceStorage, getPersistenceStorage } from './persistenceStorage';
import { loadLocalSettings, saveLocalSettings } from './settingsPersistence';
import { collapsedGroupsState, removeCollapsedGroupKey, replaceCollapsedGroupKeys } from './disclosureUiState';
import { UiStatePersistenceError } from './persistentUiState';
import { paneGeometryDefaults, readPaneGeometry, writePaneGeometry } from './paneGeometryUiState';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';

afterEach(() => { vi.restoreAllMocks(); clearPersistenceStorage(); });


describe('retained workspace settings migration', () => {
    it('imports a chosen pane width from predecessor Settings once and keeps the newer UI-state value', () => {
        const device = getPersistenceStorage();
        const destination = 'ui-state:pane-geometry-v1:sidebarWidthPx';
        device.set('local-settings', JSON.stringify({ sidebarWidthPx: 410, sidebarWidthBasisPx: 1200, themePreference: 'dark' }));

        expect(loadLocalSettings().themePreference).toBe('dark');
        expect(device.getString(destination)).toBe('410');
        expect(JSON.parse(device.getString('local-settings')!)).toEqual({ themePreference: 'dark' });

        device.set(destination, '480');
        device.set('local-settings', JSON.stringify({ sidebarWidthPx: 365 }));
        loadLocalSettings();
        expect(device.getString(destination)).toBe('480');
        expect(JSON.parse(device.getString('local-settings')!)).toEqual({});
    });

    it.each([
        ['sidebarWidthPx', 'sidebarWidthBasisPx', 320, 1200],
        ['rightPaneWidthPx', 'rightPaneWidthBasisPx', 340, 1200],
        ['detailsPaneWidthPx', 'detailsPaneWidthBasisPx', 520, 1200],
        ['bottomPaneHeightPx', 'bottomPaneHeightBasisPx', 320, 900],
        ['settingsNavSidebarWidthPx', 'settingsNavSidebarWidthBasisPx', 280, 1200],
    ] as const)('imports literal %s widths and maps scaled defaults', (key, basisKey, defaultPixels, basis) => {
        const device = getPersistenceStorage();
        device.set('local-settings', JSON.stringify({ [key]: defaultPixels, [basisKey]: basis }));
        loadLocalSettings();
        expect(readPaneGeometry(key)).toBe(paneGeometryDefaults[key]);

        device.set('local-settings', JSON.stringify({ [key]: defaultPixels, [basisKey]: basis * 2 }));
        loadLocalSettings();
        expect(readPaneGeometry(key)).toBe(defaultPixels);
    });

    it('does not touch the local Settings blob when committing a pane width', () => {
        const device = getPersistenceStorage();
        const settings = JSON.stringify({ themePreference: 'dark' });
        device.set('local-settings', settings);
        const write = vi.spyOn(device, 'set');
        const read = vi.spyOn(device, 'getString');

        writePaneGeometry('sidebarWidthPx', 425);
        writePaneGeometry('sidebarWidthPx', 425);

        expect(write.mock.calls).toEqual([['ui-state:pane-geometry-v1:sidebarWidthPx', '425']]);
        expect(read.mock.calls.every(([key]) => key === 'ui-state:pane-geometry-v1:sidebarWidthPx')).toBe(true);
    });

    it('imports the retained phone tab once without replacing a newer navigation choice', () => {
        const device = getPersistenceStorage();
        const destinationKey = 'ui-state:main-app-tab-v1:active';
        device.set('local-settings', JSON.stringify({ mainAppTab: 'projects', themePreference: 'dark' }));
        expect(loadLocalSettings().themePreference).toBe('dark');
        expect(device.getString(destinationKey)).toBe('"projects"');
        expect(JSON.parse(device.getString('local-settings')!)).toEqual({ themePreference: 'dark' });
        device.set('local-settings', JSON.stringify({ mainAppTab: 'inbox' }));
        loadLocalSettings();
        expect(device.getString(destinationKey)).toBe('"projects"');
        expect(loadLocalSettings()).not.toHaveProperty('mainAppTab');
    });

    it('keeps the phone tab source through a refused import and preference save, then recovers', () => {
        const device = getPersistenceStorage();
        const destinationKey = 'ui-state:main-app-tab-v1:active';
        device.set('local-settings', JSON.stringify({ mainAppTab: 'inbox' }));
        const write = device.set.bind(device);
        const refusal = vi.spyOn(device, 'set').mockImplementation((key, value) => {
            if (key === destinationKey) throw new Error('Device storage refused');
            write(key, value);
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        saveLocalSettings({ ...loadLocalSettings(), themePreference: 'dark' });
        expect(JSON.parse(device.getString('local-settings')!)).toMatchObject({ mainAppTab: 'inbox', themePreference: 'dark' });
        refusal.mockRestore();
        loadLocalSettings();
        expect(device.getString(destinationKey)).toBe('"inbox"');
        expect(JSON.parse(device.getString('local-settings')!)).not.toHaveProperty('mainAppTab');
        expect(loadLocalSettings().themePreference).toBe('dark');
    });

    it.each(['settings', 'friends', 'zen', 'workflows'])('imports the retired %s phone tab as Sessions', tab => {
        const device = getPersistenceStorage();
        device.set('local-settings', JSON.stringify({ mainAppTab: tab }));
        loadLocalSettings();
        expect(device.getString('ui-state:main-app-tab-v1:active')).toBe('"sessions"');
    });

    it('does not import never-shipped settings history or write UI state while loading it', () => {
        const device = getPersistenceStorage();
        device.set('local-settings', JSON.stringify({
            themePreference: 'dark',
            machinesRailSeenV1: { look: {}, guardSeenAt: 100 },
            workspaceLayoutV1: { workspace: { v: 1 } },
            terminalNativeRendererQuarantine: { renderer: 'ios-ghosttykit', expiresAtMs: 1_700_086_400_000 },
            machineVitalsRangeV1: '7d',
            personalizeProgressV1: { savedSteps: ['look'], resumeAt: 'work' },
            homeWelcomeSeenAt: 1_700_000_000_002,
        }));
        const writes = vi.spyOn(device, 'set');
        expect(loadLocalSettings().themePreference).toBe('dark');
        expect(writes.mock.calls.filter(([key]) => key.startsWith('ui-state:'))).toHaveLength(0);
        saveLocalSettings({ ...loadLocalSettings(), themePreference: 'light' });
        const saved = JSON.parse(device.getString('local-settings')!);
        for (const key of ['machinesRailSeenV1', 'workspaceLayoutV1', 'terminalNativeRendererQuarantine',
            'machineVitalsRangeV1', 'personalizeProgressV1', 'homeWelcomeSeenAt']) expect(saved).not.toHaveProperty(key);
        expect(loadLocalSettings().themePreference).toBe('light');
    });

    it('moves companion geometry to device UI state once and lets an existing destination win', () => {
        const device = getPersistenceStorage();
        const position = { schemaVersion: 1, surface: 'mobile-app-shell', normalizedX: 0.21, normalizedY: 0.67,
            lastViewport: { width: 390, height: 844, margin: 12, keyboardHeight: 0,
                safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 } } };
        const destinationKey = 'ui-state:pet-companion-position-v1:mobile-app-shell';
        device.set('local-settings', JSON.stringify({ petsCompanionPosition: position, themePreference: 'dark' }));
        loadLocalSettings();
        expect(JSON.parse(device.getString(destinationKey)!)).toEqual(position);
        expect(JSON.parse(device.getString('local-settings')!)).toEqual({ themePreference: 'dark' });
        const writes = vi.spyOn(device, 'set');
        loadLocalSettings();
        expect(writes).not.toHaveBeenCalled();
        writes.mockRestore();
        device.set('local-settings', JSON.stringify({ petsCompanionPosition: { ...position, normalizedX: 0.9 } }));
        loadLocalSettings();
        expect(JSON.parse(device.getString(destinationKey)!)).toEqual(position);
        expect(JSON.parse(device.getString('local-settings')!)).not.toHaveProperty('petsCompanionPosition');
    });

    it('keeps companion position source on destination refusal across preference saves and imports on recovery', () => {
        const device = getPersistenceStorage();
        const position = { schemaVersion: 1, surface: 'mobile-app-shell', normalizedX: 0.21, normalizedY: 0.67, lastViewport: null };
        const destinationKey = 'ui-state:pet-companion-position-v1:mobile-app-shell';
        device.set('local-settings', JSON.stringify({ petsCompanionPosition: position }));
        const write = device.set.bind(device);
        const refusal = vi.spyOn(device, 'set').mockImplementation((key, value) => {
            if (key === destinationKey) throw new Error('Device storage refused');
            write(key, value);
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const loaded = loadLocalSettings();
        expect(device.getString(destinationKey)).toBeUndefined();
        saveLocalSettings({ ...loaded, themePreference: 'dark' });
        expect(JSON.parse(device.getString('local-settings')!)).toMatchObject({ petsCompanionPosition: position, themePreference: 'dark' });
        refusal.mockRestore();
        loadLocalSettings();
        expect(JSON.parse(device.getString(destinationKey)!)).toEqual(position);
        expect(JSON.parse(device.getString('local-settings')!)).not.toHaveProperty('petsCompanionPosition');
    });

    it('retains opaque companion geometry instead of replacing it with a default during import', () => {
        const device = getPersistenceStorage();
        const opaque = { schemaVersion: 2, coordinates: [10, 20] };
        device.set('local-settings', JSON.stringify({ petsCompanionPosition: opaque, themePreference: 'dark' }));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        loadLocalSettings();
        saveLocalSettings({ ...localSettingsDefaults, themePreference: 'light' });
        expect(JSON.parse(device.getString('local-settings')!)).toMatchObject({ petsCompanionPosition: opaque, themePreference: 'light' });
        expect(device.getString('ui-state:pet-companion-position-v1:mobile-app-shell')).toBeUndefined();
    });

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
        expect(JSON.parse(device.getString('local-settings')!)).toEqual({ brandHeroSeenAt: opaqueHistory, themePreference: 'dark' });
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
            collapsedGroupKeysV1: { [qualified]: true, 'sessionList:retained-context:group': true, 'bots:home:group': false } }));
        loadLocalSettings();
        expect(JSON.parse(storage.getString(`ui-state:collapsed-groups-v1:${qualified}`)!)).toBe(false);
        expect(JSON.parse(storage.getString('ui-state:collapsed-groups-v1:sessionList:retained-context:group')!)).toBe(true);
        expect(JSON.parse(storage.getString('ui-state:collapsed-groups-v1:bots:home:group')!)).toBe(false);
        expect(JSON.parse(storage.getString('local-settings')!)).toEqual({ themePreference: 'dark' });
        const writes = vi.spyOn(storage, 'set');
        loadLocalSettings();
        expect(writes).not.toHaveBeenCalled();
    });

    it('keeps legacy disclosures across a refused import and an unrelated preference save, then retries', () => {
        const storage = getPersistenceStorage();
        const raw = JSON.stringify({ collapsedGroupKeysV1: { 'migration-refused-group': true } });
        storage.set('local-settings', raw);
        const write = storage.set.bind(storage);
        const refusal = vi.spyOn(storage, 'set').mockImplementation((key, value) => {
            if (key.startsWith('ui-state:collapsed-groups-v1:')) throw new Error('device full');
            write(key, value);
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const loaded = loadLocalSettings();
        expect(JSON.parse(storage.getString('local-settings')!)).toEqual({ ...JSON.parse(raw) });
        saveLocalSettings({ ...loaded, themePreference: 'dark' });
        expect(JSON.parse(storage.getString('local-settings')!)).toMatchObject(JSON.parse(raw));
        refusal.mockRestore();
        loadLocalSettings();
        expect(JSON.parse(storage.getString('ui-state:collapsed-groups-v1:migration-refused-group')!)).toBe(true);
        expect(JSON.parse(storage.getString('local-settings')!)).not.toHaveProperty('collapsedGroupKeysV1');
    });

});
