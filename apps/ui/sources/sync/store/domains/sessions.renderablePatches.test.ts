import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../domains/state/storageTypes';
import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

function mockSessionsDomainBoundaries() {
    vi.doMock('../../domains/state/persistence', () => ({
        loadSettings: () => ({
            settings: {},
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
            buildPersistedSessionListCacheEntriesFromRenderables: vi.fn(actual.buildPersistedSessionListCacheEntriesFromRenderables),
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
    findModelOptionForEffectiveModelId: (options: any, effectiveModelId: any) =>
        options?.find?.((option: any) => option.value === effectiveModelId)
            ?? options?.find?.((option: any) => option.value === String(effectiveModelId ?? '').replace(/\[[^\]]*\]$/u, ''))
            ?? null,
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
        sessionListRowsByServerId: {},
        ordinarySessionListMembershipByServerId: {},
        archivedSessionListMembershipByServerId: {},
        sessionListIndexByServerId: {},
        concurrentSessionListCacheByServerId: {},
        sessionListQueryMembershipByKey: {},
        sessionScmStatus: {},
        sessionLastViewed: {},
        sessionRepositoryTreeExpandedPathsBySessionId: {},
        workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: {},
        reviewCommentsDraftsBySessionId: {},
        reviewCommentsDraftsByWorkspaceCacheKey: {},
        sessionActionDraftsByAddressKey: {},
        isDataReady: false,
        machines: {},
        machineDisplayById: {},
        sessionMessages: {},
        profile: { id: 'account_a' },
        settings: {},
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createSessionsDomain({ get, set } as any);
    return { get, domain };
}

function replaceSessionListRows(domain: any, rows: SessionListRenderableSession[]): void {
    domain.applyServerScopedSessionListRows('server_1', rows, { source: 'ordinary', mode: 'replace' });
}

function mergeSessionListRows(domain: any, rows: SessionListRenderableSession[]): void {
    domain.applyServerScopedSessionListRows('server_1', rows, { source: 'ordinary', mode: 'append' });
}

function patchSessionListRows(domain: any, patches: unknown[]): void {
    domain.applyServerScopedSessionListRowPatches('server_1', patches);
}

describe('sessions domain: renderable patches', () => {
    it.each(['replacement', 'patch'] as const)('retains newer completion and pending facts through an older scoped %s', async (mode) => {
        mockSessionsDomainBoundaries();
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);
        const completed: SessionListRenderableSession = {
            id: 's_lifecycle', seq: 2, createdAt: 1, updatedAt: 200,
            active: true, activeAt: 200, thinking: false, thinkingAt: 200,
            metadata: null, metadataVersion: 0, agentStateVersion: 0, presence: 'online',
            latestTurnId: 'turn-1', latestTurnStatus: 'completed', latestTurnStatusObservedAt: 200,
            latestReadyEventSeq: 2, latestReadyEventAt: 200,
            hasPendingPermissionRequests: false, hasPendingUserActionRequests: false, pendingRequestObservedAt: 200,
        };
        replaceSessionListRows(domain, [completed]);
        const older = { ...completed, seq: 1, updatedAt: 100,
            latestTurnStatus: 'in_progress' as const, latestTurnStatusObservedAt: 100,
            latestReadyEventSeq: 1, latestReadyEventAt: 100,
            hasPendingPermissionRequests: true, pendingRequestObservedAt: 100 };
        if (mode === 'replacement') replaceSessionListRows(domain, [older]);
        else patchSessionListRows(domain, [{ sessionId: completed.id, patch: older }]);
        expect(get().sessionListRowsByServerId.server_1[completed.id]).toMatchObject({
            latestTurnStatus: 'completed', latestTurnStatusObservedAt: 200,
            latestReadyEventSeq: 2, latestReadyEventAt: 200,
            hasPendingPermissionRequests: false, pendingRequestObservedAt: 200,
        });
    });

    it('reconciles first hydration against its own Home rather than an active same-ID row', async () => {
        mockSessionsDomainBoundaries();
        const { buildSessionListRenderableFromSession } = await import('../../domains/session/listing/sessionListRenderable');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);
        const activeSession: Session = {
            id: 'same-id', serverId: 'server_1', seq: 9, createdAt: 1, updatedAt: 900,
            active: true, activeAt: 900, thinking: false, thinkingAt: 900,
            metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0, presence: 'online',
            latestTurnId: 'active-turn', latestTurnStatus: 'completed', latestTurnStatusObservedAt: 900,
            latestReadyEventSeq: 9, latestReadyEventAt: 900,
        };
        replaceSessionListRows(domain, [buildSessionListRenderableFromSession(activeSession)]);
        const activeRow = get().sessionListRowsByServerId.server_1[activeSession.id];
        const otherSession: Session = { ...activeSession, serverId: 'server_2', seq: 1, updatedAt: 100,
            latestTurnId: 'other-turn', latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: 100,
            latestReadyEventSeq: 1, latestReadyEventAt: 100 };
        domain.applySessions([otherSession]);
        expect(get().sessions[otherSession.id]).toMatchObject({
            serverId: 'server_2', latestTurnId: 'other-turn', latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 100, latestReadyEventSeq: 1,
        });
        expect(get().sessionListRowsByServerId.server_2[otherSession.id].latestTurnStatus).toBe('in_progress');
        expect(get().sessionListRowsByServerId.server_1[activeSession.id]).toBe(activeRow);
    });

    it('publishes active-Home warm-cache and row deltas for scoped merge, reconcile, and clear', async () => {
        mockSessionsDomainBoundaries();

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const { buildSessionListRenderableFromSession } = await import('../../domains/session/listing/sessionListRenderable');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);
        const row = buildSessionListRenderableFromSession({
            id: 's1',
            serverId: 'server_1',
            seq: 1,
            createdAt: 1,
            updatedAt: 10,
            active: false,
            activeAt: 10,
            metadata: null,
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 10,
        } as Session);
        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;

        domain.mergeSessionListRowsForServerScope('server_1', [row]);
        expect(get().sessionListRenderableDelta).toEqual(expect.objectContaining({
            changedSessionIds: ['s1'],
            removedSessionIds: [],
        }));
        expect(saveWarmCache).toHaveBeenCalledTimes(1);

        const baseline = { ...(get().sessionListRowsByServerId.server_1 ?? {}) };
        domain.reconcileSessionListRowsForServerScope('server_1', [], baseline);
        expect(get().sessionListRenderableDelta).toEqual(expect.objectContaining({
            changedSessionIds: [],
            removedSessionIds: ['s1'],
        }));
        expect(saveWarmCache).toHaveBeenCalledTimes(2);

        domain.mergeSessionListRowsForServerScope('server_1', [row]);
        domain.clearSessionListRowsForServerScope('server_1');
        expect(get().sessionListRenderableDelta).toEqual(expect.objectContaining({
            changedSessionIds: [],
            removedSessionIds: ['s1'],
        }));
        expect(saveWarmCache).toHaveBeenCalledTimes(4);
    });

    it('moves scoped rows between ordinary and archived membership when archivedAt changes', async () => {
        mockSessionsDomainBoundaries();

        const { buildSessionListRenderableFromSession } = await import('../../domains/session/listing/sessionListRenderable');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);
        const row = buildSessionListRenderableFromSession({
            id: 's1',
            serverId: 'server_1',
            seq: 1,
            createdAt: 1,
            updatedAt: 10,
            active: false,
            activeAt: 10,
            archivedAt: null,
            metadata: null,
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 10,
        } as Session);
        replaceSessionListRows(domain, [row]);

        patchSessionListRows(domain, [{ sessionId: 's1', patch: { archivedAt: 20 } }]);
        expect(get().ordinarySessionListMembershipByServerId.server_1).toEqual([]);
        expect(get().archivedSessionListMembershipByServerId.server_1).toEqual(['s1']);

        patchSessionListRows(domain, [{ sessionId: 's1', patch: { archivedAt: null } }]);
        expect(get().ordinarySessionListMembershipByServerId.server_1).toEqual(['s1']);
        expect(get().archivedSessionListMembershipByServerId.server_1).toEqual([]);
    });

    it('moves materialized membership and rebuilds the owning index across active and inactive Homes', async () => {
        mockSessionsDomainBoundaries();

        const { buildSessionListRenderableFromSession } = await import('../../domains/session/listing/sessionListRenderable');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);
        const base = {
            id: 's1',
            serverId: 'server_1',
            seq: 1,
            createdAt: 1,
            updatedAt: 10,
            active: false,
            activeAt: 10,
            archivedAt: null,
            metadata: null,
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 10,
            encryptionMode: 'plain',
            optimisticThinkingAt: null,
        } as Session;
        domain.applySessions([base]);
        replaceSessionListRows(domain, [buildSessionListRenderableFromSession(base)]);

        domain.applySessions([{ ...base, seq: 2, updatedAt: 20, archivedAt: 20 }]);
        expect(get().ordinarySessionListMembershipByServerId.server_1).toEqual([]);
        expect(get().archivedSessionListMembershipByServerId.server_1).toEqual(['s1']);

        domain.applySessions([{ ...base, seq: 3, updatedAt: 30, archivedAt: null }]);
        expect(get().ordinarySessionListMembershipByServerId.server_1).toEqual(['s1']);
        expect(get().archivedSessionListMembershipByServerId.server_1).toEqual([]);

        const inactiveHome = createHarness(createSessionsDomain);
        const inactiveBase = {
            ...base,
            id: 'inactive-home-session',
            serverId: 'server_2',
        } as Session;
        inactiveHome.domain.applyServerScopedSessionListRows(
            'server_2',
            [buildSessionListRenderableFromSession(inactiveBase)],
            { source: 'ordinary', mode: 'replace' },
        );
        inactiveHome.domain.applySessions([inactiveBase]);
        expect(inactiveHome.get().sessionListIndexByServerId.server_2).toEqual(
            expect.arrayContaining([expect.objectContaining({ type: 'session', sessionId: inactiveBase.id })]),
        );

        inactiveHome.domain.applySessions([{ ...inactiveBase, seq: 2, updatedAt: 20, archivedAt: 20 }]);

        expect(inactiveHome.get().ordinarySessionListMembershipByServerId.server_2).toEqual([]);
        expect(inactiveHome.get().archivedSessionListMembershipByServerId.server_2).toEqual([inactiveBase.id]);
        expect(inactiveHome.get().sessionListIndexByServerId.server_2).toEqual([]);

        inactiveHome.domain.applySessions([{ ...inactiveBase, seq: 3, updatedAt: 30, archivedAt: null }]);

        expect(inactiveHome.get().ordinarySessionListMembershipByServerId.server_2).toEqual([inactiveBase.id]);
        expect(inactiveHome.get().archivedSessionListMembershipByServerId.server_2).toEqual([]);
        expect(inactiveHome.get().sessionListIndexByServerId.server_2).toEqual(
            expect.arrayContaining([expect.objectContaining({ type: 'session', sessionId: inactiveBase.id })]),
        );
    });

    it('applies responsibility only to the exact Home projection and rejects a switched active Account', async () => {
        mockSessionsDomainBoundaries();
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);
        const scope = { serverId: 'server_1', accountId: 'account_a' };
        const original = { id: 'same-id', responsibleAccountId: null };
        get().sessionLocalStateScope = scope;
        get().sessions = { 'same-id': original };
        get().sessionListRowsByServerId = {
            server_1: { 'same-id': original },
            server_2: { 'same-id': original },
        };
        domain.applySessionResponsibleAccount('same-id', 'person-a', scope);
        expect(get().sessionListRowsByServerId.server_1['same-id'].responsibleAccountId).toBe('person-a');
        expect((get().sessionListRowsByServerId['server_1'] ?? {})['same-id'].responsibleAccountId).toBe('person-a');
        expect(get().sessionListRowsByServerId.server_2['same-id']).toBe(original);
        get().sessionLocalStateScope = { ...scope, accountId: 'account_b' };
        domain.applySessionResponsibleAccount('same-id', 'person-b', scope);
        expect(get().sessions['same-id'].responsibleAccountId).toBe('person-a');
        expect(get().sessionListRowsByServerId.server_1['same-id'].responsibleAccountId).toBe('person-a');
    });

    it('preserves store references when an equal responsibility summary has different key order', async () => {
        mockSessionsDomainBoundaries();
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);
        const scope = { serverId: 'server_1', accountId: 'account_a' };
        const summary = {
            kind: 'account' as const,
            accountId: 'person-a',
            firstName: 'Alice',
            lastName: null,
            username: 'alice',
            avatarUrl: null,
        };
        const original = { id: 'same-id', responsibleAccountId: 'person-a', responsibleAccount: summary };
        get().sessionLocalStateScope = scope;
        get().sessions = { 'same-id': original };
        get().sessionListRowsByServerId = { server_1: { 'same-id': original } };
        const sessionsBefore = get().sessions;
        const rowsBefore = get().sessionListRowsByServerId;

        domain.applySessionResponsibleAccount('same-id', 'person-a', scope, {
            avatarUrl: null,
            username: 'alice',
            lastName: null,
            firstName: 'Alice',
            accountId: 'person-a',
            kind: 'account',
        });

        expect(get().sessions).toBe(sessionsBefore);
        expect(get().sessionListRowsByServerId).toBe(rowsBefore);
    });

    it('merges append-page renderables without removing existing list rows omitted from the page', async () => {
        mockSessionsDomainBoundaries();

        const { syncPerformanceTelemetry } = await import('../../runtime/syncPerformanceTelemetry');
        const { buildSessionListRenderableFromSession } = await import('../../domains/session/listing/sessionListRenderable');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);
        const buildRenderable = (id: string, createdAt: number) => buildSessionListRenderableFromSession({
            id,
            seq: createdAt,
            createdAt,
            updatedAt: createdAt,
            active: false,
            activeAt: createdAt,
            metadata: {
                machineId: `machine-${id}`,
                host: `host-${id}`,
                path: `/repo/${id}`,
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } satisfies Session);

        replaceSessionListRows(domain, [buildRenderable('s_existing', 10)]);
        const storedExisting = (get().sessionListRowsByServerId['server_1'] ?? {}).s_existing;
        syncPerformanceTelemetry.configure({ enabled: true, slowThresholdMs: 0 });
        syncPerformanceTelemetry.reset();

        mergeSessionListRows(domain, [buildRenderable('s_appended', 5)]);

        expect((get().sessionListRowsByServerId['server_1'] ?? {}).s_existing).toBe(storedExisting);
        expect((get().sessionListRowsByServerId['server_1'] ?? {}).s_appended).toEqual(expect.objectContaining({
            id: 's_appended',
            createdAt: 5,
        }));
        const activeServerIndex = get().sessionListIndexByServerId.server_1 ?? [];
        expect(activeServerIndex.filter((item: any) => item.type === 'session').map((item: any) => item.sessionId)).toEqual([
            's_existing',
            's_appended',
        ]);
        const events = syncPerformanceTelemetry.snapshot().events;
        expect(events.some((event) => event.name === 'sync.store.sessions.renderables.replace')).toBe(false);
        expect(events.find((event) => event.name === 'sync.store.sessions.renderables.merge')?.fields).toMatchObject({
            incoming: 1,
            previous: 1,
            changed: 1,
            removed: 0,
            indexRebuild: 1,
        });
        syncPerformanceTelemetry.configure({ enabled: false });
    });

    it('defers warm cache persistence when patching unhydrated session list renderables', async () => {
        vi.useFakeTimers();
        mockSessionsDomainBoundaries();

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const { syncPerformanceTelemetry } = await import('../../runtime/syncPerformanceTelemetry');
        const { buildSessionListRenderableFromSession } = await import('../../domains/session/listing/sessionListRenderable');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        try {
            replaceSessionListRows(domain, [buildSessionListRenderableFromSession({
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
            expect((get().sessionListRowsByServerId['server_1'] ?? {})['s1']?.active).toBe(true);
            syncPerformanceTelemetry.configure({ enabled: true, slowThresholdMs: 0 });
            syncPerformanceTelemetry.reset();

            patchSessionListRows(domain, [
                { sessionId: 's1', patch: { active: false, activeAt: 20, presence: 20 } },
            ]);

            expect((get().sessionListRowsByServerId['server_1'] ?? {})['s1']?.active).toBe(false);
            expect(get().sessionListIndexByServerId['server_1']).not.toBeUndefined();
            const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
            expect(saveWarmCache).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(1_000);
            expect(saveWarmCache).toHaveBeenCalledTimes(2);
            const lastCall = saveWarmCache.mock.calls.at(-1);
            const entries = lastCall?.[2] as Record<string, any>;
            expect(entries?.s1?.active).toBe(false);
            expect(entries?.s1?.activeAt).toBe(20);
            const indexRebuildEvent = syncPerformanceTelemetry.snapshot().events.find(
                (candidate) => candidate.name === 'sync.store.sessions.renderables.patch.indexRebuild',
            );
            expect(indexRebuildEvent?.count).toBe(1);
            expect(indexRebuildEvent?.fields.renderables).toBe(1);
            const patchEvent = syncPerformanceTelemetry.snapshot().events.find(
                (candidate) => candidate.name === 'sync.store.sessions.renderables.patch',
            );
            expect(patchEvent?.fields.listViewFieldChanges).toBe(1);
            const warmCacheEvent = syncPerformanceTelemetry.snapshot().events.find(
                (candidate) => candidate.name === 'sync.store.sessions.renderables.patch.warmCache.deferred',
            );
            expect(warmCacheEvent?.count).toBe(1);
            expect(warmCacheEvent?.fields.renderables).toBe(1);
            const events = syncPerformanceTelemetry.snapshot().events;
            expect(events.find((event) => event.name === 'sync.store.sessions.warmCache.schedule')?.fields).toEqual(expect.objectContaining({
                coalesced: 0,
                renderables: 1,
                scheduled: 1,
            }));
            expect(events.find((event) => event.name === 'sync.store.sessions.warmCache.flush')?.fields).toEqual(expect.objectContaining({
                renderables: 1,
            }));
        } finally {
            syncPerformanceTelemetry.configure({ enabled: false });
            vi.useRealTimers();
        }
    });

    it('preserves warm-cache payload for non-semantic renderable patches', async () => {
        mockSessionsDomainBoundaries();

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const { buildSessionListRenderableFromSession } = await import('../../domains/session/listing/sessionListRenderable');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        replaceSessionListRows(domain, [buildSessionListRenderableFromSession({
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

        const initialRenderables = (get().sessionListRowsByServerId['server_1'] ?? {});
        const initialRenderable = initialRenderables['s1'];
        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        expect(initialRenderable).toBeDefined();
        expect(saveWarmCache).toHaveBeenCalledTimes(1);

        patchSessionListRows(domain, [
            { sessionId: 's1', patch: { presence: 20 } },
        ]);

        expect((get().sessionListRowsByServerId['server_1'] ?? {})).not.toBe(initialRenderables);
        expect((get().sessionListRowsByServerId['server_1'] ?? {})['s1']).not.toBe(initialRenderable);
        expect((get().sessionListRowsByServerId['server_1'] ?? {})['s1']).toEqual(expect.objectContaining({
            presence: 20,
        }));
        const initialEntries = saveWarmCache.mock.calls.at(0)?.[2] as Record<string, any>;
        const latestEntries = saveWarmCache.mock.calls.at(-1)?.[2] as Record<string, any>;
        expect(latestEntries).toEqual(initialEntries);
    });

    it('preserves previous canonical renderable metadata when a replacement renderable is still stale', async () => {
        mockSessionsDomainBoundaries();

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const { syncPerformanceTelemetry } = await import('../../runtime/syncPerformanceTelemetry');
        const { buildSessionListRenderableFromSession } = await import('../../domains/session/listing/sessionListRenderable');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);
        syncPerformanceTelemetry.configure({ enabled: true, slowThresholdMs: 0 });
        syncPerformanceTelemetry.reset();

        replaceSessionListRows(domain, [buildSessionListRenderableFromSession({
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
            pendingBlockedCount: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any)]);
        syncPerformanceTelemetry.reset();

        replaceSessionListRows(domain, [
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

        expect((get().sessionListRowsByServerId['server_1'] ?? {}).s1).toEqual(expect.objectContaining({
            id: 's1',
            updatedAt: 20,
            pendingCount: 2,
            pendingBlockedCount: 1,
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
            pendingBlockedCount: 1,
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

        const replaceEvent = syncPerformanceTelemetry.snapshot().events.filter(
            (candidate) => candidate.name === 'sync.store.sessions.renderables.replace',
        ).at(-1);
        expect(replaceEvent?.fields).toMatchObject({
            incoming: 1,
            previous: 1,
            changed: 1,
            removed: 0,
            noop: 0,
            listRebuild: 0,
            listViewFieldChanges: 0,
            staleMetadataPreserved: 1,
            stalePendingFlagsPreserved: 1,
            warmCacheRelevant: 1,
        });
        syncPerformanceTelemetry.configure({ enabled: false });
    });

    it('does not rebuild the active list index when merging a renderable only updates warm-cache fields', async () => {
        mockSessionsDomainBoundaries();

        const { syncPerformanceTelemetry } = await import('../../runtime/syncPerformanceTelemetry');
        const { buildSessionListRenderableFromSession } = await import('../../domains/session/listing/sessionListRenderable');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        replaceSessionListRows(domain, [buildSessionListRenderableFromSession({
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
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any)]);
        const initialIndex = get().sessionListIndexByServerId.server_1;
        syncPerformanceTelemetry.configure({ enabled: true, slowThresholdMs: 0 });
        syncPerformanceTelemetry.reset();

        mergeSessionListRows(domain, [{
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 20,
            active: true,
            activeAt: 20,
            pendingCount: 1,
            pendingVersion: 2,
            metadataVersion: 2,
            agentStateVersion: 1,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any]);

        expect((get().sessionListRowsByServerId['server_1'] ?? {}).s1).toEqual(expect.objectContaining({
            id: 's1',
            updatedAt: 20,
            metadataVersion: 1,
            agentStateVersion: 0,
            metadata: expect.objectContaining({
                name: 'Cached title',
                path: '/home/u/repo',
                homeDir: '/home/u',
                machineId: 'm1',
            }),
        }));
        expect(get().sessionListIndexByServerId.server_1).toBe(initialIndex);

        const mergeEvent = syncPerformanceTelemetry.snapshot().events.filter(
            (candidate) => candidate.name === 'sync.store.sessions.renderables.merge',
        ).at(-1);
        expect(mergeEvent?.fields).toMatchObject({
            incoming: 1,
            previous: 1,
            changed: 1,
            listRebuild: 0,
            listViewFieldChanges: 0,
            staleMetadataPreserved: 1,
            stalePendingFlagsPreserved: 1,
            warmCacheRelevant: 1,
        });
        syncPerformanceTelemetry.configure({ enabled: false });
    });

    it('preserves direct-session classification when a replacement renderable omits externalSessionV1', async () => {
        mockSessionsDomainBoundaries();

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const { buildSessionListRenderableFromSession } = await import('../../domains/session/listing/sessionListRenderable');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        replaceSessionListRows(domain, [buildSessionListRenderableFromSession({
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
                externalSessionV1: {
                    v: 1,
                    agentId: 'claude',
                    machineId: 'm1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
                },
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 10,
        } as any)]);

        replaceSessionListRows(domain, [
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

        expect((get().sessionListRowsByServerId['server_1'] ?? {}).s1).toEqual(expect.objectContaining({
            id: 's1',
            updatedAt: 20,
            metadata: expect.objectContaining({
                name: 'Direct session',
                path: '/home/u/repo',
                homeDir: '/home/u',
                machineId: 'm1',
                externalSessionV1: {
                    v: 1,
                    agentId: 'claude',
                    machineId: 'm1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
                },
            }),
        }));

        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        const lastCall = saveWarmCache.mock.calls.at(-1);
        const entries = lastCall?.[2] as Record<string, any>;
        expect(entries?.s1?.externalSessionV1).toEqual({
            v: 1,
            agentId: 'claude',
            machineId: 'm1',
            remoteSessionId: 'remote-1',
            source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
        });
    });

    it('skips no-op renderable patches', async () => {
        mockSessionsDomainBoundaries();

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const warmCacheAdapters = await import('../../domains/state/warmCacheAdapters');
        const { syncPerformanceTelemetry } = await import('../../runtime/syncPerformanceTelemetry');
        const { buildSessionListRenderableFromSession } = await import('../../domains/session/listing/sessionListRenderable');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);
        syncPerformanceTelemetry.configure({ enabled: true, slowThresholdMs: 0 });
        syncPerformanceTelemetry.reset();

        replaceSessionListRows(domain, [buildSessionListRenderableFromSession({
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

        const initialRenderables = (get().sessionListRowsByServerId['server_1'] ?? {});
        const initialRenderable = initialRenderables['s1'];
        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        const buildPreviousEntries = warmCacheAdapters.buildPersistedSessionListCacheEntriesFromRenderables as unknown as ReturnType<typeof vi.fn>;
        expect(initialRenderable).toBeDefined();
        expect(saveWarmCache).toHaveBeenCalledTimes(1);
        buildPreviousEntries.mockClear();

        patchSessionListRows(domain, [
            { sessionId: 's1', patch: { pendingCount: 0, pendingVersion: 1 } },
        ]);

        expect((get().sessionListRowsByServerId['server_1'] ?? {})).toBe(initialRenderables);
        expect((get().sessionListRowsByServerId['server_1'] ?? {})['s1']).toBe(initialRenderable);
        expect(saveWarmCache).toHaveBeenCalledTimes(1);
        expect(buildPreviousEntries).not.toHaveBeenCalled();

        const patchEvent = syncPerformanceTelemetry.snapshot().events.filter(
            (candidate) => candidate.name === 'sync.store.sessions.renderables.patch',
        ).at(-1);
        expect(patchEvent?.fields).toMatchObject({
            patches: 1,
            changed: 0,
            noopPatches: 1,
            missing: 0,
            listRebuild: 0,
            listViewFieldChanges: 0,
            warmCacheRelevant: 0,
        });
        syncPerformanceTelemetry.configure({ enabled: false });
    });

    it('removes ordinary membership missing from a same-size full replacement while retaining canonical rows', async () => {
        mockSessionsDomainBoundaries();

        const { buildSessionListRenderableFromSession } = await import('../../domains/session/listing/sessionListRenderable');
        const { syncPerformanceTelemetry } = await import('../../runtime/syncPerformanceTelemetry');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);
        const buildRenderable = (id: string, updatedAt: number) => {
            const session = {
                id,
                seq: updatedAt,
                createdAt: updatedAt,
                updatedAt,
                active: true,
                activeAt: updatedAt,
                pendingCount: 0,
                pendingVersion: 0,
                metadata: {
                    machineId: `machine-${id}`,
                    host: `host-${id}`,
                    path: `/repo/${id}`,
                },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            } satisfies Session;
            return buildSessionListRenderableFromSession(session);
        };

        replaceSessionListRows(domain, [
            buildRenderable('s1', 1),
            buildRenderable('s2', 2),
        ]);
        syncPerformanceTelemetry.configure({ enabled: true, slowThresholdMs: 0 });
        syncPerformanceTelemetry.reset();

        replaceSessionListRows(domain, [
            buildRenderable('s2', 3),
            buildRenderable('s3', 4),
        ]);

        expect(Object.keys((get().sessionListRowsByServerId['server_1'] ?? {})).sort()).toEqual(['s1', 's2', 's3']);
        expect(get().ordinarySessionListMembershipByServerId['server_1']).toEqual(['s2', 's3']);
        expect((get().sessionListRowsByServerId['server_1'] ?? {}).s1).toBeDefined();
        expect((get().sessionListIndexByServerId['server_1'] ?? []).some(
            (item: { type: string; sessionId?: string }) => item.type === 'session' && item.sessionId === 's1',
        )).toBe(false);
        const indexRebuildEvent = syncPerformanceTelemetry.snapshot().events.find(
            (candidate) => candidate.name === 'sync.store.sessions.renderables.replace.indexRebuild',
        );
        expect(indexRebuildEvent?.count).toBe(1);
        expect(indexRebuildEvent?.fields.renderables).toBe(2);
        const warmCacheEvent = syncPerformanceTelemetry.snapshot().events.find(
            (candidate) => candidate.name === 'sync.store.sessions.renderables.replace.warmCache',
        );
        expect(warmCacheEvent?.count).toBe(1);
        expect(warmCacheEvent?.fields.renderables).toBe(2);
        syncPerformanceTelemetry.configure({ enabled: false });
    });

    it('skips identical renderable replacements', async () => {
        mockSessionsDomainBoundaries();

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const warmCacheAdapters = await import('../../domains/state/warmCacheAdapters');
        const { buildSessionListRenderableFromSession } = await import('../../domains/session/listing/sessionListRenderable');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        replaceSessionListRows(domain, [buildSessionListRenderableFromSession({
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

        const initialRenderables = (get().sessionListRowsByServerId['server_1'] ?? {});
        const initialRenderable = initialRenderables['s1'];
        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        const buildPreviousEntries = warmCacheAdapters.buildPersistedSessionListCacheEntriesFromRenderables as unknown as ReturnType<typeof vi.fn>;
        expect(initialRenderable).toBeDefined();
        expect(saveWarmCache).toHaveBeenCalledTimes(1);
        buildPreviousEntries.mockClear();

        replaceSessionListRows(domain, [
            {
                ...initialRenderable,
                metadata: initialRenderable?.metadata ? { ...initialRenderable.metadata } : null,
            },
        ]);

        expect((get().sessionListRowsByServerId['server_1'] ?? {})).toBe(initialRenderables);
        expect((get().sessionListRowsByServerId['server_1'] ?? {})['s1']).toBe(initialRenderable);
        expect(saveWarmCache).toHaveBeenCalledTimes(1);
        expect(buildPreviousEntries).not.toHaveBeenCalled();
    });
});
