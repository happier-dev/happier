import { afterEach, describe, expect, it, vi } from 'vitest';

const storageStateRef = vi.hoisted(() => ({
    current: null as any,
}));

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    storageStateRef.current = null;
});

function mockSessionsDomainBoundaries(): void {
    vi.doMock('../../domains/state/persistence', () => ({
        loadSettings: () => ({
            settings: { groupInactiveSessionsByProject: false },
            version: null,
        }),
        loadLocalSettings: () => ({}),
        loadPendingSettings: () => ({}),
        loadPurchases: () => ({}),
        loadProfile: () => ({ id: 'account_a' }),
        loadSessionDrafts: () => ({}),
        loadSessionLastViewed: () => ({}),
        loadSessionModelModeUpdatedAts: () => ({}),
        loadSessionModelModes: () => ({}),
        loadSessionPermissionModeUpdatedAts: () => ({}),
        loadSessionPermissionModes: () => ({}),
        loadSessionActionDrafts: () => ({}),
        loadSessionReviewCommentsDrafts: () => ({}),
        loadWorkspaceReviewCommentsDrafts: () => ({}),
        saveSessionDrafts: vi.fn(),
        saveSessionLastViewed: vi.fn(),
        saveSessionModelModeUpdatedAts: vi.fn(),
        saveSessionModelModes: vi.fn(),
        saveSessionPermissionModeUpdatedAts: vi.fn(),
        saveSessionPermissionModes: vi.fn(),
        saveSessionActionDrafts: vi.fn(),
        saveSessionReviewCommentsDrafts: vi.fn(),
        saveWorkspaceReviewCommentsDrafts: vi.fn(),
        saveSettings: vi.fn(),
        saveLocalSettings: vi.fn(),
        savePendingSettings: vi.fn(),
        savePurchases: vi.fn(),
        saveProfile: vi.fn(),
    }));
    vi.doMock('../../domains/state/warmCachePersistence', () => ({
        resolveWarmCacheAccountScope: vi.fn(() => null),
        saveSessionListWarmCacheEntries: vi.fn(),
    }));
    vi.doMock('../../domains/state/warmCacheAdapters', async () => {
        const actual = await vi.importActual<typeof import('../../domains/state/warmCacheAdapters')>('../../domains/state/warmCacheAdapters');
        return {
            ...actual,
            buildSessionListCacheEntriesFromRenderables: vi.fn(() => []),
        };
    });
    vi.doMock('../buildSessionListViewDataWithServerScope', () => ({
        applyReachableTargetsToSessionListRenderables: vi.fn(({ sessions }) => sessions),
        buildSessionListViewDataWithServerScope: vi.fn(() => []),
    }));
    vi.doMock('../sessionListCache', () => ({
        setActiveServerSessionListCache: vi.fn((current) => current),
    }));
    vi.doMock('../../domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: vi.fn(() => ({ serverId: 'server_1' })),
    }));
    vi.doMock('../../runtime/orchestration/projectManager', () => ({
        projectManager: {
            updateSessions: vi.fn(),
        },
    }));
    vi.doMock('../../domains/state/storage', async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => storageStateRef.current,
                getInitialState: () => storageStateRef.current,
                setState: () => undefined,
                subscribe: () => () => undefined,
                destroy: () => undefined,
            },
        } as any);
    });
    vi.doMock('@/sync/sync', () => ({
        sync: {
            ensureSessionVisibleForMessageRoute: vi.fn(),
        },
        syncSwitchServer: vi.fn(),
    }));
}

function createHarness(createSessionsDomain: any, createReducer: any) {
    let state: any = {
        sessions: {},
        sessionListRenderables: {},
        sessionsData: null,
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed: {},
        isDataReady: false,
        machines: {},
        sessionMessages: {
            s1: {
                messages: [],
                messagesMap: {},
                reducerState: createReducer(),
                isLoaded: true,
            },
        },
        settings: { groupInactiveSessionsByProject: false },
    };
    storageStateRef.current = state;

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
        storageStateRef.current = state;
    };

    const domain = createSessionsDomain({ get, set } as any);
    return { get, domain };
}

describe('sessions domain: no voice side effects', () => {
    it('applies agentState permission requests to loaded session messages when applySessions receives newer agentStateVersion', async () => {
        mockSessionsDomainBoundaries();

        const { createReducer } = await import('../../reducer/reducer');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, createReducer);

        domain.applySessions([
            {
                id: 's1',
                seq: 0,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: null,
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any,
        ]);

        domain.applySessions([
            {
                id: 's1',
                seq: 0,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: null,
                metadataVersion: 1,
                agentState: {
                    requests: {
                        req1: {
                            tool: 'Bash',
                            arguments: { command: 'ls' },
                            createdAt: 123,
                        },
                    },
                },
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any,
        ]);

        const nextState: any = get();
        const mappedMid = nextState.sessionMessages.s1.reducerState.toolIdToMessageId.get('req1');
        expect(mappedMid).toBeTruthy();

        const msg = nextState.sessionMessages.s1.messagesMap[mappedMid];
        expect(msg.kind).toBe('tool-call');
        expect(msg.tool?.name).toBe('Bash');
        expect(msg.tool?.permission?.id).toBe('req1');
        expect(msg.tool?.permission?.status).toBe('pending');
    });

    it('reconciles cached Request interrupted placeholders back to pending on reload even when agentStateVersion is unchanged', async () => {
        mockSessionsDomainBoundaries();

        const { createReducer } = await import('../../reducer/reducer');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, createReducer);

        const reducerState = createReducer();
        reducerState.toolIdToMessageId.set('req1', 'm1');
        reducerState.messages.set('m1', {
            id: 'm1',
            localId: null,
            realID: 'real-m1',
            seq: 1,
            role: 'agent',
            createdAt: 100,
            text: null,
            event: null,
            tool: {
                id: 'req1',
                name: 'AskUserQuestion',
                state: 'error',
                input: { q: 'continue?' },
                createdAt: 100,
                startedAt: null,
                completedAt: 101,
                description: null,
                result: { error: 'Request interrupted' },
                permission: {
                    id: 'req1',
                    status: 'canceled',
                    kind: 'user_action',
                    reason: 'Request interrupted',
                },
            },
        } as any);

        const state: any = get();
        state.sessions.s1 = {
            id: 's1',
            seq: 0,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                requests: {
                    req1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: { q: 'continue?' },
                        createdAt: 100,
                    },
                },
                completedRequests: null,
            },
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        };
        state.sessionMessages.s1 = {
            messageIdsOldestFirst: ['m1'],
            messagesById: {
                m1: {
                    id: 'm1',
                    kind: 'tool-call',
                    createdAt: 100,
                    localId: null,
                    tool: {
                        id: 'req1',
                        name: 'AskUserQuestion',
                        state: 'error',
                        input: { q: 'continue?' },
                        createdAt: 100,
                        completedAt: 101,
                        result: { error: 'Request interrupted' },
                        permission: {
                            id: 'req1',
                            status: 'canceled',
                            kind: 'user_action',
                            reason: 'Request interrupted',
                        },
                    },
                    children: [],
                },
            },
            messagesMap: {},
            reducerState,
            reducerVersion: 1,
            latestThinkingMessageId: null,
            latestThinkingMessageActivityAtMs: null,
            messagesVersion: 1,
            isLoaded: true,
        };
        state.sessionMessages.s1.messagesMap = state.sessionMessages.s1.messagesById;
        state.sessionListRenderables.s1 = {
            id: 's1',
            seq: 0,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            pendingVersion: undefined,
            pendingCount: undefined,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        };

        domain.applySessions([
            {
                id: 's1',
                seq: 0,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: null,
                metadataVersion: 1,
                agentState: {
                    requests: {
                        req1: {
                            tool: 'AskUserQuestion',
                            kind: 'user_action',
                            arguments: { q: 'continue?' },
                            createdAt: 100,
                        },
                    },
                    completedRequests: null,
                },
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            } as any,
        ]);

        const nextState: any = get();
        const updatedMessage = nextState.sessionMessages.s1.messagesById.m1;
        expect(updatedMessage.tool?.permission?.status).toBe('pending');
        expect(updatedMessage.tool?.state).toBe('running');
        expect(updatedMessage.tool?.completedAt).toBeNull();
        expect(updatedMessage.tool?.result).toBeUndefined();
        expect(nextState.sessionListRenderables.s1?.hasPendingPermissionRequests).toBe(false);
        expect(nextState.sessionListRenderables.s1?.hasPendingUserActionRequests).toBe(true);
    });
});
