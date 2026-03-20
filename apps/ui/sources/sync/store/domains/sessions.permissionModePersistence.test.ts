import { beforeEach, describe, expect, it, vi } from 'vitest';

const persistedPermissionModes = vi.hoisted(() => new Map<string, string>());
const persistedPermissionModeUpdatedAts = vi.hoisted(() => new Map<string, number>());

vi.mock('../../domains/state/persistence', () => ({
    loadSessionDrafts: () => ({}),
    loadSessionLastViewed: () => ({}),
    loadSessionModelModeUpdatedAts: () => ({}),
    loadSessionModelModes: () => ({}),
    loadSessionPermissionModeUpdatedAts: () => Object.fromEntries(persistedPermissionModeUpdatedAts.entries()),
    loadSessionPermissionModes: () => Object.fromEntries(persistedPermissionModes.entries()),
    loadSessionActionDrafts: () => ({}),
    loadSessionReviewCommentsDrafts: () => ({}),
    saveSessionDrafts: () => {},
    saveSessionLastViewed: () => {},
    saveSessionModelModeUpdatedAts: () => {},
    saveSessionModelModes: () => {},
    saveSessionPermissionModeUpdatedAts: (updatedAts: Record<string, number>) => {
        persistedPermissionModeUpdatedAts.clear();
        for (const [k, v] of Object.entries(updatedAts)) {
            if (typeof v === 'number') persistedPermissionModeUpdatedAts.set(k, v);
        }
    },
    saveSessionPermissionModes: (modes: Record<string, string>) => {
        persistedPermissionModes.clear();
        for (const [k, v] of Object.entries(modes)) {
            if (typeof v === 'string') persistedPermissionModes.set(k, v);
        }
    },
    saveSessionActionDrafts: () => {},
    saveSessionReviewCommentsDrafts: () => {},
}));

vi.mock('../../domains/state/warmCachePersistence', () => ({
    resolveWarmCacheAccountScope: () => null,
    saveSessionListWarmCacheEntries: () => {},
}));

vi.mock('../../domains/state/warmCacheAdapters', () => ({
    buildSessionListCacheEntriesFromRenderables: () => [],
}));

vi.mock('./messages', () => ({
    applyAgentStateUpdateToSessionMessages: () => ({}),
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    storage: {
        getState: () => ({ sessions: {}, sessionMessages: {}, machines: {}, settings: {} }),
        setState: () => {},
    },
    getStorage: () => ({
        getState: () => ({ sessions: {}, sessionMessages: {}, machines: {}, settings: {} }),
        setState: () => {},
    }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({ sessions: {}, sessionMessages: {}, machines: {}, settings: {} }),
        setState: () => {},
    },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSessionVisibleForMessageRoute: async () => true,
    },
}));

// SessionsDomain pulls in heavy runtime orchestration via projectManager during module init,
// which transitively instantiates the global storage store (and can trigger import cycles in unit tests).
// This test only exercises local permission-mode merge logic, so stub those deps.
vi.mock('../../runtime/orchestration/projectManager', () => ({
    projectManager: {
        getProjects: () => [],
        getProject: () => null,
        getProjectForSession: () => null,
        getProjectSessions: () => [],
        getProjectScmStatus: () => null,
        getSessionProjectScmStatus: () => null,
        updateSessionProjectScmStatus: () => {},
        getProjectScmSnapshot: () => null,
        getProjectScmSnapshotError: () => null,
        getSessionProjectScmSnapshot: () => null,
        getSessionProjectScmSnapshotError: () => null,
        updateSessionProjectScmSnapshot: () => {},
        updateSessionProjectScmSnapshotError: () => {},
        getSessionProjectScmTouchedPaths: () => [],
        clearSessionProjectScmTouchedPaths: () => {},
        touchSessionProjectScmPaths: () => {},
        clearScmOperationLogEntriesForSessionId: () => {},
        getScmOperationLogEntriesForProjectId: () => [],
        getScmInFlightOperationsForProjectId: () => [],
        beginScmOperation: () => ({ ok: false, error: 'stub' }),
        endScmOperation: () => {},
        abortScmOperation: () => {},
        setGroupInactiveSessionsByProject: () => {},
        updateSession: () => {},
        updateSessions: () => {},
        deleteSession: () => {},
        updateSessionListRenderables: () => {},
        updateSessionListViewData: () => {},
    },
}));

vi.mock('../buildSessionListViewDataWithServerScope', () => ({
    buildSessionListViewDataWithServerScope: () => [],
}));

vi.mock('../sessionListCache', () => ({
    setActiveServerSessionListCache: () => {},
}));

vi.mock('../../domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server_1' }),
}));

import { createSessionsDomain } from './sessions';

function createHarness() {
    let state: any = {
        sessions: {},
        sessionsData: null,
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed: {},
        isDataReady: false,
        machines: {},
        sessionMessages: {},
        settings: { groupInactiveSessionsByProject: false },
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createSessionsDomain({ get, set } as any);
    return { get, domain };
}

describe('sessions domain: permissionMode persistence + hydration merge', () => {
    beforeEach(() => {
        persistedPermissionModes.clear();
        persistedPermissionModeUpdatedAts.clear();
        vi.restoreAllMocks();
    });

    it('persists explicit resets to default and prefers newer persisted mode over older metadata inference', () => {
        vi.spyOn(Date, 'now').mockReturnValue(5000);

        const { domain: domainA } = createHarness();
        domainA.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: {
                    permissionMode: 'yolo',
                    permissionModeUpdatedAt: 1000,
                },
            } as any,
        ]);
        domainA.updateSessionPermissionMode('s1', 'default');

        const { get: getB, domain: domainB } = createHarness();
        domainB.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                // Simulate a stale non-default mode coming from an upstream hydrate.
                permissionMode: 'yolo',
                permissionModeUpdatedAt: 1000,
                metadata: {
                    permissionMode: 'yolo',
                    permissionModeUpdatedAt: 1000,
                },
            } as any,
        ]);

        expect(getB().sessions.s1.permissionMode).toBe('default');
        expect(getB().sessions.s1.permissionModeUpdatedAt).toBe(5000);
    });

    it('applies persisted permission overrides for sessions that arrive after bootstrap (late hydration)', () => {
        vi.spyOn(Date, 'now').mockReturnValue(7000);

        const { domain: domainA } = createHarness();
        domainA.applySessions([
            {
                id: 's_persisted',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: null,
            } as any,
        ]);
        domainA.updateSessionPermissionMode('s_persisted', 'read-only');

        const { get: getB, domain: domainB } = createHarness();
        domainB.applySessions([
            {
                id: 's_other',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: null,
            } as any,
        ]);

        // The persisted permission mode should still be consulted, even though state.sessions is non-empty.
        domainB.applySessions([
            {
                id: 's_persisted',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: null,
            } as any,
        ]);

        expect(getB().sessions.s_persisted.permissionMode).toBe('read-only');
        expect(getB().sessions.s_persisted.permissionModeUpdatedAt).toBe(7000);
    });
});
