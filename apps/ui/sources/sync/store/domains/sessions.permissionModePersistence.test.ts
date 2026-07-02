import { beforeEach, describe, expect, it, vi } from 'vitest';

const persistedPermissionModes = vi.hoisted(() => new Map<string, string>());
const persistedPermissionModeUpdatedAts = vi.hoisted(() => new Map<string, number>());

vi.mock('../../domains/state/sessionPersistence', () => ({
    loadSessionDrafts: () => ({}),
    loadSessionLastViewed: () => ({}),
    loadSessionModelModeUpdatedAts: () => ({}),
    loadSessionModelModes: () => ({}),
    loadSessionPermissionModeUpdatedAts: () => Object.fromEntries(persistedPermissionModeUpdatedAts.entries()),
    loadSessionPermissionModes: () => Object.fromEntries(persistedPermissionModes.entries()),
    loadSessionActionDrafts: () => ({}),
    loadSessionReviewCommentsDrafts: () => ({}),
    loadWorkspaceReviewCommentsDrafts: () => ({}),
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
    saveWorkspaceReviewCommentsDrafts: () => {},
}));

vi.mock('../../domains/state/persistence', () => ({
    prepareSessionLocalStateScopeForActivation: () => {},
}));

vi.mock('../../domains/state/warmCachePersistence', () => ({
    resolveWarmCacheAccountScope: () => null,
    saveSessionListWarmCacheEntries: () => {},
}));

vi.mock('../../domains/state/warmCacheAdapters', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../domains/state/warmCacheAdapters')>();
    return {
        ...actual,
        buildSessionListCacheEntriesFromRenderables: () => [],
    };
});

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

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
        getState: () => ({ sessions: {}, sessionMessages: {}, machines: {}, settings: {} }),
        setState: () => {},
    },
});
});

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

vi.mock('../../domains/session/listing/applyReachableTargetsToSessionListRenderables', () => ({
    applyReachableTargetsToSessionListRenderables: ({ sessions }: any) => sessions,
}));

vi.mock('../sessionListIndex/buildSessionListIndexWithServerScope', () => ({
    buildActiveServerSessionListIndex: () => [],
}));

vi.mock('../../domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server_1' }),
}));

import { createSessionsDomain } from './sessions';

function createHarness() {
    let state: any = {
        sessions: {},
        sessionListRenderables: {},
        sessionListRowStateByServerId: {},
        sessionListIndexByServerId: {},
        concurrentSessionListCacheByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed: {},
        sessionRepositoryTreeExpandedPathsBySessionId: {},
        workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: {},
        reviewCommentsDraftsBySessionId: {},
        reviewCommentsDraftsByWorkspaceCacheKey: {},
        actionDraftsBySessionId: {},
        isDataReady: false,
        machines: {},
        machineDisplayById: {},
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

    it('persists a loaded session permission mode without dropping unloaded session permission modes', () => {
        vi.spyOn(Date, 'now').mockReturnValue(9000);
        persistedPermissionModes.set('s_loaded', 'default');
        persistedPermissionModes.set('s_unloaded', 'read-only');
        persistedPermissionModeUpdatedAts.set('s_loaded', 1000);
        persistedPermissionModeUpdatedAts.set('s_unloaded', 2000);
        const { domain } = createHarness();

        domain.applySessions([
            {
                id: 's_loaded',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: null,
            } as any,
        ]);

        domain.updateSessionPermissionMode('s_loaded', 'yolo');

        expect(Object.fromEntries(persistedPermissionModes.entries())).toEqual({
            s_loaded: 'yolo',
            s_unloaded: 'read-only',
        });
        expect(Object.fromEntries(persistedPermissionModeUpdatedAts.entries())).toEqual({
            s_loaded: 9000,
            s_unloaded: 2000,
        });
    });
});
