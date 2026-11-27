import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearPersistence } from '@/sync/domains/state/persistence';
import { loadLocalSettings } from '@/sync/domains/state/settingsPersistence';
import { createSettingsDomain } from './settings';

const store = vi.hoisted(() => new Map<string, string>());
const mocks = vi.hoisted(() => ({ tracking: { capture: vi.fn(), flush: vi.fn(async () => {}) } }));

// MMKV and analytics are external boundaries; the settings domain and persistence owner are real.
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return store.get(key); }
        set(key: string, value: string) { store.set(key, value); }
        delete(key: string) { store.delete(key); }
        getAllKeys() { return [...store.keys()]; }
        clearAll() { store.clear(); }
    },
}));
vi.mock('@/track', () => ({ tracking: mocks.tracking, getTrackingAnonymousUserId: () => 'settings-analytics-test' }));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
        translateLoose: (key: string) => key,
        getPreferredLanguage: () => 'en',
    });
});

type SettingsDomainApi = ReturnType<typeof createSettingsDomain>;
type TestState = SettingsDomainApi & Readonly<{
    sessions: {};
    machines: {};
    machineDisplayById: {};
    sessionListRowsByServerId: {};
    sessionListIndexByServerId: {};
    concurrentSessionListCacheByServerId: {};
    machineListByServerId: {};
}>;

function createTestStore(): { getState: () => TestState } {
    let state = {
        sessions: {}, machines: {}, machineDisplayById: {}, sessionListRowsByServerId: {},
        sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {}, machineListByServerId: {},
    } as TestState;
    const set = (updater: ((current: TestState) => Partial<TestState> | TestState) | Partial<TestState>) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };
    state = { ...state, ...createSettingsDomain<TestState>({ set, get: () => state }) };
    return { getState: () => state };
}

describe('createSettingsDomain local settings analytics', () => {
    beforeEach(() => {
        clearPersistence();
        store.clear();
        mocks.tracking.capture.mockReset();
    });

    it('captures tracked local setting changes from the centralized local settings write path', async () => {
        const api = createTestStore();

        api.getState().applyLocalSettings({
            themePreference: 'dark',
            uiFontScale: 1.35,
            petsCompanionSizeScale: 1.5,
        }, { source: 'ui' });

        expect(loadLocalSettings()).toMatchObject({ themePreference: 'dark', uiFontScale: 1.35, petsCompanionSizeScale: 1.5 });
        expect(mocks.tracking.capture).toHaveBeenCalledWith(
            'setting_changed',
            expect.objectContaining({
                setting_key: 'themePreference',
                scope: 'local_setting',
                identity_scope: 'device_user',
                source: 'ui',
                prev_value: 'adaptive',
                next_value: 'dark',
            }),
        );
        expect(mocks.tracking.capture).toHaveBeenCalledWith(
            'setting_changed',
            expect.objectContaining({
                setting_key: 'petsCompanionSizeScale',
                scope: 'local_setting',
                identity_scope: 'device_user',
                source: 'ui',
                prev_value: 'default',
                next_value: 'xlarge',
            }),
        );
        expect(mocks.tracking.capture).toHaveBeenCalledTimes(2);
    });

    it('skips local setting persistence and analytics when the normalized value is unchanged', async () => {
        const api = createTestStore();
        const previousLocalSettings = api.getState().localSettings;
        const persistedBefore = new Map(store);

        api.getState().applyLocalSettings({
        }, { source: 'ui' });

        expect(api.getState().localSettings).toBe(previousLocalSettings);
        expect(store).toEqual(persistedBefore);
        expect(mocks.tracking.capture).not.toHaveBeenCalled();
    });

    it('skips account setting persistence when a direct local delta is unchanged', async () => {
        const api = createTestStore();
        const previousSettings = api.getState().settings;
        const persistedBefore = new Map(store);

        api.getState().applySettingsLocal({
            experiments: api.getState().settings.experiments,
        });

        expect(api.getState().settings).toBe(previousSettings);
        expect(store).toEqual(persistedBefore);
    });

    it('normalizes legacy iOS activity-surface keys onto canonical local settings before analytics emission', async () => {
        const api = createTestStore();

        api.getState().applyLocalSettings({
            iosLiveActivitiesEnabled: false,
            iosWidgetsEnabled: false,
            homeScreenWidgetsMode: 'running',
        }, { source: 'ui' });

        expect(api.getState().localSettings.liveActivitiesEnabled).toBe(false);
        expect(api.getState().localSettings.iosLiveActivitiesEnabled).toBe(false);
        expect(api.getState().localSettings.widgetsEnabled).toBe(false);
        expect(api.getState().localSettings.iosWidgetsEnabled).toBe(false);
        expect(api.getState().localSettings.widgetsPresetMode).toBe('running');
        expect(api.getState().localSettings.homeScreenWidgetsMode).toBe('running');
        expect(mocks.tracking.capture).toHaveBeenCalledWith(
            'setting_changed',
            expect.objectContaining({
                setting_key: 'liveActivitiesEnabled',
                scope: 'local_setting',
                identity_scope: 'device_user',
                source: 'ui',
                prev_value: true,
                next_value: false,
            }),
        );
        expect(mocks.tracking.capture).toHaveBeenCalledWith(
            'setting_changed',
            expect.objectContaining({
                setting_key: 'widgetsEnabled',
                scope: 'local_setting',
                identity_scope: 'device_user',
                source: 'ui',
                prev_value: true,
                next_value: false,
            }),
        );
        expect(mocks.tracking.capture).toHaveBeenCalledWith(
            'setting_changed',
            expect.objectContaining({
                setting_key: 'widgetsPresetMode',
                scope: 'local_setting',
                identity_scope: 'device_user',
                source: 'ui',
                prev_value: 'summary',
                next_value: 'running',
            }),
        );
        expect(mocks.tracking.capture).toHaveBeenCalledTimes(3);
    });
});
