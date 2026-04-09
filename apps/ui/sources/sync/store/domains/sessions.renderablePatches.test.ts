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
        resolveWarmCacheAccountScope: vi.fn((fallback: string | null | undefined) => fallback ?? null),
        peekSessionListWarmCacheEntries: vi.fn(() => null),
        saveSessionListWarmCacheEntries: vi.fn(),
    }));
    vi.doMock('../../domains/state/warmCacheAdapters', async () => {
        const actual = await vi.importActual<typeof import('../../domains/state/warmCacheAdapters')>('../../domains/state/warmCacheAdapters');
        return {
            ...actual,
            buildSessionListCacheEntriesFromRenderables: vi.fn(actual.buildSessionListCacheEntriesFromRenderables),
        };
    });
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
        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        expect(saveWarmCache).toHaveBeenCalledTimes(2);
        const lastCall = saveWarmCache.mock.calls.at(-1);
        const entries = lastCall?.[2] as Record<string, any>;
        expect(entries?.s1?.active).toBe(false);
        expect(entries?.s1?.activeAt).toBe(20);
    });

    it('preserves warm-cache payload for non-semantic renderable patches', async () => {
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
            pendingCount: 0,
            pendingVersion: 1,
            metadata: {
                machineId: 'm1',
                host: 'host-a',
                path: '/home/u/repo',
                homeDir: '/home/u',
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any)]);

        const initialRenderables = get().sessionListRenderables;
        const initialRenderable = initialRenderables['s1'];
        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        expect(initialRenderable).toBeDefined();
        expect(saveWarmCache).toHaveBeenCalledTimes(1);

        domain.applySessionListRenderablePatches([
            { sessionId: 's1', patch: { presence: 20 } },
        ]);

        expect(get().sessionListRenderables).not.toBe(initialRenderables);
        expect(get().sessionListRenderables['s1']).not.toBe(initialRenderable);
        expect(get().sessionListRenderables['s1']).toEqual(expect.objectContaining({
            presence: 20,
        }));
        const initialEntries = saveWarmCache.mock.calls.at(0)?.[2] as Record<string, any>;
        const latestEntries = saveWarmCache.mock.calls.at(-1)?.[2] as Record<string, any>;
        expect(latestEntries).toEqual(initialEntries);
    });

    it('preserves previous canonical renderable metadata when a replacement renderable is still stale', async () => {
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
            metadata: {
                name: 'Cached title',
                machineId: 'm1',
                path: '/home/u/repo',
                homeDir: '/home/u',
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any)]);

        domain.replaceSessionListRenderables([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 20,
                active: true,
                activeAt: 20,
                pendingCount: 2,
                pendingVersion: 3,
                metadataVersion: 2,
                agentStateVersion: 1,
                metadata: null,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            } as any,
        ]);

        expect(get().sessionListRenderables.s1).toEqual(expect.objectContaining({
            id: 's1',
            updatedAt: 20,
            pendingCount: 2,
            pendingVersion: 3,
            metadataVersion: 1,
            agentStateVersion: 0,
            metadata: expect.objectContaining({
                name: 'Cached title',
                path: '/home/u/repo',
                homeDir: '/home/u',
                machineId: 'm1',
            }),
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        }));

        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        const lastCall = saveWarmCache.mock.calls.at(-1);
        const entries = lastCall?.[2] as Record<string, any>;

        expect(entries?.s1).toEqual(expect.objectContaining({
            sessionId: 's1',
            updatedAt: 20,
            pendingCount: 2,
            pendingVersion: 3,
            metadataVersion: 1,
            agentStateVersion: 0,
            name: 'Cached title',
            path: '/home/u/repo',
            homeDir: '/home/u',
            machineId: 'm1',
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        }));
    });

    it('preserves direct-session classification when a replacement renderable omits directSessionV1', async () => {
        mockSessionsDomainBoundaries();

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const { buildSessionListRenderableFromSession } = await import('../../domains/session/listing/sessionListRenderable');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        domain.replaceSessionListRenderables([buildSessionListRenderableFromSession({
            id: 's1',
            seq: 0,
            createdAt: 1,
            updatedAt: 10,
            active: false,
            activeAt: 10,
            metadata: {
                name: 'Direct session',
                machineId: 'm1',
                path: '/home/u/repo',
                homeDir: '/home/u',
                directSessionV1: { v: 1, providerId: 'claude' },
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 10,
        } as any)]);

        domain.replaceSessionListRenderables([
            {
                id: 's1',
                seq: 0,
                createdAt: 1,
                updatedAt: 20,
                active: false,
                activeAt: 20,
                pendingCount: 0,
                pendingVersion: 0,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: {
                    name: 'Direct session',
                    machineId: 'm1',
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                },
                thinking: false,
                thinkingAt: 0,
                presence: 20,
            } as any,
        ]);

        expect(get().sessionListRenderables.s1).toEqual(expect.objectContaining({
            id: 's1',
            updatedAt: 20,
            metadata: expect.objectContaining({
                name: 'Direct session',
                path: '/home/u/repo',
                homeDir: '/home/u',
                machineId: 'm1',
                directSessionV1: {
                    v: 1,
                    providerId: 'claude',
                },
            }),
        }));

        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        const lastCall = saveWarmCache.mock.calls.at(-1);
        const entries = lastCall?.[2] as Record<string, any>;
        expect(entries?.s1?.directSessionV1).toEqual({
            v: 1,
            providerId: 'claude',
        });
    });

    it('skips no-op renderable patches', async () => {
        mockSessionsDomainBoundaries();

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const warmCacheAdapters = await import('../../domains/state/warmCacheAdapters');
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
            pendingCount: 0,
            pendingVersion: 1,
            metadata: null,
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any)]);

        const initialRenderables = get().sessionListRenderables;
        const initialRenderable = initialRenderables['s1'];
        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        const buildPreviousEntries = warmCacheAdapters.buildSessionListCacheEntriesFromRenderables as unknown as ReturnType<typeof vi.fn>;
        expect(initialRenderable).toBeDefined();
        expect(saveWarmCache).toHaveBeenCalledTimes(1);
        buildPreviousEntries.mockClear();

        domain.applySessionListRenderablePatches([
            { sessionId: 's1', patch: { pendingCount: 0, pendingVersion: 1 } },
        ]);

        expect(get().sessionListRenderables).toBe(initialRenderables);
        expect(get().sessionListRenderables['s1']).toBe(initialRenderable);
        expect(saveWarmCache).toHaveBeenCalledTimes(1);
        expect(buildPreviousEntries).not.toHaveBeenCalled();
    });

    it('skips identical renderable replacements', async () => {
        mockSessionsDomainBoundaries();

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const warmCacheAdapters = await import('../../domains/state/warmCacheAdapters');
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
            pendingCount: 0,
            pendingVersion: 1,
            metadata: {
                machineId: 'm1',
                host: 'host-a',
                path: '/home/u/repo',
                homeDir: '/home/u',
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any)]);

        const initialRenderables = get().sessionListRenderables;
        const initialRenderable = initialRenderables['s1'];
        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        const buildPreviousEntries = warmCacheAdapters.buildSessionListCacheEntriesFromRenderables as unknown as ReturnType<typeof vi.fn>;
        expect(initialRenderable).toBeDefined();
        expect(saveWarmCache).toHaveBeenCalledTimes(1);
        buildPreviousEntries.mockClear();

        domain.replaceSessionListRenderables([
            {
                ...initialRenderable,
                metadata: initialRenderable?.metadata ? { ...initialRenderable.metadata } : null,
            },
        ]);

        expect(get().sessionListRenderables).toBe(initialRenderables);
        expect(get().sessionListRenderables['s1']).toBe(initialRenderable);
        expect(saveWarmCache).toHaveBeenCalledTimes(1);
        expect(buildPreviousEntries).not.toHaveBeenCalled();
    });
});
