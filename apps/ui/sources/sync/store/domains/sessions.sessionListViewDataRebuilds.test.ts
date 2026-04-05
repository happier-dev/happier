import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSessionListRenderableFromSession } from '../../domains/session/listing/sessionListRenderable';
import type { SessionListViewItem } from '../../domains/session/listing/sessionListViewData';

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

function mockSessionPersistenceBoundaries(options?: { trackWarmCacheEntries?: boolean }): void {
    let lastWarmCacheEntries: Record<string, unknown> | null = null;
    const shouldTrackWarmCacheEntries = options?.trackWarmCacheEntries === true;
    const resolveWarmCacheAccountScope = vi.fn((fallback: string | null | undefined) => fallback ?? null);
    const peekSessionListWarmCacheEntries = shouldTrackWarmCacheEntries
        ? vi.fn(() => lastWarmCacheEntries)
        : vi.fn(() => null);
    const saveSessionListWarmCacheEntries = shouldTrackWarmCacheEntries
        ? vi.fn((serverId: string | null | undefined, accountId: string | null | undefined, entries: Record<string, unknown>) => {
            lastWarmCacheEntries = entries;
        })
        : vi.fn();
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
        resolveWarmCacheAccountScope,
        peekSessionListWarmCacheEntries,
        saveSessionListWarmCacheEntries,
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

describe('sessions domain: sessionListViewData rebuild gating', () => {
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
        mockSessionPersistenceBoundaries({ trackWarmCacheEntries: true });
        const resolveActiveServerSessionListStateSpy = vi.fn();
        vi.doMock('../resolveActiveServerSessionListState', async () => {
            const actual = await vi.importActual<typeof import('../resolveActiveServerSessionListState')>('../resolveActiveServerSessionListState');
            return {
                ...actual,
                resolveActiveServerSessionListState: (params: Parameters<typeof actual.resolveActiveServerSessionListState>[0]) => {
                    resolveActiveServerSessionListStateSpy(params);
                    return actual.resolveActiveServerSessionListState(params);
                },
            };
        });

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
        expect(resolveActiveServerSessionListStateSpy).toHaveBeenCalledTimes(1);
    });

    it('reuses the previous renderable object for semantically identical applySessions refreshes', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries({ trackWarmCacheEntries: true });

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

        const initialRenderable = get().sessionListRenderables['s1'];
        const initialViewData = get().sessionListViewData;
        expect(initialRenderable).toBeDefined();
        expect(Array.isArray(initialViewData)).toBe(true);

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

        expect(get().sessionListRenderables['s1']).toBe(initialRenderable);
        expect(get().sessionListViewData).toBe(initialViewData);
    });

    it('reuses the previous session object for semantically identical applySessions refreshes', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        domain.applySessions([
            {
                id: 's1',
                serverId: 'server-1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                pendingCount: 0,
                pendingVersion: 1,
                metadata: {
                    machineId: 'm1',
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                    summary: { text: 'hello', updatedAt: 1 },
                },
                metadataVersion: 1,
                agentState: {
                    requests: {},
                    completedRequests: {},
                    localControl: null,
                    capabilities: {},
                },
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
                todos: [
                    {
                        id: 'todo-1',
                        content: 'Check session reuse',
                        status: 'pending',
                        priority: 'medium',
                    },
                ],
                ownerProfile: {
                    id: 'owner-1',
                    username: 'owner',
                    firstName: 'Own',
                    lastName: 'Er',
                    avatar: null,
                },
                accessLevel: 'admin',
                canApprovePermissions: true,
            } as any,
        ]);

        const initialSession = get().sessions['s1'];
        expect(initialSession).toBeDefined();

        domain.applySessions([
            {
                id: 's1',
                serverId: 'server-1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                pendingCount: 0,
                pendingVersion: 1,
                metadata: {
                    machineId: 'm1',
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                    summary: { text: 'hello', updatedAt: 1 },
                },
                metadataVersion: 1,
                agentState: {
                    requests: {},
                    completedRequests: {},
                    localControl: null,
                    capabilities: {},
                },
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
                todos: [
                    {
                        id: 'todo-1',
                        content: 'Check session reuse',
                        status: 'pending',
                        priority: 'medium',
                    },
                ],
                ownerProfile: {
                    id: 'owner-1',
                    username: 'owner',
                    firstName: 'Own',
                    lastName: 'Er',
                    avatar: null,
                },
                accessLevel: 'admin',
                canApprovePermissions: true,
            } as any,
        ]);

        expect(get().sessions['s1']).toBe(initialSession);
    });

    it('skips map churn and warm-cache writes for a semantically identical applySessions batch', async () => {
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
                serverId: 'server-1',
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
        const initialViewData = get().sessionListViewData;
        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        expect(saveWarmCache).toHaveBeenCalledTimes(1);

        domain.applySessions([
            {
                id: 's1',
                serverId: 'server-1',
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

        expect(get().sessions).toBe(initialSessions);
        expect(get().sessionListRenderables).toBe(initialRenderables);
        expect(get().sessionListViewData).toBe(initialViewData);
        expect(saveWarmCache).toHaveBeenCalledTimes(1);
    });

    it('preserves previous warm-cache metadata when applySessions receives a stale replacement row', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const { createSessionsDomain } = await import('./sessions');
        const { domain } = createHarness(createSessionsDomain);

        domain.applySessions([
            {
                id: 's1',
                serverId: 'server-1',
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
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
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
                serverId: 'server-1',
                seq: 1,
                createdAt: 1,
                updatedAt: 20,
                active: true,
                activeAt: 20,
                metadata: null,
                metadataVersion: 2,
                agentState: null,
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any,
        ]);

        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        const lastCall = saveWarmCache.mock.calls.at(-1);
        const entries = lastCall?.[2] as Record<string, any>;

        expect(entries?.s1).toEqual(expect.objectContaining({
            sessionId: 's1',
            updatedAt: 20,
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

    it('keeps sessionListViewData reference stable for non-structural renderable patches', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        domain.replaceSessionListRenderables([
            buildSessionListRenderableFromSession({
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                pendingCount: 0,
                pendingVersion: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            } as any),
        ]);

        const initial = get().sessionListViewData;
        expect(Array.isArray(initial)).toBe(true);

        domain.applySessionListRenderablePatches([
            {
                sessionId: 's1',
                patch: {
                    pendingCount: 4,
                    pendingVersion: 8,
                },
            },
        ]);

        expect(get().sessionListRenderables['s1']).toEqual(expect.objectContaining({
            pendingCount: 4,
            pendingVersion: 8,
        }));
        expect(get().sessionListViewData).toBe(initial);
    });

    it('keeps sessionListViewData reference stable for non-structural renderable replacement', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries();

        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain);

        domain.replaceSessionListRenderables([
            buildSessionListRenderableFromSession({
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                pendingCount: 0,
                pendingVersion: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            } as any),
        ]);

        const initial = get().sessionListViewData;
        expect(Array.isArray(initial)).toBe(true);

        domain.replaceSessionListRenderables([
            {
                ...get().sessionListRenderables['s1'],
                updatedAt: 2,
                presence: 2,
                pendingCount: 4,
                pendingVersion: 8,
            },
        ]);

        expect(get().sessionListRenderables['s1']).toEqual(expect.objectContaining({
            updatedAt: 2,
            pendingCount: 4,
            pendingVersion: 8,
        }));
        expect(get().sessionListViewData).toBe(initial);
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

    it('skips reachable peer scans for row-only applySessions updates that cannot affect canonical targets', async () => {
        const updateSessions = vi.fn();
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions },
        }));
        mockSessionPersistenceBoundaries();

        const resolveSessionMachineRpcTargetSpy = vi.fn();
        vi.doMock('../../domains/session/resolveSessionReachableMachineId', async () => {
            const actual = await vi.importActual<typeof import('../../domains/session/resolveSessionReachableMachineId')>(
                '../../domains/session/resolveSessionReachableMachineId',
            );
            return {
                ...actual,
                resolveSessionMachineRpcTarget: (params: Parameters<typeof actual.resolveSessionMachineRpcTarget>[0]) => {
                    resolveSessionMachineRpcTargetSpy(params);
                    return actual.resolveSessionMachineRpcTarget(params);
                },
            };
        });

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
        const initialResolveCallCount = resolveSessionMachineRpcTargetSpy.mock.calls.length;

        domain.applySessions([
            {
                id: 's2',
                seq: 2,
                createdAt: 2,
                updatedAt: 100,
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
        expect(resolveSessionMachineRpcTargetSpy).toHaveBeenCalledTimes(initialResolveCallCount);
    });

    it('rebuilds sessionListViewData when a peer project lookup changes and can retarget a stale session', async () => {
        const updateSessions = vi.fn();
        const resolveSessionMachineRpcTargetSpy = vi.fn();
        let peerProjectMachineId = 'm-b';
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: {
                updateSessions,
            },
        }));
        vi.doMock('../../domains/session/resolveSessionReachableMachineId', async () => {
            const actual = await vi.importActual<typeof import('../../domains/session/resolveSessionReachableMachineId')>(
                '../../domains/session/resolveSessionReachableMachineId',
            );
            return {
                ...actual,
                resolveSessionMachineRpcTarget: (params: Parameters<typeof actual.resolveSessionMachineRpcTarget>[0]) => {
                    resolveSessionMachineRpcTargetSpy(params);
                    return actual.resolveSessionMachineRpcTarget(params);
                },
            };
        });
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
        get().getProjectForSession = (sessionId: string) => {
            if (sessionId === 's2') {
                return {
                    id: 'project-s2',
                    key: {
                        serverId: 'server-1',
                        machineId: peerProjectMachineId,
                        rootPath: '/home/u/repo',
                    },
                    sessionIds: ['s2'],
                    createdAt: 1,
                    updatedAt: 1,
                };
            }
            return null;
        };

        domain.applySessions([
            {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 10,
                active: true,
                activeAt: 10,
                metadata: { path: '/home/u/repo', homeDir: '/home/u' },
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
                metadata: { path: '/home/u/repo', homeDir: '/home/u' },
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

        const initialSessionItems = (initial ?? []) as SessionListViewItem[];
        const initialSessionItem = initialSessionItems.find((item) => {
            if (item.type !== 'session') return false;
            return item.session.id === 's1';
        });
        expect(initialSessionItem?.session.metadata?.machineId).toBe('m-b');
        const initialResolveCallCount = resolveSessionMachineRpcTargetSpy.mock.calls.length;

        peerProjectMachineId = 'm-a';
        domain.applySessions([
            {
                id: 's2',
                seq: 2,
                createdAt: 2,
                updatedAt: 101,
                active: true,
                activeAt: 100,
                metadata: { path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 2,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any,
        ]);

        expect(resolveSessionMachineRpcTargetSpy.mock.calls.length).toBeGreaterThan(initialResolveCallCount);
        expect(updateSessions).toHaveBeenCalled();
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
        expect(saveWarmCache).toHaveBeenCalledTimes(2);
    });

    it('reuses the previous warm-cache renderable map when applySessions updates only one warm-cache relevant row', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: { updateSessions: vi.fn() },
        }));
        mockSessionPersistenceBoundaries({ trackWarmCacheEntries: true });
        vi.doMock('../../domains/state/warmCacheAdapters', async () => {
            const actual = await vi.importActual<typeof import('../../domains/state/warmCacheAdapters')>('../../domains/state/warmCacheAdapters');
            return {
                ...actual,
                buildSessionListCacheEntriesFromRenderables: vi.fn(actual.buildSessionListCacheEntriesFromRenderables),
            };
        });

        const warmCache = await import('../../domains/state/warmCachePersistence');
        const warmCacheAdapters = await import('../../domains/state/warmCacheAdapters');
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
            {
                id: 's2',
                seq: 2,
                createdAt: 2,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm2', path: '/home/u/repo-2', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any,
        ]);

        const saveWarmCache = warmCache.saveSessionListWarmCacheEntries as unknown as ReturnType<typeof vi.fn>;
        const buildPreviousEntries = warmCacheAdapters.buildSessionListCacheEntriesFromRenderables as unknown as ReturnType<typeof vi.fn>;
        const initialViewData = get().sessionListViewData;
        expect(Array.isArray(initialViewData)).toBe(true);
        expect(saveWarmCache).toHaveBeenCalledTimes(1);

        const firstEntries = saveWarmCache.mock.calls[0]?.[2] as Record<string, unknown>;
        expect(firstEntries).toBeDefined();

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
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
                pendingCount: 1,
                pendingVersion: 2,
            } as any,
        ]);

        expect(get().sessionListViewData).toBe(initialViewData);
        expect(saveWarmCache).toHaveBeenCalledTimes(2);
        expect(buildPreviousEntries.mock.calls[1]?.[1]).toBe(firstEntries);
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
});
