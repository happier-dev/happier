import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import type { SessionListViewItem } from '../../domains/session/listing/sessionListViewData';

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

afterEach(() => {
    vi.resetModules();
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

function makeRenderable(
    overrides: Partial<SessionListRenderableSession> & Pick<SessionListRenderableSession, 'id'>,
): SessionListRenderableSession {
    return {
        id: overrides.id,
        seq: overrides.seq ?? 1,
        createdAt: overrides.createdAt ?? 1,
        updatedAt: overrides.updatedAt ?? 10,
        active: overrides.active ?? true,
        activeAt: overrides.activeAt ?? 10,
        archivedAt: overrides.archivedAt ?? null,
        pendingVersion: overrides.pendingVersion,
        pendingCount: overrides.pendingCount,
        lastViewedSessionSeq: overrides.lastViewedSessionSeq,
        metadataVersion: overrides.metadataVersion ?? 1,
        agentStateVersion: overrides.agentStateVersion ?? 1,
        metadata: Object.prototype.hasOwnProperty.call(overrides, 'metadata') ? overrides.metadata! : {
            name: 'Session title',
            summaryText: null,
            path: '/home/u/repo',
            homeDir: '/home/u',
            host: 'devbox',
            machineId: 'm1',
            flavor: null,
            directSessionV1: null,
            readStateV1: null,
            hiddenSystemSession: false,
        },
        thinking: overrides.thinking ?? false,
        thinkingAt: overrides.thinkingAt ?? 0,
        presence: overrides.presence ?? 'online',
        optimisticThinkingAt: overrides.optimisticThinkingAt,
        thinkingGraceUntil: overrides.thinkingGraceUntil,
        owner: overrides.owner,
        accessLevel: overrides.accessLevel,
        canApprovePermissions: overrides.canApprovePermissions,
        hasPendingPermissionRequests: overrides.hasPendingPermissionRequests,
        hasPendingUserActionRequests: overrides.hasPendingUserActionRequests,
        keepVisibleWhenInactive: overrides.keepVisibleWhenInactive,
    };
}

describe('sessions domain: renderable patches', () => {
    it('preserves stale decrypted metadata during placeholder replacements', async () => {
        mockSessionsDomainBoundaries();

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        domain.replaceSessionListRenderables([makeRenderable({
            id: 's1',
            metadataVersion: 7,
            metadata: {
                name: 'Decrypted title',
                summaryText: 'Existing summary',
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'devbox',
                machineId: 'm1',
                flavor: 'codex',
                directSessionV1: null,
                readStateV1: null,
                hiddenSystemSession: false,
            },
        })]);

        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        expect(saveWarmCache).toHaveBeenCalledTimes(1);

        const initialRenderables = get().sessionListRenderables;
        const initialListViewData = get().sessionListViewData;

        domain.replaceSessionListRenderables([makeRenderable({
            id: 's1',
            metadataVersion: 8,
            metadata: null,
        })]);

        expect(get().sessionListRenderables).toBe(initialRenderables);
        expect(get().sessionListViewData).toBe(initialListViewData);
        expect(get().sessionListRenderables.s1.metadataVersion).toBe(7);
        expect(get().sessionListRenderables.s1.metadata?.name).toBe('Decrypted title');
        expect(saveWarmCache).toHaveBeenCalledTimes(1);
    });

    it('initializes empty replacements then treats repeated empty replacements as no-ops', async () => {
        mockSessionsDomainBoundaries();

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        domain.replaceSessionListRenderables([]);

        expect(get().sessionListViewData).toEqual([]);
        const emptyRenderables = get().sessionListRenderables;
        const emptyListViewData = get().sessionListViewData;
        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        expect(saveWarmCache).toHaveBeenCalledTimes(0);

        domain.replaceSessionListRenderables([]);

        expect(get().sessionListRenderables).toBe(emptyRenderables);
        expect(get().sessionListViewData).toBe(emptyListViewData);
        expect(saveWarmCache).toHaveBeenCalledTimes(0);
    });

    it('preserves references and skips warm cache writes for no-op replacements', async () => {
        mockSessionsDomainBoundaries();

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        const renderable = makeRenderable({ id: 's1' });
        domain.replaceSessionListRenderables([renderable]);

        const initialRenderables = get().sessionListRenderables;
        const initialListViewData = get().sessionListViewData;
        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        expect(saveWarmCache).toHaveBeenCalledTimes(1);

        domain.replaceSessionListRenderables([{ ...renderable, metadata: { ...renderable.metadata! } }]);

        expect(get().sessionListRenderables).toBe(initialRenderables);
        expect(get().sessionListViewData).toBe(initialListViewData);
        expect(saveWarmCache).toHaveBeenCalledTimes(1);
    });

    it('records replacement planning telemetry for no-op replacements', async () => {
        mockSessionsDomainBoundaries();

        const { createSessionsDomain } = await import('./sessions');
        const { syncPerformanceTelemetry: telemetry } = await import('../../runtime/syncPerformanceTelemetry');
        const { domain } = createHarness(createSessionsDomain);

        const renderable = makeRenderable({ id: 's1' });
        domain.replaceSessionListRenderables([renderable]);

        telemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        telemetry.reset();

        domain.replaceSessionListRenderables([{ ...renderable, metadata: { ...renderable.metadata! } }]);

        const event = telemetry.snapshot().events.find(
            (candidate) => candidate.name === 'sync.store.sessions.renderables.replace',
        );
        expect(event?.fields).toEqual(expect.objectContaining({
            incoming: 1,
            previous: 1,
            changed: 0,
            removed: 0,
            noop: 1,
            listRebuild: 0,
            listViewFieldChanges: 0,
            warmCacheRelevant: 0,
        }));
    });

    it('removes previous renderables when a full replacement swaps ids without changing row count', async () => {
        mockSessionsDomainBoundaries();

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        domain.replaceSessionListRenderables([makeRenderable({ id: 's1' })]);

        const initialListViewData = get().sessionListViewData;
        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        expect(saveWarmCache).toHaveBeenCalledTimes(1);
        const { syncPerformanceTelemetry: telemetry } = await import('../../runtime/syncPerformanceTelemetry');
        telemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        telemetry.reset();

        domain.replaceSessionListRenderables([makeRenderable({ id: 's2' })]);

        expect(get().sessionListRenderables.s1).toBeUndefined();
        expect(get().sessionListRenderables.s2).toBeTruthy();
        expect(get().sessionListViewData).not.toBe(initialListViewData);
        const sessionListViewData = get().sessionListViewData as SessionListViewItem[] | null;
        expect(sessionListViewData?.filter((item) => item.type === 'session')).toHaveLength(1);
        expect(saveWarmCache).toHaveBeenCalledTimes(2);
        const listRebuildEvent = telemetry.snapshot().events.find(
            (candidate) => candidate.name === 'sync.store.sessions.renderables.replace.listRebuild',
        );
        expect(listRebuildEvent?.count).toBe(1);
        expect(listRebuildEvent?.fields.renderables).toBe(1);
        const warmCacheEvent = telemetry.snapshot().events.find(
            (candidate) => candidate.name === 'sync.store.sessions.renderables.replace.warmCache',
        );
        expect(warmCacheEvent?.count).toBe(1);
        expect(warmCacheEvent?.fields.renderables).toBe(1);
    });

    it('updates non-warm-cache replacement fields without rebuilding list data', async () => {
        mockSessionsDomainBoundaries();

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        const renderable = makeRenderable({ id: 's1' });
        domain.replaceSessionListRenderables([renderable]);

        const initialRenderables = get().sessionListRenderables;
        const initialListViewData = get().sessionListViewData;
        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        expect(saveWarmCache).toHaveBeenCalledTimes(1);

        domain.replaceSessionListRenderables([{
            ...renderable,
            thinking: true,
            thinkingAt: 50,
        }]);

        expect(get().sessionListRenderables).not.toBe(initialRenderables);
        expect(get().sessionListRenderables.s1.thinking).toBe(true);
        expect(get().sessionListViewData).toBe(initialListViewData);
        expect(saveWarmCache).toHaveBeenCalledTimes(1);
    });

    it('skips no-op renderable patches before cloning maps or rebuilding list data', async () => {
        mockSessionsDomainBoundaries();

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        domain.replaceSessionListRenderables([makeRenderable({ id: 's1' })]);
        const initialRenderables = get().sessionListRenderables;
        const initialListViewData = get().sessionListViewData;
        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        expect(saveWarmCache).toHaveBeenCalledTimes(1);

        domain.applySessionListRenderablePatches([
            { sessionId: 's1', patch: { active: true, activeAt: 10, presence: 'online' } },
        ]);

        expect(get().sessionListRenderables).toBe(initialRenderables);
        expect(get().sessionListViewData).toBe(initialListViewData);
        expect(saveWarmCache).toHaveBeenCalledTimes(1);
    });

    it('updates non-warm-cache patch fields without writing warm cache', async () => {
        mockSessionsDomainBoundaries();

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        domain.replaceSessionListRenderables([makeRenderable({ id: 's1' })]);
        const initialListViewData = get().sessionListViewData;
        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        expect(saveWarmCache).toHaveBeenCalledTimes(1);

        domain.applySessionListRenderablePatches([
            { sessionId: 's1', patch: { thinking: true, thinkingAt: 25 } },
        ]);

        expect(get().sessionListRenderables.s1.thinking).toBe(true);
        expect(get().sessionListViewData).toBe(initialListViewData);
        expect(saveWarmCache).toHaveBeenCalledTimes(1);
    });

    it('records patch planning telemetry when structural patches rebuild list data', async () => {
        mockSessionsDomainBoundaries();

        const { createSessionsDomain } = await import('./sessions');
        const { syncPerformanceTelemetry: telemetry } = await import('../../runtime/syncPerformanceTelemetry');
        const { get, domain } = createHarness(createSessionsDomain);

        domain.replaceSessionListRenderables([makeRenderable({ id: 's1' })]);
        const initialListViewData = get().sessionListViewData;

        telemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        telemetry.reset();

        domain.applySessionListRenderablePatches([
            { sessionId: 's1', patch: { active: false, activeAt: 20, presence: 20 } },
            { sessionId: 'missing', patch: { active: false } },
        ]);

        expect(get().sessionListViewData).not.toBe(initialListViewData);

        const event = telemetry.snapshot().events.find(
            (candidate) => candidate.name === 'sync.store.sessions.renderables.patch',
        );
        expect(event?.fields).toEqual(expect.objectContaining({
            patches: 2,
            changed: 1,
            noopPatches: 0,
            missing: 1,
            listRebuild: 1,
            listViewFieldChanges: 1,
            warmCacheRelevant: 1,
        }));
        const listRebuildEvent = telemetry.snapshot().events.find(
            (candidate) => candidate.name === 'sync.store.sessions.renderables.patch.listRebuild',
        );
        expect(listRebuildEvent?.count).toBe(1);
        expect(listRebuildEvent?.fields.renderables).toBe(1);
        const warmCacheEvent = telemetry.snapshot().events.find(
            (candidate) => candidate.name === 'sync.store.sessions.renderables.patch.warmCache',
        );
        expect(warmCacheEvent?.count).toBe(1);
        expect(warmCacheEvent?.fields.renderables).toBe(1);
    });

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
