import { beforeEach, describe, expect, it, vi } from 'vitest';

import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';

const mocks = vi.hoisted(() => ({
    saveLocalSettings: vi.fn(),
    savePurchases: vi.fn(),
    saveSettings: vi.fn(),
    tracking: {
        capture: vi.fn(),
    },
}));

const storageStoreStub = {
    storage: {
        getState: () => ({}),
        setState: () => {},
        subscribe: () => () => {},
    },
    getStorage: () => ({}),
};

vi.mock('../../domains/state/storageStore', () => storageStoreStub);
vi.mock('@/sync/domains/state/storageStore', () => storageStoreStub);

vi.mock('../../domains/state/settingsPersistence', () => ({
    loadSettings: () => ({
        settings: {
            analyticsOptOut: false,
            crashReportsOptOut: false,
            experiments: true,
            sessionListDensity: 'comfortable',
        },
        version: 1,
    }),
    loadLocalSettings: () => ({ ...localSettingsDefaults }),
    loadPurchases: () => ({}),
    loadProfile: () => ({
        id: '',
        timestamp: 0,
        firstName: null,
        lastName: null,
        username: null,
        avatar: null,
        linkedProviders: [],
        connectedServices: [],
        connectedServicesV2: [],
        connectedServiceCredentialRevisionsV1: [],
    }),
    saveLocalSettings: mocks.saveLocalSettings,
    savePurchases: mocks.savePurchases,
    saveSettings: mocks.saveSettings,
    saveProfile: vi.fn(),
    loadSessionDrafts: () => ({}),
    loadSessionLastViewed: () => ({}),
    loadSessionModelModeUpdatedAts: () => ({}),
    loadSessionModelModes: () => ({}),
    loadSessionPermissionModeUpdatedAts: () => ({}),
    loadSessionPermissionModes: () => ({}),
    loadSessionActionDrafts: () => ({}),
    loadSessionReviewCommentsDrafts: () => ({}),
    loadWorkspaceReviewCommentsDrafts: () => ({}),
    loadPendingSettings: () => ({}),
    loadSessionMaterializedMaxSeqById: () => ({}),
    loadChangesCursor: () => null,
    saveSessionDrafts: vi.fn(),
    saveSessionLastViewed: vi.fn(),
    saveSessionModelModeUpdatedAts: vi.fn(),
    saveSessionModelModes: vi.fn(),
    saveSessionPermissionModeUpdatedAts: vi.fn(),
    saveSessionPermissionModes: vi.fn(),
    saveSessionActionDrafts: vi.fn(),
    saveSessionReviewCommentsDrafts: vi.fn(),
    saveWorkspaceReviewCommentsDrafts: vi.fn(),
    savePendingSettings: vi.fn(),
    saveSessionMaterializedMaxSeqById: vi.fn(),
    saveChangesCursor: vi.fn(),
}));

vi.mock('@/track', () => ({
    tracking: mocks.tracking,
}));

describe('createSettingsDomain local settings analytics', () => {
    beforeEach(() => {
        mocks.saveLocalSettings.mockReset();
        mocks.savePurchases.mockReset();
        mocks.saveSettings.mockReset();
        mocks.tracking.capture.mockReset();
    });

    it('captures tracked local setting changes from the centralized local settings write path', async () => {
        const { createSettingsDomain } = await import('./settings');
        type TestState = ReturnType<typeof createState>;

        function createState() {
            return {
                sessions: {},
                machines: {},
                machineDisplayById: {},
                sessionListRenderables: {},
                sessionListRowStateByServerId: {},
                sessionListIndexByServerId: {},
                concurrentSessionListCacheByServerId: {},
                machineListByServerId: {},
                machineListStatusByServerId: {},
            };
        }

        let state: TestState & ReturnType<typeof createSettingsDomain> = {
            ...(createState() as TestState),
        } as TestState & ReturnType<typeof createSettingsDomain>;
        const set = (updater: any) => {
            const next = typeof updater === 'function' ? updater(state) : updater;
            state = { ...state, ...next };
        };
        const get = () => state as any;

        const domain = createSettingsDomain<TestState & ReturnType<typeof createSettingsDomain>>({ set: set as any, get });
        state = { ...state, ...domain };

        state.applyLocalSettings({
            themePreference: 'dark',
            uiFontScale: 1.35,
            sidebarWidthPx: 220,
            sidebarWidthBasisPx: 1_200,
            acknowledgedCliVersions: {
                'machine-a': '1.2.3',
            },
        }, { source: 'ui' });

        expect(mocks.saveLocalSettings).toHaveBeenCalledTimes(1);
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
                setting_key: 'sidebarWidthPx',
                scope: 'local_setting',
                identity_scope: 'device_user',
                source: 'ui',
                prev_value: 'medium',
                next_value: 'small',
            }),
        );
        expect(mocks.tracking.capture).toHaveBeenCalledWith(
            'setting_changed',
            expect.objectContaining({
                setting_key: 'acknowledgedCliVersions',
                scope: 'local_setting',
                identity_scope: 'device_user',
                source: 'ui',
                prev_value: 0,
                next_value: 1,
            }),
        );
        expect(mocks.tracking.capture).toHaveBeenCalledTimes(3);
    });

    it('skips local setting persistence and analytics when the normalized value is unchanged', async () => {
        const { createSettingsDomain } = await import('./settings');
        type TestState = ReturnType<typeof createState>;

        function createState() {
            return {
                sessions: {},
                machines: {},
                machineDisplayById: {},
                sessionListRenderables: {},
                sessionListRowStateByServerId: {},
                sessionListIndexByServerId: {},
                concurrentSessionListCacheByServerId: {},
                machineListByServerId: {},
                machineListStatusByServerId: {},
            };
        }

        let state: TestState & ReturnType<typeof createSettingsDomain> = {
            ...(createState() as TestState),
        } as TestState & ReturnType<typeof createSettingsDomain>;
        const set = (updater: any) => {
            const next = typeof updater === 'function' ? updater(state) : updater;
            state = { ...state, ...next };
        };
        const get = () => state as any;

        const domain = createSettingsDomain<TestState & ReturnType<typeof createSettingsDomain>>({ set: set as any, get });
        state = { ...state, ...domain };
        const previousLocalSettings = state.localSettings;

        state.applyLocalSettings({
            appPaneScopesV1: {},
        }, { source: 'ui' });

        expect(state.localSettings).toBe(previousLocalSettings);
        expect(mocks.saveLocalSettings).not.toHaveBeenCalled();
        expect(mocks.tracking.capture).not.toHaveBeenCalled();
    });

    it('skips account setting persistence when a direct local delta is unchanged', async () => {
        const { createSettingsDomain } = await import('./settings');
        type TestState = ReturnType<typeof createState>;

        function createState() {
            return {
                sessions: {},
                machines: {},
                machineDisplayById: {},
                sessionListRenderables: {},
                sessionListRowStateByServerId: {},
                sessionListIndexByServerId: {},
                concurrentSessionListCacheByServerId: {},
                machineListByServerId: {},
                machineListStatusByServerId: {},
            };
        }

        let state: TestState & ReturnType<typeof createSettingsDomain> = {
            ...(createState() as TestState),
        } as TestState & ReturnType<typeof createSettingsDomain>;
        const set = (updater: any) => {
            const next = typeof updater === 'function' ? updater(state) : updater;
            state = { ...state, ...next };
        };
        const get = () => state as any;

        const domain = createSettingsDomain<TestState & ReturnType<typeof createSettingsDomain>>({ set: set as any, get });
        state = { ...state, ...domain };
        const previousSettings = state.settings;

        state.applySettingsLocal({
            experiments: state.settings.experiments,
        });

        expect(state.settings).toBe(previousSettings);
        expect(mocks.saveSettings).not.toHaveBeenCalled();
    });

    it('normalizes legacy iOS activity-surface keys onto canonical local settings before analytics emission', async () => {
        const { createSettingsDomain } = await import('./settings');
        type TestState = ReturnType<typeof createState>;

        function createState() {
            return {
                sessions: {},
                machines: {},
                machineDisplayById: {},
                sessionListRenderables: {},
                sessionListRowStateByServerId: {},
                sessionListIndexByServerId: {},
                concurrentSessionListCacheByServerId: {},
                machineListByServerId: {},
                machineListStatusByServerId: {},
            };
        }

        let state: TestState & ReturnType<typeof createSettingsDomain> = {
            ...(createState() as TestState),
        } as TestState & ReturnType<typeof createSettingsDomain>;
        const set = (updater: any) => {
            const next = typeof updater === 'function' ? updater(state) : updater;
            state = { ...state, ...next };
        };
        const get = () => state as any;

        const domain = createSettingsDomain<TestState & ReturnType<typeof createSettingsDomain>>({ set: set as any, get });
        state = { ...state, ...domain };

        state.applyLocalSettings({
            iosLiveActivitiesEnabled: false,
            iosWidgetsEnabled: false,
            homeScreenWidgetsMode: 'running',
        }, { source: 'ui' });

        expect(state.localSettings.liveActivitiesEnabled).toBe(false);
        expect(state.localSettings.iosLiveActivitiesEnabled).toBe(false);
        expect(state.localSettings.widgetsEnabled).toBe(false);
        expect(state.localSettings.iosWidgetsEnabled).toBe(false);
        expect(state.localSettings.widgetsPresetMode).toBe('running');
        expect(state.localSettings.homeScreenWidgetsMode).toBe('running');
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
