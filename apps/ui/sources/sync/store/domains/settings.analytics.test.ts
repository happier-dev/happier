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

vi.mock('@/sync/domains/state/persistence', () => ({
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
    savePendingSettings: vi.fn(),
    saveSessionMaterializedMaxSeqById: vi.fn(),
    saveChangesCursor: vi.fn(),
}));

vi.mock('@/sync/domains/settings/settings', () => ({
    applySettings: (settings: Record<string, unknown>, delta: Record<string, unknown>) => ({
        ...settings,
        ...delta,
    }),
}));

vi.mock('@/track', () => ({
    tracking: mocks.tracking,
}));

import { createSettingsDomain } from './settings';

describe('createSettingsDomain local settings analytics', () => {
    beforeEach(() => {
        mocks.saveLocalSettings.mockReset();
        mocks.savePurchases.mockReset();
        mocks.saveSettings.mockReset();
        mocks.tracking.capture.mockReset();
    });

    it('captures tracked local setting changes from the centralized local settings write path', () => {
        type TestState = ReturnType<typeof createState>;

        function createState() {
            return {
                sessions: {},
                machines: {},
                sessionListViewData: null,
                sessionListViewDataByServerId: {},
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
                setting_key: 'uiFontScaleBucket',
                scope: 'derived',
                identity_scope: 'device_user',
                source: 'ui',
                prev_value: 'default',
                next_value: 'xlarge',
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
    });
});
