import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSessionListRenderableFromSession } from '../../domains/session/listing/sessionListRenderable';

const storageStateRef = vi.hoisted(() => ({
    current: null as any,
}));

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    storageStateRef.current = null;
});

function mockSessionPersistenceBoundaries(): void {
    vi.doMock('../../domains/state/persistence', () => ({
        loadProfile: vi.fn(() => ({ id: 'account_a' })),
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
        loadSettings: vi.fn(() => ({
            settings: {
                preferredLanguage: 'en',
            },
            version: null,
        })),
        loadLocalSettings: vi.fn(() => ({})),
        loadPurchases: vi.fn(() => ({})),
        saveSessionModelModeUpdatedAts: vi.fn(),
        saveSessionModelModes: vi.fn(),
        saveSessionPermissionModeUpdatedAts: vi.fn(),
        saveSessionPermissionModes: vi.fn(),
        saveSessionActionDrafts: vi.fn(),
        saveSessionReviewCommentsDrafts: vi.fn(),
        saveWorkspaceReviewCommentsDrafts: vi.fn(),
        saveLocalSettings: vi.fn(),
        savePurchases: vi.fn(),
        saveSettings: vi.fn(),
    }));
    vi.doMock('../../domains/state/warmCachePersistence', () => ({
        resolveWarmCacheAccountScope: vi.fn((fallback: string | null | undefined) => fallback ?? null),
        saveSessionListWarmCacheEntries: vi.fn(),
    }));
    vi.doMock('@/sync/domains/models/modelOptions', () => ({
        isModelSelectableForSession: vi.fn(() => true),
    }));
    vi.doMock('@/agents/catalog/catalog', () => ({
        AGENT_IDS: [],
        DEFAULT_AGENT_ID: 'openai',
        resolveAgentIdFromFlavor: vi.fn(() => null),
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
}

function createHarness(createSessionsDomain: any, initialState: Record<string, any> = {}) {
    let state: any = {
        sessions: {},
        sessionListRenderables: {},
        sessionsData: null,
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed: {},
        sessionRepositoryTreeExpandedPathsBySessionId: {},
        reviewCommentsDraftsBySessionId: {},
        reviewCommentsDraftsByWorkspaceCacheKey: {},
        actionDraftsBySessionId: {},
        isDataReady: false,
        machines: {},
        machineDisplayById: {},
        sessionMessages: {},
        profile: { id: 'account_a' },
        settings: { groupInactiveSessionsByProject: false },
        ...initialState,
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

describe('sessions domain: sessionListViewData rebuild gating', () => {
    it('lazily registers loaded sessions before writing per-session project SCM snapshots', async () => {
        mockSessionPersistenceBoundaries();
        const { projectManager } = await import('../../runtime/orchestration/projectManager');
        projectManager.clear();

        const session = {
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: { machineId: 'm1', host: 'h1', path: '/home/u/repo', homeDir: '/home/u' },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        };
        const snapshot = {
            fetchedAt: 123,
            repo: {
                isRepo: true,
                rootPath: '/home/u/repo',
                backendId: 'git',
                mode: '.git',
                worktrees: [{ path: '/home/u/repo', branch: 'main', isCurrent: true }],
            },
            entries: [],
        };

        const { createSessionsDomain } = await import('./sessions');
        const { domain } = createHarness(createSessionsDomain, {
            sessions: { s1: session },
            machines: { m1: { id: 'm1', metadata: { homeDir: '/home/u' } } },
        });

        expect(projectManager.getProjectForSession('s1')).toBeNull();

        domain.updateSessionProjectScmSnapshot('s1', snapshot as any);

        expect(domain.getSessionProjectScmSnapshot('s1')).toBe(snapshot);
        expect(projectManager.getProjectForSession('s1')?.sessionIds).toEqual(['s1']);
    });

    it('does not call projectManager.updateSessions for non-project-structural session updates', async () => {
        const updateSessions = vi.fn();
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions },
        }));
        mockSessionPersistenceBoundaries();

        const { createSessionsDomain } = await import('./sessions');
        const { domain } = createHarness(createSessionsDomain);

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadata: { machineId: 'm1', host: 'h1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any,
        ]);
        expect(updateSessions).toHaveBeenCalledTimes(1);

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                archivedAt: null,
                metadata: { machineId: 'm1', host: 'h1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: { requests: {} },
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any,
        ]);
        expect(updateSessions).toHaveBeenCalledTimes(1);
    });

    it('keeps sessionListViewData reference stable for non-structural applySessions updates', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any,
        ]);

        const initial = get().sessionListViewData;
        expect(Array.isArray(initial)).toBe(true);

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: { requests: {} },
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any,
        ]);

        expect(get().sessionListViewData).toBe(initial);
    });

    it('does not maintain the legacy sessionsData list during applySessions updates', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any,
        ]);

        expect(get().sessions.s1).toBeTruthy();
        expect(Array.isArray(get().sessionListViewData)).toBe(true);
        expect(get().sessionsData).toBeNull();
    });

    it('keeps store collection references stable for idempotent applySessions refreshes', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any,
        ]);

        const initialSessions = get().sessions;
        const initialRenderables = get().sessionListRenderables;
        const initialMessages = get().sessionMessages;
        const initialListViewData = get().sessionListViewData;

        domain.applySessions([get().sessions.s1]);

        expect(get().sessions).toBe(initialSessions);
        expect(get().sessionListRenderables).toBe(initialRenderables);
        expect(get().sessionMessages).toBe(initialMessages);
        expect(get().sessionListViewData).toBe(initialListViewData);
    });

    it('preserves transient renderable visibility flags across applySessions refreshes', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        get().sessionListRenderables = {
            s1: {
                ...buildSessionListRenderableFromSession({
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    archivedAt: null,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                } as any),
                keepVisibleWhenInactive: true,
            },
        };

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: false,
                activeAt: 2,
                archivedAt: null,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any,
        ]);

        expect(get().sessionListRenderables['s1']?.keepVisibleWhenInactive).toBe(true);
    });

    it('rebuilds sessionListViewData when a peer session update changes another stale session reachable target', async () => {
        const updateSessions = vi.fn();
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions },
        }));
        mockSessionPersistenceBoundaries();

        const { buildMachineDisplayRenderableFromMachine } = await import('../../domains/machines/machineDisplayRenderable');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        const machineA = {
            id: 'm-a',
            active: true,
            activeAt: 100,
            metadata: { host: 'host-a' },
        } as any;
        const machineB = {
            id: 'm-b',
            active: true,
            activeAt: 200,
            metadata: { host: 'host-b' },
        } as any;

        get().machines = {
            'm-a': machineA,
            'm-b': machineB,
        };
        get().machineDisplayById = {
            'm-a': buildMachineDisplayRenderableFromMachine(machineA),
            'm-b': buildMachineDisplayRenderableFromMachine(machineB),
        };

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 10,
                active: true,
                activeAt: 10,
                metadata: { machineId: 'm-stale', host: 'host-stale', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any,
            {
                id: 's2',
                seq: 2,
                createdAt: 2,
                updatedAt: 100,
                active: true,
                activeAt: 100,
                metadata: { machineId: 'm-a', host: 'host-a', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any,
            {
                id: 's3',
                seq: 3,
                createdAt: 3,
                updatedAt: 200,
                active: true,
                activeAt: 200,
                metadata: { machineId: 'm-b', host: 'host-b', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any,
        ]);

        const initial = get().sessionListViewData;
        expect(Array.isArray(initial)).toBe(true);
        expect(updateSessions).toHaveBeenCalledTimes(1);

        domain.applySessions([
            {
                id: 's2',
                seq: 2,
                createdAt: 2,
                updatedAt: 300,
                active: true,
                activeAt: 100,
                metadata: { machineId: 'm-a', host: 'host-a', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: { requests: {} },
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any,
        ]);

        expect(get().sessionListViewData).not.toBe(initial);
        expect(updateSessions).toHaveBeenCalledTimes(2);
    });

    it('rebuilds sessionListViewData for structural applySessions changes (grouping keys)', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any,
        ]);

        const initial = get().sessionListViewData;
        expect(Array.isArray(initial)).toBe(true);

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { machineId: 'm1', path: '/home/u/other', homeDir: '/home/u' },
                metadataVersion: 2,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any,
        ]);

        expect(get().sessionListViewData).not.toBe(initial);
    });

    it('rebuilds sessionListViewData when archivedAt changes (visibility)', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any,
        ]);

        const initial = get().sessionListViewData;
        expect(Array.isArray(initial)).toBe(true);

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                archivedAt: 123,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any,
        ]);

        expect(get().sessionListViewData).not.toBe(initial);
    });

    it('does not rebuild sessionListViewData when updating a draft for a loaded session', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any,
        ]);

        const initial = get().sessionListViewData;
        expect(Array.isArray(initial)).toBe(true);

        domain.updateSessionDraft('s1', 'hello');
        expect(get().sessionListViewData).toBe(initial);
    });

    it('does not resurrect a cleared draft when applySessions merges a loaded session update', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any,
        ]);

        domain.updateSessionDraft('s1', 'local draft');
        expect(get().sessions.s1?.draft).toBe('local draft');

        domain.updateSessionDraft('s1', null);
        expect(get().sessions.s1?.draft).toBeNull();

        domain.applySessions([
            {
                id: 's1',
                seq: 2,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 2,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
                draft: 'server stale draft',
            } as any,
        ]);

        expect(get().sessions.s1?.draft).toBeNull();
    });

    it('does not rebuild sessionListViewData when marking optimistic thinking', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any,
        ]);

        const initial = get().sessionListViewData;
        expect(Array.isArray(initial)).toBe(true);

        domain.markSessionOptimisticThinking('s1');
        expect(get().sessionListViewData).toBe(initial);
    });

    it('does not rewrite the warm cache for thinking-only applySessions updates', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        try {
            vi.doMock('../../runtime/orchestration/projectManager', () => ({
                projectManager: { updateSessions: vi.fn() },
            }));
            mockSessionPersistenceBoundaries();

            const warmCache = await import('../../domains/state/warmCachePersistence');
            const { createSessionsDomain } = await import('./sessions');
            const { get, domain } = createHarness(createSessionsDomain);

            domain.applySessions([
                {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 1,
                } as any,
            ]);

            const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
            expect(saveWarmCache).toHaveBeenCalledTimes(1);
            const initialListViewData = get().sessionListViewData;

            domain.applySessions([
                {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: true,
                    thinkingAt: 1,
                    presence: 1,
                } as any,
            ]);

            expect(get().sessions.s1?.thinking).toBe(true);
            expect(get().sessionListViewData).toBe(initialListViewData);
            expect(saveWarmCache).toHaveBeenCalledTimes(1);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('records applySessions telemetry when sync performance telemetry is enabled', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        const { createSessionsDomain } = await import('./sessions');
        const { domain } = createHarness(createSessionsDomain);

        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        try {
            domain.applySessions([
                {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 1,
                } as any,
            ]);

            const event = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.sessions.apply');
            expect(event?.count).toBe(1);
            expect(event?.fields.sessions).toBe(1);

            const changedEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.sessions.apply.changed');
            expect(changedEvent?.count).toBe(1);
            expect(changedEvent?.fields.changedSessions).toBe(1);
            expect(changedEvent?.fields.changedRenderables).toBe(1);
            expect(changedEvent?.fields.listRebuild).toBe(1);
            expect(changedEvent?.fields.projectManagerUpdate).toBe(1);

            const firstApplyEvents = syncPerformanceTelemetry.snapshot().events;
            const mergeEvent = firstApplyEvents.find((candidate) => candidate.name === 'sync.store.sessions.apply.merge');
            expect(mergeEvent?.count).toBe(1);
            expect(mergeEvent?.fields.sessions).toBe(1);
            const mergeOutcomeEvent = firstApplyEvents.find((candidate) => candidate.name === 'sync.store.sessions.apply.merge.outcome');
            expect(mergeOutcomeEvent?.count).toBe(1);
            expect(mergeOutcomeEvent?.fields.changedSessions).toBe(1);
            expect(mergeOutcomeEvent?.fields.changedRenderables).toBe(1);
            expect(mergeOutcomeEvent?.fields.listRebuild).toBe(1);
            expect(mergeOutcomeEvent?.fields.listViewFieldChanges).toBe(1);
            const listRebuildEvent = firstApplyEvents.find((candidate) => candidate.name === 'sync.store.sessions.apply.listRebuild');
            expect(listRebuildEvent?.count).toBe(1);
            expect(listRebuildEvent?.fields.renderables).toBe(1);
            const projectManagerEvent = firstApplyEvents.find((candidate) => candidate.name === 'sync.store.sessions.apply.projectManager');
            expect(projectManagerEvent?.count).toBe(1);
            expect(projectManagerEvent?.fields.sessions).toBe(1);
            const warmCacheEvent = firstApplyEvents.find((candidate) => candidate.name === 'sync.store.sessions.apply.warmCache');
            expect(warmCacheEvent?.count).toBe(1);
            expect(warmCacheEvent?.fields.renderables).toBe(1);

            domain.applySessions([
                {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 1,
                } as any,
            ]);

            const noopEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.sessions.apply.noop');
            expect(noopEvent?.count).toBe(1);
            expect(noopEvent?.fields.sessions).toBe(1);
        } finally {
            syncPerformanceTelemetry.configure({ enabled: false });
        }
    });

    it('skips reachable peer reevaluation for non-reachability session updates', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        try {
            domain.applySessions([
                {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 10,
                    active: false,
                    activeAt: 10,
                    metadata: { machineId: 'm1', host: 'host-a', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 10,
                } as any,
                {
                    id: 's2',
                    seq: 2,
                    createdAt: 2,
                    updatedAt: 20,
                    active: false,
                    activeAt: 20,
                    metadata: { machineId: 'm2', host: 'host-b', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 20,
                } as any,
            ]);

            const initialListViewData = get().sessionListViewData;
            syncPerformanceTelemetry.reset();

            domain.applySessions([
                {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 10,
                    active: false,
                    activeAt: 11,
                    metadata: { machineId: 'm1', host: 'host-a', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 11,
                } as any,
            ]);

            expect(get().sessionListViewData).toBe(initialListViewData);

            const changedEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.sessions.apply.changed');
            expect(changedEvent?.fields.changedSessions).toBe(1);
            expect(changedEvent?.fields.changedRenderables).toBe(1);
            expect(changedEvent?.fields.listRebuild).toBe(0);
            expect(changedEvent?.fields.projectManagerUpdate).toBe(0);
            expect(changedEvent?.fields.reachablePeerReevaluation).toBe(0);
        } finally {
            syncPerformanceTelemetry.configure({ enabled: false });
        }
    });
});
