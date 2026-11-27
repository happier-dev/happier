import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    tracking: {
        capture: vi.fn(),
        identify: vi.fn(),
        flush: vi.fn(() => Promise.resolve()),
    },
}));

vi.mock('@/track', () => ({
    tracking: mocks.tracking,
    getTrackingAnonymousUserId: () => 'anon-user',
}));

import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';

import { buildAccountSettingsSnapshot } from './buildAccountSettingsSnapshot';
import { buildLocalSettingsSnapshot } from './buildLocalSettingsSnapshot';
import { emitAccountSettingChangedEvents, emitLocalSettingChangedEvents } from './emitSettingChangedEvent';

// UI state the app writes as people navigate (MRU order, collapse, tab, pane drags, last-used
// selections, dismissals) is not a deliberate setting: it is neither a person/group property nor a
// setting_changed event.
const LOCAL_UI_STATE: Partial<LocalSettings> = {
    sessionMruOrderV1: ['srv:s1', 'srv:s2'],
    collapsedGroupKeysV1: { a: true },
    sidebarCollapsed: true,
    sidebarWidthPx: 220,
    rightPaneWidthPx: 200,
    detailsPaneWidthPx: 900,
    bottomPaneHeightPx: 100,
    sessionsListStorageTab: 'direct',
    sessionLastMobileSurfaceBySessionId: { 'srv:s1': 'git' },
    sessionComposerCollapsedBannerKinds: { usage: true },
    acknowledgedCliVersions: { m1: '1.2.3' },
};

const ACCOUNT_UI_STATE: Partial<Settings> = {
    recentMachinePaths: [{ machineId: 'm1', path: '/repo' }],
    dismissedCLIWarnings: { global: { upgrade: true }, perMachine: {} },
    lastUsedProfile: 'work',
    lastEngineSelectionsByScopeV1: {
        'srv:claude': { modelId: 'opus' },
    } as unknown as Settings['lastEngineSelectionsByScopeV1'],
    contextSelectionsV1: { v: 1, selectionsByKey: { one: { machineId: 'm1', workspacePath: '/repo' } } },
    connectedServicesCollapsedItemKeysV1: { 'claude:account:p1': true } as unknown as Settings['connectedServicesCollapsedItemKeysV1'],
    connectedServicesDefaultAuthPoolAdoptionDismissedByKey: { 'claude:svc:g1': true } as unknown as Settings['connectedServicesDefaultAuthPoolAdoptionDismissedByKey'],
};

function propertyNamesFor(properties: Record<string, unknown>, prefix: string, keys: readonly string[]): string[] {
    return Object.keys(properties).filter((name) => keys.some((key) => name === `${prefix}${key}` || name.startsWith(`${prefix}${key}__`)));
}

describe('UI-state settings are not analytics settings', () => {
    beforeEach(() => {
        mocks.tracking.capture.mockReset();
        mocks.tracking.identify.mockReset();
    });

    it('leaves local UI state out of the device_user snapshot', () => {
        const snapshot = buildLocalSettingsSnapshot({ ...localSettingsDefaults, ...LOCAL_UI_STATE });

        expect(propertyNamesFor(snapshot.properties, 'local_setting__', Object.keys(LOCAL_UI_STATE))).toEqual([]);
        expect(snapshot.properties.local_setting__themePreference).toBeDefined();
    });

    it('leaves account UI state out of the person snapshot', () => {
        const snapshot = buildAccountSettingsSnapshot({ ...settingsDefaults, ...ACCOUNT_UI_STATE } as Settings);

        expect(propertyNamesFor(snapshot.properties, 'acct_setting__', Object.keys(ACCOUNT_UI_STATE))).toEqual([]);
        expect(snapshot.properties.acct_setting__favoriteDirectories).toBeDefined();
    });

    it('sends 0 setting_changed events for local UI state and 1 for a deliberate local setting', () => {
        emitLocalSettingChangedEvents({
            previousSettings: localSettingsDefaults,
            nextSettings: { ...localSettingsDefaults, ...LOCAL_UI_STATE },
            source: 'ui',
        });
        expect(mocks.tracking.capture).toHaveBeenCalledTimes(0);

        emitLocalSettingChangedEvents({
            previousSettings: localSettingsDefaults,
            nextSettings: { ...localSettingsDefaults, themePreference: 'dark' },
            source: 'ui',
        });
        expect(mocks.tracking.capture).toHaveBeenCalledTimes(1);
        expect(mocks.tracking.capture).toHaveBeenCalledWith('setting_changed', expect.objectContaining({ setting_key: 'themePreference' }));
    });

    it('sends 0 setting_changed events for account UI state', () => {
        emitAccountSettingChangedEvents({
            previousSettings: settingsDefaults,
            nextSettings: { ...settingsDefaults, ...ACCOUNT_UI_STATE } as Settings,
            source: 'ui',
        });

        expect(mocks.tracking.capture).toHaveBeenCalledTimes(0);
    });
});
