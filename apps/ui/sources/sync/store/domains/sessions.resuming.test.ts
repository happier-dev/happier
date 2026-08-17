import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.restoreAllMocks();
});

function mockSessionsDomainBoundaries() {
    vi.doMock('../../domains/state/persistence', async (importOriginal) => {
        const { installPersistenceModuleMock } = await import('@/dev/testkit');
        const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
        const { purchasesDefaults } = await import('@/sync/domains/purchases/purchases');
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        return installPersistenceModuleMock({
            loadSettings: () => ({
                settings: { groupInactiveSessionsByProject: false },
                version: null,
            }),
            loadLocalSettings: () => ({ ...localSettingsDefaults }),
            loadPendingSettings: () => ({}),
            loadPurchases: () => ({ ...purchasesDefaults }),
            loadProfile: () => ({ ...profileDefaults, id: 'account_a' }),
            loadSessionDrafts: () => ({}),
            loadSessionLastViewed: () => ({}),
            loadSessionModelModeUpdatedAts: () => ({}),
            loadSessionModelModes: () => ({}),
            loadSessionPermissionModeUpdatedAts: () => ({}),
            loadSessionPermissionModes: () => ({}),
            loadSessionActionDrafts: () => ({}),
            loadSessionReviewCommentsDrafts: () => ({}),
            saveSessionDrafts: vi.fn(),
            saveSessionLastViewed: vi.fn(),
            saveSessionModelModeUpdatedAts: vi.fn(),
            saveSessionModelModes: vi.fn(),
            saveSessionPermissionModeUpdatedAts: vi.fn(),
            saveSessionPermissionModes: vi.fn(),
            saveSessionActionDrafts: vi.fn(),
            saveSessionReviewCommentsDrafts: vi.fn(),
            saveSettings: vi.fn(),
            saveLocalSettings: vi.fn(),
            savePendingSettings: vi.fn(),
            savePurchases: vi.fn(),
            saveProfile: vi.fn(),
        })(importOriginal);
    });
    vi.doMock('../../domains/state/warmCachePersistence', () => ({
        resolveWarmCacheAccountScope: vi.fn(() => null),
        saveSessionListWarmCacheEntries: vi.fn(),
        readPersistedSessionListWarmCacheEntries: vi.fn(() => undefined),
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
    vi.doMock('@/sync/domains/models/modelOptions', () => ({
        isModelSelectableForSession: vi.fn(() => true),
    }));
    vi.doMock('@/agents/catalog/catalog', () => ({
        AGENT_IDS: [],
        DEFAULT_AGENT_ID: 'openai',
        resolveAgentIdFromFlavor: vi.fn(() => null),
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
        sessionRepositoryTreeExpandedPathsBySessionId: {},
        reviewCommentsDraftsBySessionId: {},
        reviewCommentsDraftsByWorkspaceCacheKey: {},
        actionDraftsBySessionId: {},
        isDataReady: false,
        machines: {},
        machineDisplayById: {},
        sessionMessages: {
            s1: {
                messages: [],
                messagesMap: {},
                reducerState: createReducer(),
                isLoaded: true,
            },
        },
        profile: { id: 'account_a' },
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

function baseSession(overrides: Record<string, unknown>) {
    return {
        id: 's1',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

describe('sessions domain: resuming lifecycle', () => {
    it('keeps resuming marked while the resume RPC is in flight, then arms bounded decay after acceptance', async () => {
        mockSessionsDomainBoundaries();

        const scheduledTimeouts = new Map<number, { callback: () => void; delay: number }>();
        let nextTimeoutId = 1;
        let nowMs = Date.parse('2026-02-05T00:00:00.000Z');
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((((callback: TimerHandler, delay?: number) => {
            const timeoutId = nextTimeoutId++;
            if (typeof callback === 'function') {
                scheduledTimeouts.set(timeoutId, { callback: callback as () => void, delay: typeof delay === 'number' ? delay : 0 });
            }
            return timeoutId as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout));
        vi.spyOn(globalThis, 'clearTimeout').mockImplementation((((timeoutId: ReturnType<typeof setTimeout>) => {
            scheduledTimeouts.delete(timeoutId as unknown as number);
        }) as typeof clearTimeout));

        const { createReducer } = await import('../../reducer/reducer');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, createReducer);

        domain.applySessions([baseSession({ active: false, presence: 12345 })]);
        domain.markSessionResuming('s1');

        expect(get().sessions.s1?.resumingAt).toBe(nowMs);
        expect(get().sessionListRenderables.s1?.resumingAt).toBe(nowMs);
        expect([...scheduledTimeouts.values()].filter((timeout) => timeout.delay === 30_000)).toHaveLength(0);

        // The daemon may still be processing a valid slow resume, so elapsed presentation time
        // alone must not expose the underlying inactive publisher state.
        nowMs += 30_001;
        expect(get().sessions.s1?.resumingAt).toBe(nowMs - 30_001);

        domain.armSessionResumingFallback('s1');
        const decayTimers = [...scheduledTimeouts.values()].filter((timeout) => timeout.delay === 30_000);
        expect(decayTimers).toHaveLength(1);

        // Once the daemon accepted the resume, bounded decay remains the safety net if no
        // authoritative post-attach activity ever arrives.
        decayTimers[0]?.callback();
        expect(get().sessions.s1?.resumingAt ?? null).toBeNull();
        expect(get().sessionListRenderables.s1?.resumingAt ?? null).toBeNull();
    });

    it('clears the resume marker in the session and list projections together', async () => {
        mockSessionsDomainBoundaries();

        const nowMs = Date.parse('2026-02-05T00:00:00.000Z');
        vi.spyOn(Date, 'now').mockReturnValue(nowMs);

        const { createReducer } = await import('../../reducer/reducer');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, createReducer);

        domain.applySessions([baseSession({ active: false, presence: 12345 })]);
        domain.markSessionResuming('s1');
        expect(get().sessionListRenderables.s1?.resumingAt).toBe(nowMs);
        domain.clearSessionResuming('s1');

        expect(get().sessions.s1?.resumingAt ?? null).toBeNull();
        expect(get().sessionListRenderables.s1?.resumingAt ?? null).toBeNull();
    });

    it('clears resumingAt when the first post-attach activity is observed after resume', async () => {
        mockSessionsDomainBoundaries();

        let nowMs = Date.parse('2026-02-05T00:00:00.000Z');
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        vi.spyOn(globalThis, 'setTimeout');

        const { createReducer } = await import('../../reducer/reducer');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, createReducer);

        // Inactive finished session, then user submits (queues work) and initiates a resume.
        domain.applySessions([baseSession({
            active: false,
            presence: 12345,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 60_000,
        })]);
        domain.markSessionOptimisticThinking('s1');
        domain.markSessionResuming('s1');
        expect(get().sessions.s1?.resumingAt).toBe(nowMs);

        // Reconnect: session becomes active/online but the queued turn has not started yet — the
        // marker persists across the catch-up window (pending optimistic work, no new event).
        nowMs += 500;
        domain.applySessions([baseSession({
            active: true,
            activeAt: nowMs,
            presence: 'online',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 60_500,
        })]);
        expect(get().sessions.s1?.resumingAt).not.toBeNull();

        // First real post-attach activity (a new turn opens) settles the resume.
        nowMs += 500;
        domain.applySessions([baseSession({
            active: true,
            activeAt: nowMs,
            presence: 'online',
            thinking: true,
            thinkingAt: nowMs,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: nowMs,
        })]);
        expect(get().sessions.s1?.resumingAt ?? null).toBeNull();
    });

    it('settles a bare resume (no queued work) once the session reconnects live and idle', async () => {
        mockSessionsDomainBoundaries();

        let nowMs = Date.parse('2026-02-05T00:00:00.000Z');
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        vi.spyOn(globalThis, 'setTimeout');

        const { createReducer } = await import('../../reducer/reducer');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, createReducer);

        domain.applySessions([baseSession({
            active: false,
            presence: 12345,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 60_000,
        })]);
        domain.markSessionResuming('s1');
        expect(get().sessions.s1?.resumingAt).toBe(nowMs);

        // Reconnect to a live, idle, finished session with nothing queued -> resume is settled.
        nowMs += 500;
        domain.applySessions([baseSession({
            active: true,
            activeAt: nowMs,
            presence: 'online',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 60_500,
        })]);
        expect(get().sessions.s1?.resumingAt ?? null).toBeNull();
    });

    it('does not resurrect resumingAt from a mere presence heartbeat on a finished idle session', async () => {
        mockSessionsDomainBoundaries();

        let nowMs = Date.parse('2026-02-05T00:00:00.000Z');
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        vi.spyOn(globalThis, 'setTimeout');

        const { createReducer } = await import('../../reducer/reducer');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, createReducer);

        domain.applySessions([baseSession({
            active: true,
            activeAt: nowMs,
            presence: 'online',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 60_000,
        })]);

        // Heartbeat creeps activeAt forward with no new transcript event; nobody resumed.
        nowMs += 30_000;
        domain.applySessions([baseSession({
            active: true,
            activeAt: nowMs,
            presence: 'online',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 90_000,
        })]);

        expect(get().sessions.s1?.resumingAt ?? null).toBeNull();
    });
});
