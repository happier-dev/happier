import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.restoreAllMocks();
});

function mockSessionsDomainBoundaries() {
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

describe('sessions domain: thinking grace', () => {
    it('keeps thinkingGraceUntil briefly after thinking turns off (prevents UI flicker)', async () => {
        mockSessionsDomainBoundaries();

        const scheduledTimeouts = new Map<number, () => void>();
        let nextTimeoutId = 1;
        let nowMs = Date.parse('2026-02-05T00:00:00.000Z');

        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((((callback: TimerHandler) => {
            const timeoutId = nextTimeoutId++;
            if (typeof callback === 'function') {
                scheduledTimeouts.set(timeoutId, callback as () => void);
            }
            return timeoutId as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout));
        vi.spyOn(globalThis, 'clearTimeout').mockImplementation((((timeoutId: ReturnType<typeof setTimeout>) => {
            scheduledTimeouts.delete(timeoutId as unknown as number);
        }) as typeof clearTimeout));

        const { createReducer } = await import('../../reducer/reducer');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, createReducer);

        const t0 = nowMs;

        domain.applySessions([
            {
                id: 's1',
                seq: 0,
                createdAt: t0,
                updatedAt: t0,
                active: true,
                activeAt: t0,
                metadata: null,
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 1,
                thinking: true,
                thinkingAt: t0,
                presence: 'online',
            } as any,
        ]);

        const graceUntil = get().sessions.s1?.thinkingGraceUntil ?? null;
        expect(typeof graceUntil).toBe('number');
        expect(graceUntil).toBeGreaterThan(t0);
        expect(scheduledTimeouts.size).toBe(1);

        nowMs += 250;
        const t1 = nowMs;
        domain.applySessions([
            {
                id: 's1',
                seq: 0,
                createdAt: t0,
                updatedAt: t1,
                active: true,
                activeAt: t1,
                metadata: null,
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: t1,
                presence: 'online',
            } as any,
        ]);

        // Grace remains in place after thinking turns off.
        expect(get().sessions.s1?.thinkingGraceUntil ?? null).toBe(graceUntil);

        // Once the grace timer expires, the marker clears without polling.
        nowMs = (graceUntil as number) + 1;
        const expireThinkingGrace = scheduledTimeouts.values().next().value;
        expect(typeof expireThinkingGrace).toBe('function');
        expireThinkingGrace?.();

        expect(get().sessions.s1?.thinkingGraceUntil ?? null).toBeNull();
    });
});
