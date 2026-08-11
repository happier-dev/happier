import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installPersistenceModuleMock } from '@/dev/testkit';
import { purchasesDefaults } from '@/sync/domains/purchases/purchases';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
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
    vi.doMock('../../domains/state/persistence', installPersistenceModuleMock({
        loadProfile: vi.fn(() => ({ ...profileDefaults, id: 'account_a' })),
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
        loadLocalSettings: vi.fn(() => ({ ...localSettingsDefaults })),
        loadPurchases: vi.fn(() => ({ ...purchasesDefaults })),
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
        readPersistedSessionListWarmCacheEntries: vi.fn(() => undefined),
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
    let setCount = 0;

    const get = () => state;
    const set = (updater: any) => {
        setCount += 1;
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
        storageStateRef.current = state;
    };

    const domain = createSessionsDomain({ get, set } as any);
    return { get, domain, getSetCount: () => setCount };
}

function readSessionListRowIds(data: readonly any[] | null): string[] {
    return (data ?? [])
        .filter((item) => item?.type === 'session')
        .map((item) => item.session?.id)
        .filter((id): id is string => typeof id === 'string');
}

function readSessionListSessionById(data: readonly any[] | null, sessionId: string) {
    return (data ?? [])
        .find((item) => item?.type === 'session' && item.session?.id === sessionId)
        ?.session ?? null;
}

describe('sessions domain: sessionListViewData rebuild gating', () => {
    it('publishes changed renderable ids for incremental session-list consumers', async () => {
        mockSessionPersistenceBoundaries();
        const { createSessionsDomain } = await import('./sessions');
        const initial = {
            id: 's1',
            seq: 1,
            createdAt: 1_000,
            updatedAt: 1_000,
            active: true,
            activeAt: 1_000,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            latestReadyEventSeq: 1,
        };
        const { domain, get } = createHarness(createSessionsDomain);

        domain.applySessions([initial]);
        const firstDelta = get().sessionListRenderableDelta;
        expect(firstDelta).toEqual(expect.objectContaining({
            revision: 1,
            changedSessionIds: ['s1'],
            removedSessionIds: [],
            rebuiltSessionListViewData: true,
        }));

        domain.applySessions([{
            ...initial,
            seq: 2,
            updatedAt: 1_001,
            latestReadyEventSeq: 2,
        }]);

        expect(get().sessionListRenderableDelta).toEqual(expect.objectContaining({
            revision: firstDelta.revision + 1,
            changedSessionIds: ['s1'],
            removedSessionIds: [],
            rebuiltSessionListViewData: false,
        }));
    });

    it('keeps manual unread renderables unread when only a partial transcript slice is cached', async () => {
        mockSessionPersistenceBoundaries();
        const { createSessionsDomain } = await import('./sessions');
        const { domain, get } = createHarness(createSessionsDomain, {
            sessionMessages: {
                s1: {
                    isLoaded: false,
                    messageIdsOldestFirst: ['m110'],
                    messagesById: {
                        m110: {
                            id: 'm110',
                            seq: 110,
                            kind: 'agent-text',
                            text: 'older visible message',
                            createdAt: 100,
                        },
                    },
                    messagesMap: {},
                },
            },
        });

        domain.applySessions([{
            id: 's1',
            seq: 742,
            createdAt: 1,
            updatedAt: 2,
            active: false,
            activeAt: 1,
            archivedAt: null,
            lastViewedSessionSeq: 741,
            latestReadyEventSeq: 110,
            latestTurnStatus: 'completed',
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'offline',
        } as any]);

        expect(get().sessionListRenderables.s1.hasUnreadMessages).toBe(true);
    });

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

    it('does not notify storage when SCM snapshot refresh only changes fetchedAt', async () => {
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
            projectKey: 'm1:/home/u/repo',
            fetchedAt: 123,
            repo: {
                isRepo: true,
                rootPath: '/home/u/repo',
                backendId: 'git',
                mode: '.git',
                worktrees: [{ path: '/home/u/repo', branch: 'main', isCurrent: true }],
            },
            capabilities: {
                writeInclude: true,
                writeExclude: true,
                worktreeCreate: true,
            },
            branch: {
                head: 'main',
                upstream: 'origin/main',
                ahead: 0,
                behind: 0,
                detached: false,
            },
            entries: [{
                path: 'src/a.ts',
                previousPath: null,
                kind: 'modified',
                includeStatus: 'unmodified',
                pendingStatus: 'modified',
                hasIncludedDelta: false,
                hasPendingDelta: true,
                stats: {
                    includedAdded: 0,
                    includedRemoved: 0,
                    pendingAdded: 1,
                    pendingRemoved: 0,
                    isBinary: false,
                },
            }],
            hasConflicts: false,
            totals: {
                includedFiles: 0,
                pendingFiles: 1,
                untrackedFiles: 0,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 1,
                pendingRemoved: 0,
            },
        };

        const { createSessionsDomain } = await import('./sessions');
        const { domain, getSetCount } = createHarness(createSessionsDomain, {
            sessions: { s1: session },
            machines: { m1: { id: 'm1', metadata: { homeDir: '/home/u' } } },
        });

        domain.updateSessionProjectScmSnapshot('s1', snapshot as any);
        expect(getSetCount()).toBe(1);

        domain.updateSessionProjectScmSnapshot('s1', {
            ...snapshot,
            fetchedAt: 456,
        } as any);

        expect(getSetCount()).toBe(1);
        expect(domain.getSessionProjectScmSnapshot('s1')).toBe(snapshot);
        projectManager.clear();
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

    it('rebuilds inactive date-grouped sessionListViewData when meaningful activity changes ordering', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, {
            settings: {
                groupInactiveSessionsByProject: false,
                sessionListInactiveGroupingV1: 'date',
            },
        });

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 100,
                meaningfulActivityAt: 100,
                active: false,
                activeAt: 100,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 100,
            } as any,
            {
                id: 's2',
                seq: 1,
                createdAt: 2,
                updatedAt: 200,
                meaningfulActivityAt: 200,
                active: false,
                activeAt: 200,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 200,
            } as any,
        ]);

        const initial = get().sessionListViewData;
        expect(readSessionListRowIds(initial)).toEqual(['s2', 's1']);

        domain.applySessions([
            {
                id: 's1',
                seq: 2,
                createdAt: 1,
                updatedAt: 300,
                meaningfulActivityAt: 300,
                active: false,
                activeAt: 300,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 300,
            } as any,
        ]);

        const next = get().sessionListViewData;
        expect(next).not.toBe(initial);
        expect(readSessionListRowIds(next)).toEqual(['s1', 's2']);
        expect(readSessionListSessionById(next, 's1')?.updatedAt).toBe(300);
    });

    it('keeps list data stable for unread updates when attention promotion is disabled while row overlay stays fresh', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        const { selectSessionListRowStateSnapshot } = await import('../sessionListRowStateSnapshot');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, {
            settings: { sessionListAttentionPromotionModeV1: 'off' },
        });

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
                    active: false,
                    activeAt: 1,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    latestReadyEventSeq: null,
                    latestReadyEventAt: null,
                } as any,
            ]);

            const initial = get().sessionListViewData;
            expect(Array.isArray(initial)).toBe(true);
            syncPerformanceTelemetry.reset();

            domain.applySessions([
                {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: false,
                    activeAt: 1,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    latestReadyEventSeq: 2,
                    latestReadyEventAt: 2,
                } as any,
            ]);

            expect(get().sessionListViewData).toBe(initial);
            expect(readSessionListSessionById(initial, 's1')?.latestReadyEventSeq).toBeNull();
            expect(get().sessionListRenderables.s1.latestReadyEventSeq).toBe(2);
            expect(selectSessionListRowStateSnapshot(get(), { sessionId: 's1' }).renderable?.latestReadyEventSeq).toBe(2);

            const changedEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.sessions.apply.changed');
            expect(changedEvent?.fields.listRebuild).toBe(0);
            expect(changedEvent?.fields.listRowRefreshes).toBe(0);
        } finally {
            syncPerformanceTelemetry.configure({ enabled: false });
        }
    });

    it('refreshes the row without rebuilding placement for a higher-revision observation with unchanged runtime activity semantics', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-02T13:30:00.000Z'));
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, {
            settings: { sessionListWorkingPlacementModeV1: 'global' },
        });
        const now = Date.now();

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
                    activeAt: now - 5_000,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: now - 10_000,
                    runtimeActivityState: 'active',
                    runtimeActivityRevision: 1,
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: now - 1_000,
                } as any,
            ]);

            const initial = get().sessionListViewData;
            syncPerformanceTelemetry.reset();

            domain.applySessions([
                {
                    ...get().sessions.s1,
                    runtimeActivityRevision: 2,
                    runtimeActivityObservedAt: now + 10_000,
                } as any,
            ]);

            // A newer observation of the SAME semantics is no longer inert: background activity is
            // now held only while something still witnesses it, so a fresher observation genuinely
            // extends the working window. That is the working-signal refresh case below — no
            // structural rebuild, one row refresh so placement is later evaluated against the fresh
            // instant instead of demoting at the stale one.
            const next = get().sessionListViewData;
            expect(readSessionListRowIds(next)).toEqual(readSessionListRowIds(initial));

            const changedEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.sessions.apply.changed');
            expect(changedEvent?.fields.listRebuild).toBe(0);
            expect(changedEvent?.fields.listRowRefreshes).toBe(1);
        } finally {
            syncPerformanceTelemetry.configure({ enabled: false });
            vi.useRealTimers();
        }
    });

    it('refreshes list rows for working-signal refreshes that extend the working window without rebuilding placement', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-02T13:35:00.000Z'));
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, {
            settings: { sessionListWorkingPlacementModeV1: 'global' },
        });
        const now = Date.now();

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
                    activeAt: now - 60_000,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 60_000,
                } as any,
            ]);

            const initial = get().sessionListViewData;
            expect(readSessionListSessionById(initial, 's1')?.latestTurnStatusObservedAt).toBe(now - 60_000);
            syncPerformanceTelemetry.reset();

            // Placement stays 'working' before and after, but the refreshed
            // observation extends the working window: the committed view data
            // must pick up the fresh timestamps through the row-refresh
            // channel or the UI later demotes the session at the STALE expiry
            // while its row (subscribed to the fresh renderable) still shows
            // the working indicator.
            domain.applySessions([
                {
                    ...get().sessions.s1,
                    seq: 2,
                    latestTurnStatusObservedAt: now,
                    activeAt: now,
                } as any,
            ]);

            const next = get().sessionListViewData;
            expect(readSessionListRowIds(next)).toEqual(readSessionListRowIds(initial));
            expect(readSessionListSessionById(next, 's1')?.latestTurnStatusObservedAt).toBe(now);

            const changedEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.sessions.apply.changed');
            expect(changedEvent?.fields.listRebuild).toBe(0);
            expect(changedEvent?.fields.listRowRefreshes).toBe(1);
        } finally {
            syncPerformanceTelemetry.configure({ enabled: false });
            vi.useRealTimers();
        }
    });

    it('rebuilds sessionListViewData when runtime activity enters or leaves global working placement', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-02T13:45:00.000Z'));
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        const { createSessionsDomain } = await import('./sessions');
        const { domain } = createHarness(createSessionsDomain, {
            settings: { sessionListWorkingPlacementModeV1: 'global' },
        });
        const now = Date.now();

        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const baseSession = {
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: now - 5_000,
            metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now - 10_000,
            runtimeActivityState: 'idle',
            runtimeActivityRevision: 1,
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
        } as any;

        try {
            domain.applySessions([baseSession]);
            syncPerformanceTelemetry.reset();

            domain.applySessions([{
                ...baseSession,
                runtimeActivityState: 'active',
                runtimeActivityRevision: 2,
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: now - 1_000,
            }]);

            let changedEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.sessions.apply.changed');
            expect(changedEvent?.fields.listRebuild).toBe(1);
            expect(changedEvent?.fields.attentionPromotionFieldChanges).toBe(1);

            syncPerformanceTelemetry.reset();
            domain.applySessions([{
                ...baseSession,
                runtimeActivityRevision: 3,
            }]);

            changedEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.sessions.apply.changed');
            expect(changedEvent?.fields.listRebuild).toBe(1);
            expect(changedEvent?.fields.attentionPromotionFieldChanges).toBe(1);
        } finally {
            syncPerformanceTelemetry.configure({ enabled: false });
            vi.useRealTimers();
        }
    });

    it('rebuilds sessionListViewData for attention-only updates when attention promotion uses a global section', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, {
            settings: { sessionListAttentionPromotionModeV1: 'global' },
        });

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                latestReadyEventSeq: null,
                latestReadyEventAt: null,
            } as any,
        ]);

        const initial = get().sessionListViewData;
        expect(Array.isArray(initial)).toBe(true);

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                latestReadyEventSeq: 2,
                latestReadyEventAt: 2,
            } as any,
        ]);

        expect(get().sessionListViewData).not.toBe(initial);
    });

    it('KEYSTONE: does not rebuild sessionListViewData when an already-unread session receives new activity', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { resolveSessionListRenderableAttentionPromotionPlacement } = await import(
            '../../domains/session/listing/sessionListRenderable'
        );
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, {
            settings: {
                // The attention lane must be LIVE, otherwise unread rows never reach a
                // promotion placement and this assertion could not discriminate.
                sessionListAttentionPromotionModeV1: 'global',
                // Project grouping keeps the date-bucket gate out of the way, so the only
                // thing left that can rebuild the list here is the attention placement key.
                groupInactiveSessionsByProject: true,
            },
        });

        const row = (overrides: Record<string, unknown>) => ({
            id: 's1',
            seq: 10,
            // Read: the view cursor is level with the readable seq.
            lastViewedSessionSeq: 10,
            createdAt: 1_000,
            updatedAt: 5_000,
            meaningfulActivityAt: 5_000,
            active: false,
            activeAt: 5_000,
            metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 5_000,
            // A terminal turn makes the session seq readable, which is what makes the
            // row unread against `lastViewedSessionSeq`. It must NOT be 'completed'
            // and must carry no ready event, or the row is ready-for-review and lands
            // in the 'ready' lane (whose key is not the unread entry fact) instead.
            latestTurnStatus: 'cancelled',
            latestReadyEventSeq: null,
            latestReadyEventAt: null,
            ...overrides,
        } as any);

        domain.applySessions([row({})]);
        expect(get().sessionListRenderables.s1.hasUnreadMessages).toBe(false);
        const beforeEdge = get().sessionListViewData;
        expect(Array.isArray(beforeEdge)).toBe(true);

        // Read -> unread membership edge: this one MUST rebuild. It is the positive
        // control that proves the assertion below is not simply unreachable.
        domain.applySessions([row({ seq: 12, updatedAt: 6_000, meaningfulActivityAt: 6_000 })]);

        expect(get().sessionListRenderables.s1.hasUnreadMessages).toBe(true);
        const entryFact = get().sessionListRenderables.s1.unreadSince;
        expect(entryFact).toBe(6_000);
        const afterEdge = get().sessionListViewData;
        expect(afterEdge).not.toBe(beforeEdge);
        // The row must really be sitting in the 'unread' attention lane keyed on the
        // entry fact — otherwise the no-rebuild assertion below would hold for the
        // wrong reason (e.g. a lane whose key never depended on activity at all).
        expect(resolveSessionListRenderableAttentionPromotionPlacement(get().sessionListRenderables.s1))
            .toEqual({ kind: 'unread', timestamp: 6_000 });

        // New activity lands while the row STAYS unread: membership is unchanged, so
        // the entry fact must not move and the list must not be rebuilt.
        domain.applySessions([row({ seq: 13, updatedAt: 9_000, meaningfulActivityAt: 9_000 })]);

        // The update really was ingested — without this the identity assertion below
        // would pass vacuously for a dropped update.
        expect(get().sessionListRenderables.s1.seq).toBe(13);
        expect(get().sessionListRenderables.s1.meaningfulActivityAt).toBe(9_000);
        expect(get().sessionListRenderables.s1.hasUnreadMessages).toBe(true);
        expect(get().sessionListRenderables.s1.unreadSince).toBe(entryFact);
        expect(get().sessionListViewData).toBe(afterEdge);
    });

    it('stamps the unread entry fact on the FIRST applySessions that ingests an unread row', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { resolveSessionListRenderableAttentionPromotionPlacement } = await import(
            '../../domains/session/listing/sessionListRenderable'
        );
        const warmCache = await import('../../domains/state/warmCachePersistence');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, {
            settings: {
                sessionListAttentionPromotionModeV1: 'global',
                groupInactiveSessionsByProject: true,
            },
        });

        // A row the client considers unread on arrival and for which the server
        // carries NO materialized entry fact: local read state (`lastViewedSessionSeq`)
        // is behind the readable seq, which is exactly the foreground case where a
        // freshly-arrived row must still get a stable ordering key immediately.
        const row = (overrides: Record<string, unknown>) => ({
            id: 's1',
            seq: 12,
            lastViewedSessionSeq: 4,
            createdAt: 1_000,
            updatedAt: 5_000,
            meaningfulActivityAt: 5_000,
            active: false,
            activeAt: 5_000,
            metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 5_000,
            latestTurnStatus: 'cancelled',
            latestReadyEventSeq: null,
            latestReadyEventAt: null,
            ...overrides,
        } as any);

        domain.applySessions([row({})]);

        // Positive control: the row really is unread on its first ingest, so the
        // entry-fact assertions below cannot pass for the trivial read-row reason.
        expect(get().sessionListRenderables.s1.hasUnreadMessages).toBe(true);
        // The stable ordering key must exist after ONE apply, not after the next one.
        expect(get().sessionListRenderables.s1.unreadSince).toBe(5_000);
        // And the row must really be ordered by it in the unread attention lane.
        expect(resolveSessionListRenderableAttentionPromotionPlacement(get().sessionListRenderables.s1))
            .toEqual({ kind: 'unread', timestamp: 5_000 });

        // First ingest writes the warm cache immediately; a null entry fact persisted
        // here is what a cold boot would order this unread row by.
        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        expect(saveWarmCache).toHaveBeenCalledTimes(1);
        expect(saveWarmCache.mock.calls[0]![2].s1).toEqual(expect.objectContaining({
            hasUnreadMessages: true,
            unreadSince: 5_000,
        }));

        // New activity while the row stays unread must not move the key it was
        // stamped with on arrival.
        domain.applySessions([row({ seq: 13, updatedAt: 9_000, meaningfulActivityAt: 9_000 })]);

        expect(get().sessionListRenderables.s1.seq).toBe(13);
        expect(get().sessionListRenderables.s1.meaningfulActivityAt).toBe(9_000);
        expect(get().sessionListRenderables.s1.unreadSince).toBe(5_000);
    });

    it('preserves local ready metadata when hydrated rows do not carry a fresher ready event', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, {
            settings: { sessionListAttentionPromotionModeV1: 'global' },
        });

        domain.applySessions([
            {
                id: 's1',
                seq: 10,
                createdAt: 1,
                updatedAt: 10,
                active: false,
                activeAt: 10,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 10,
                latestTurnStatus: 'in_progress',
                latestReadyEventSeq: 10,
                latestReadyEventAt: 2_000,
            } as any,
        ]);

        domain.applySessions([
            {
                id: 's1',
                seq: 11,
                createdAt: 1,
                updatedAt: 11,
                active: false,
                activeAt: 11,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 11,
                latestTurnStatus: 'in_progress',
            } as any,
        ]);

        expect(get().sessions.s1.latestReadyEventSeq).toBe(10);
        expect(get().sessions.s1.latestReadyEventAt).toBe(2_000);
        expect(get().sessionListRenderables.s1.latestReadyEventSeq).toBe(10);
        expect(get().sessionListRenderables.s1.latestReadyEventAt).toBe(2_000);
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

    it('keeps store collection references stable for active session heartbeat updates', async () => {
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
                presence: 'online',
            } as any,
        ]);

        const initialSession = get().sessions.s1;
        const initialSessions = get().sessions;
        const initialRenderables = get().sessionListRenderables;
        const initialMessages = get().sessionMessages;
        const initialListViewData = get().sessionListViewData;

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 2,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            } as any,
        ]);

        expect(get().sessions.s1).toBe(initialSession);
        expect(get().sessions.s1?.activeAt).toBe(1);
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

    it('keeps sessionListViewData and project sessions stable when reachable peer reevaluation does not change list structure', async () => {
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

        expect(get().sessionListViewData).toBe(initial);
        expect(updateSessions).toHaveBeenCalledTimes(1);
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

    it('coalesces warm cache persistence for repeated applySessions cache-entry updates', async () => {
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

            const buildSession = (version: number, title: string) => ({
                id: 's1',
                seq: version,
                createdAt: 1,
                updatedAt: version,
                active: true,
                activeAt: 1,
                metadata: {
                    machineId: 'm1',
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                    name: title,
                },
                metadataVersion: version,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            } as any);

            domain.applySessions([buildSession(1, 'Initial title')]);

            const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
            expect(saveWarmCache).toHaveBeenCalledTimes(1);
            saveWarmCache.mockClear();

            domain.applySessions([buildSession(2, 'Updated title')]);
            domain.applySessions([buildSession(3, 'Final title')]);

            expect(get().sessions.s1?.metadata?.name).toBe('Final title');
            expect(saveWarmCache).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1_000);

            expect(saveWarmCache).toHaveBeenCalledTimes(1);
            const entries = saveWarmCache.mock.calls.at(-1)?.[2] as Record<string, any>;
            expect(entries?.s1?.name).toBe('Final title');
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('skips warm cache writes for active streaming progress when list rows are stable', async () => {
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
                    id: 'streaming',
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
                    presence: 'online',
                } as any,
            ]);

            const initialListViewData = get().sessionListViewData;
            expect(Array.isArray(initialListViewData)).toBe(true);

            const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
            expect(saveWarmCache).toHaveBeenCalledTimes(1);

            for (let index = 0; index < 10; index += 1) {
                domain.applySessions([
                    {
                        id: 'streaming',
                        seq: index + 2,
                        createdAt: 1,
                        updatedAt: index + 2,
                        active: true,
                        activeAt: index + 2,
                        metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 0,
                        thinking: true,
                        thinkingAt: 1,
                        presence: 'online',
                    } as any,
                ]);
            }

            expect(get().sessionListViewData).toBe(initialListViewData);
            expect(saveWarmCache).toHaveBeenCalledTimes(1);
            vi.runOnlyPendingTimers();
            expect(saveWarmCache).toHaveBeenCalledTimes(2);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('coalesces warm cache writes for active streaming progress during renderable replacement', async () => {
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

            const buildStreamingSession = (seq: number) => ({
                id: 'streaming',
                seq,
                createdAt: 1,
                updatedAt: seq,
                active: true,
                activeAt: seq,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: true,
                thinkingAt: 1,
                presence: 'online',
            } as any);

            domain.applySessions([buildStreamingSession(1)]);

            const initialListViewData = get().sessionListViewData;
            expect(Array.isArray(initialListViewData)).toBe(true);

            const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
            expect(saveWarmCache).toHaveBeenCalledTimes(1);

            for (let seq = 2; seq <= 11; seq += 1) {
                domain.replaceSessionListRenderables([
                    buildSessionListRenderableFromSession(buildStreamingSession(seq)),
                ]);
            }

            expect(get().sessionListViewData).toBe(initialListViewData);
            expect(saveWarmCache).toHaveBeenCalledTimes(1);
            vi.runOnlyPendingTimers();
            expect(saveWarmCache).toHaveBeenCalledTimes(2);
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

    it('skips reachable peer reevaluation for metadata-version-only updates with stable reachability metadata', async () => {
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
                    active: true,
                    activeAt: 10,
                    metadata: {
                        machineId: 'm1',
                        host: 'host-a',
                        path: '/home/u/repo',
                        homeDir: '/home/u',
                        name: 'Initial title',
                    },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 10,
                } as any,
            ]);

            const initialListViewData = get().sessionListViewData;
            syncPerformanceTelemetry.reset();

            domain.applySessions([
                {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 11,
                    active: true,
                    activeAt: 10,
                    metadata: {
                        machineId: 'm1',
                        host: 'host-a',
                        path: '/home/u/repo',
                        homeDir: '/home/u',
                        name: 'Updated title',
                        summary: { text: 'Updated non-reachability summary', updatedAt: 11 },
                    },
                    metadataVersion: 2,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 11,
                } as any,
            ]);

            const nextListViewData = get().sessionListViewData;
            expect(nextListViewData).not.toBe(initialListViewData);
            expect(readSessionListSessionById(nextListViewData, 's1')?.metadata?.name).toBe('Updated title');
            expect(readSessionListSessionById(nextListViewData, 's1')?.metadata?.summaryText).toBe('Updated non-reachability summary');

            const events = syncPerformanceTelemetry.snapshot().events;
            const changedEvent = events.find((candidate) => candidate.name === 'sync.store.sessions.apply.changed');
            expect(changedEvent?.fields.changedSessions).toBe(1);
            expect(changedEvent?.fields.changedRenderables).toBe(1);
            expect(changedEvent?.fields.listRebuild).toBe(0);
            expect(changedEvent?.fields.listRowRefreshes).toBe(1);
            expect(changedEvent?.fields.projectManagerUpdate).toBe(0);
            expect(changedEvent?.fields.reachablePeerReevaluation).toBe(0);
            expect(events.find((candidate) => candidate.name === 'sync.store.sessions.apply.reachablePeers')).toBeUndefined();
        } finally {
            syncPerformanceTelemetry.configure({ enabled: false });
        }
    });
});
