import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

function mockSettingsDomainPersistence(): void {
    vi.doMock('../../domains/state/persistence', () => ({
        loadSettings: vi.fn(() => ({
            settings: {
                preferredLanguage: 'en',
                groupInactiveSessionsByProject: false,
                sessionListActiveGroupingV1: 'project',
                sessionListInactiveGroupingV1: 'date',
            },
            version: 1,
        })),
        saveSettings: vi.fn(),
        loadLocalSettings: vi.fn(() => ({})),
        saveLocalSettings: vi.fn(),
        loadPurchases: vi.fn(() => ({})),
        savePurchases: vi.fn(),
        loadProfile: vi.fn(() => ({ id: 'account-a' })),
        saveProfile: vi.fn(),
        loadSessionDrafts: vi.fn(() => ({})),
        loadSessionLastViewed: vi.fn(() => ({})),
        loadSessionModelModeUpdatedAts: vi.fn(() => ({})),
        loadSessionModelModes: vi.fn(() => ({})),
        loadSessionPermissionModeUpdatedAts: vi.fn(() => ({})),
        loadSessionPermissionModes: vi.fn(() => ({})),
        loadSessionActionDrafts: vi.fn(() => ({})),
        loadSessionReviewCommentsDrafts: vi.fn(() => ({})),
        loadWorkspaceReviewCommentsDrafts: vi.fn(() => ({})),
        saveSessionDrafts: vi.fn(),
        saveSessionLastViewed: vi.fn(),
        saveSessionModelModeUpdatedAts: vi.fn(),
        saveSessionModelModes: vi.fn(),
        saveSessionPermissionModeUpdatedAts: vi.fn(),
        saveSessionPermissionModes: vi.fn(),
        saveSessionActionDrafts: vi.fn(),
        saveSessionReviewCommentsDrafts: vi.fn(),
        saveWorkspaceReviewCommentsDrafts: vi.fn(),
    }));
    vi.doMock('../../domains/state/accountSettingsPersistence', () => ({
        prepareAccountSettingsScopeForActivation: vi.fn(),
        loadAccountSettings: vi.fn(() => ({
            settings: {
                preferredLanguage: 'en',
                groupInactiveSessionsByProject: true,
                sessionListActiveGroupingV1: 'project',
                sessionListInactiveGroupingV1: 'date',
            },
            version: 2,
        })),
        saveAccountSettings: vi.fn(),
    }));
    vi.doMock('@/track', () => ({
        tracking: {
            capture: vi.fn(),
        },
    }));
}

describe('settings domain: sessionListIndexByServerId', () => {
    it('updates sessionListIndexByServerId for the active server when session-list settings change', async () => {
        mockSettingsDomainPersistence();
        vi.doMock('@/sync/domains/state/storageStore', () => ({
            storage: {
                getState: vi.fn(() => ({})),
                setState: vi.fn(),
            },
        }));
        vi.doMock('../../domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({ serverId: 'server-active', serverUrl: 'https://example.com', generation: 1 }),
        }));

        const { createSettingsDomain } = await import('./settings');

        type TestState = {
            settings: any;
            settingsVersion: number | null;
            localSettings: any;
            purchases: any;
            sessions: Record<string, any>;
            sessionListRenderables: Record<string, any>;
            sessionListRowStateByServerId: Record<string, any>;
            sessionListIndexByServerId: Record<string, any>;
            concurrentSessionListCacheByServerId: Record<string, any>;
            machines: Record<string, any>;
            machineDisplayById: Record<string, any>;
        };

        let state: any = {
            settings: {
                preferredLanguage: 'en',
                groupInactiveSessionsByProject: false,
                sessionListActiveGroupingV1: 'project',
                sessionListInactiveGroupingV1: 'date',
            },
            settingsVersion: 1,
            localSettings: {},
            purchases: {},
            sessions: {},
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    archivedAt: null,
                    metadataVersion: 1,
                    agentStateVersion: 0,
                    metadata: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                },
            },
            sessionListRowStateByServerId: {},
            sessionListIndexByServerId: {},
            concurrentSessionListCacheByServerId: {},
            machines: {},
            machineDisplayById: {},
        } satisfies Partial<TestState>;

        const set = (updater: any) => {
            const next = typeof updater === 'function' ? updater(state) : updater;
            state = { ...state, ...next };
        };
        const get = () => state;

        const domain = createSettingsDomain<any>({ set, get });
        state = { ...state, ...domain };

        state.applySettingsLocal({
            groupInactiveSessionsByProject: true,
        });

        expect(Array.isArray(state.sessionListIndexByServerId['server-active'])).toBe(true);
        expect(state.sessionListIndexByServerId['server-active']?.length ?? 0).toBeGreaterThan(0);
    });

    it('updates sessionListIndexByServerId for the active server when scope activation changes session-list settings', async () => {
        mockSettingsDomainPersistence();
        vi.doMock('@/sync/domains/state/storageStore', () => ({
            storage: {
                getState: vi.fn(() => ({})),
                setState: vi.fn(),
            },
        }));
        vi.doMock('../../domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({ serverId: 'server-active', serverUrl: 'https://example.com', generation: 1 }),
        }));

        const { createSettingsDomain } = await import('./settings');

        let state: any = {
            settings: {
                preferredLanguage: 'en',
                groupInactiveSessionsByProject: false,
                sessionListActiveGroupingV1: 'project',
                sessionListInactiveGroupingV1: 'date',
            },
            settingsVersion: 1,
            settingsScope: null,
            localSettings: {},
            purchases: {},
            sessions: {},
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    archivedAt: null,
                    metadataVersion: 1,
                    agentStateVersion: 0,
                    metadata: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                },
            },
            sessionListRowStateByServerId: {},
            sessionListIndexByServerId: {},
            concurrentSessionListCacheByServerId: {},
            machines: {},
            machineDisplayById: {},
        };

        const set = (updater: any) => {
            const next = typeof updater === 'function' ? updater(state) : updater;
            state = { ...state, ...next };
        };
        const get = () => state;

        const domain = createSettingsDomain<any>({ set, get });
        state = { ...state, ...domain };

        state.activateSettingsScope({ serverId: 'server-active', accountId: 'account-b' });

        expect(Array.isArray(state.sessionListIndexByServerId['server-active'])).toBe(true);
        expect(state.sessionListIndexByServerId['server-active']?.length ?? 0).toBeGreaterThan(0);
    });
});
