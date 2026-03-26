import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
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
        resolveWarmCacheAccountScope: vi.fn((fallback: string | null | undefined) => fallback ?? null),
        saveSessionListWarmCacheEntries: vi.fn(),
    }));
    vi.doMock('../sessionListCache', () => ({
        setActiveServerSessionListCache: vi.fn((current: any, value: any) => ({ ...current, server_1: value })),
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

function createHarness(createSessionsDomain: any) {
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
        actionDraftsBySessionId: {},
        isDataReady: false,
        machines: {},
        machineDisplayById: {},
        sessionMessages: {},
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

describe('sessions domain: renderable patches', () => {
    it('persists warm cache when patching unhydrated session list renderables', async () => {
        mockSessionsDomainBoundaries();

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const { buildSessionListRenderableFromSession } = await import('../../domains/session/listing/sessionListRenderable');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        domain.replaceSessionListRenderables([buildSessionListRenderableFromSession({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            metadata: null,
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any)]);

        expect(get().sessions['s1']).toBeUndefined();
        expect(get().sessionListRenderables['s1']?.active).toBe(true);

        domain.applySessionListRenderablePatches([
            { sessionId: 's1', patch: { active: false, activeAt: 20, presence: 20 } },
        ]);

        expect(get().sessionListRenderables['s1']?.active).toBe(false);
        expect(get().sessionListViewDataByServerId['server_1']).not.toBeUndefined();

        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        expect(saveWarmCache).toHaveBeenCalledTimes(2);
        const lastCall = saveWarmCache.mock.calls.at(-1);
        const entries = lastCall?.[2] as Record<string, any>;
        expect(entries?.s1?.active).toBe(false);
        expect(entries?.s1?.activeAt).toBe(20);
    });
});
