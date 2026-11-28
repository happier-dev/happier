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
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        return installPersistenceModuleMock({
            loadSettings: () => ({
                settings: { groupInactiveSessionsByProject: false },
                version: null,
            }),
            loadLocalSettings: () => ({ ...localSettingsDefaults }),
            loadPendingSettings: () => ({}),
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

describe('sessions domain: thinking grace', () => {
    it('starts thinkingGraceUntil only after thinking turns off (prevents UI flicker without streaming churn)', async () => {
        mockSessionsDomainBoundaries();

        const scheduledTimeouts = new Map<number, { callback: () => void; delay: number }>();
        let nextTimeoutId = 1;
        let nowMs = Date.parse('2026-02-05T00:00:00.000Z');

        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((((callback: TimerHandler, delay?: number) => {
            const timeoutId = nextTimeoutId++;
            if (typeof callback === 'function') {
                scheduledTimeouts.set(timeoutId, {
                    callback: callback as () => void,
                    delay: typeof delay === 'number' ? delay : 0,
                });
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

        expect(get().sessions.s1?.thinkingGraceUntil ?? null).toBeNull();
        expect(scheduledTimeouts.size).toBe(0);

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

        const graceUntil = get().sessions.s1?.thinkingGraceUntil ?? null;
        expect(typeof graceUntil).toBe('number');
        expect(graceUntil).toBeGreaterThan(t1);
        expect(get().sessionListRenderables.s1?.thinkingGraceUntil ?? null).toBe(graceUntil);
        const graceTimers = [...scheduledTimeouts.values()].filter((timeout) => timeout.delay === 3_000);
        expect(graceTimers).toHaveLength(1);

        // Once the grace timer expires, the marker clears without polling.
        nowMs = (graceUntil as number) + 1;
        const expireThinkingGrace = graceTimers[0]?.callback;
        expect(typeof expireThinkingGrace).toBe('function');
        expireThinkingGrace?.();

        expect(get().sessions.s1?.thinkingGraceUntil ?? null).toBeNull();
        expect(get().sessionListRenderables.s1?.thinkingGraceUntil ?? null).toBeNull();
    });

    it('does not keep legacy thinking or start grace after a terminal turn projection', async () => {
        mockSessionsDomainBoundaries();

        let nowMs = Date.parse('2026-02-05T00:00:00.000Z');
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        vi.spyOn(globalThis, 'setTimeout');

        const { createReducer } = await import('../../reducer/reducer');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, createReducer);

        domain.applySessions([
            {
                id: 's1',
                seq: 0,
                createdAt: nowMs,
                updatedAt: nowMs,
                active: true,
                activeAt: nowMs,
                metadata: null,
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 1,
                thinking: true,
                thinkingAt: nowMs,
                presence: 'online',
            } as any,
        ]);

        nowMs += 250;
        domain.applySessions([
            {
                id: 's1',
                seq: 0,
                createdAt: nowMs - 250,
                updatedAt: nowMs,
                active: true,
                activeAt: nowMs,
                metadata: null,
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 1,
                thinking: true,
                thinkingAt: nowMs,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: nowMs - 10,
                presence: 'online',
            } as any,
        ]);

        expect(get().sessions.s1?.thinking).toBe(false);
        expect(get().sessions.s1?.thinkingAt).toBe(nowMs - 10);
        expect(get().sessions.s1?.thinkingGraceUntil ?? null).toBeNull();
        expect(get().sessionListRenderables.s1?.thinking).toBe(false);
        expect(get().sessionListRenderables.s1?.thinkingGraceUntil ?? null).toBeNull();
        expect(vi.mocked(globalThis.setTimeout).mock.calls.filter((call) => call[1] === 3_000)).toHaveLength(0);
    });
});
