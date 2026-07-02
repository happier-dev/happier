import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../domains/state/storageTypes';

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.restoreAllMocks();
});

function mockSessionsDomainBoundaries() {
    vi.doMock('../../domains/state/persistence', () => ({
        loadSettings: vi.fn(() => ({
            settings: { groupInactiveSessionsByProject: false },
            version: null,
        })),
        loadLocalSettings: vi.fn(() => ({})),
        loadPendingSettings: vi.fn(() => ({})),
        loadPurchases: vi.fn(() => ({})),
        loadProfile: vi.fn(() => ({ id: 'account_a' })),
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
        resolveWarmCacheAccountScope: vi.fn(() => null),
        peekSessionListWarmCacheEntries: vi.fn(() => null),
        saveSessionListWarmCacheEntries: vi.fn(),
    }));
    vi.doMock('../../domains/state/warmCacheAdapters', async () => {
        const actual = await vi.importActual<typeof import('../../domains/state/warmCacheAdapters')>('../../domains/state/warmCacheAdapters');
        return {
            ...actual,
            buildSessionListCacheEntriesFromRenderables: vi.fn(() => []),
        };
    });
    vi.doMock('../../domains/session/listing/applyReachableTargetsToSessionListRenderables', () => ({
        applyReachableTargetsToSessionListRenderables: vi.fn(({ sessions }) => sessions),
    }));
    vi.doMock('../sessionListIndex/buildSessionListIndexWithServerScope', () => ({
        buildActiveServerSessionListIndex: vi.fn(() => []),
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
    findModelOptionForEffectiveModelId: (options: any, effectiveModelId: any) =>
        options?.find?.((option: any) => option.value === effectiveModelId)
            ?? options?.find?.((option: any) => option.value === String(effectiveModelId ?? '').replace(/\[[^\]]*\]$/u, ''))
            ?? null,
        isModelSelectableForSession: vi.fn(() => true),
    }));
    vi.doMock('@/agents/registry/registryCore', () => ({
        AGENT_IDS: [],
        DEFAULT_AGENT_ID: 'openai',
        resolveAgentIdFromFlavor: vi.fn(() => null),
    }));
}

function createHarness(createSessionsDomain: any, createReducer: any) {
    let state: any = {
        sessions: {},
        sessionListRenderables: {},
        concurrentSessionListCacheByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed: {},
        sessionRepositoryTreeExpandedPathsBySessionId: {},
        reviewCommentsDraftsBySessionId: {},
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

        const scheduledTimeouts = new Map<number, () => void>();
        let nextTimeoutId = 1;
        let nowMs = Date.parse('2026-02-05T00:00:00.000Z');

        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: Parameters<typeof setTimeout>[0]) => {
            const timeoutId = nextTimeoutId++;
            if (typeof callback === 'function') {
                scheduledTimeouts.set(timeoutId, callback as () => void);
            }
            return timeoutId as unknown as ReturnType<typeof setTimeout>;
        });
        vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timeoutId: Parameters<typeof clearTimeout>[0]) => {
            scheduledTimeouts.delete(timeoutId as unknown as number);
        });

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
            } satisfies Session,
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
            } satisfies Session,
        ]);

        const graceUntil = get().sessions.s1?.thinkingGraceUntil ?? null;
        expect(typeof graceUntil).toBe('number');
        expect(graceUntil).toBeGreaterThan(t1);
        expect(scheduledTimeouts.size).toBe(1);

        // Once the grace timer expires, the marker clears without polling.
        nowMs = (graceUntil as number) + 1;
        const expireThinkingGrace = scheduledTimeouts.values().next().value;
        expect(typeof expireThinkingGrace).toBe('function');
        expireThinkingGrace?.();

        expect(get().sessions.s1?.thinkingGraceUntil ?? null).toBeNull();
    });

    it('clears optimistic thinking and grace when a terminal primary turn projection arrives', async () => {
        mockSessionsDomainBoundaries();

        const scheduledTimeouts = new Map<number, () => void>();
        let nextTimeoutId = 1;
        let nowMs = Date.parse('2026-02-05T00:00:00.000Z');

        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: Parameters<typeof setTimeout>[0]) => {
            const timeoutId = nextTimeoutId++;
            if (typeof callback === 'function') {
                scheduledTimeouts.set(timeoutId, callback as () => void);
            }
            return timeoutId as unknown as ReturnType<typeof setTimeout>;
        });
        vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timeoutId: Parameters<typeof clearTimeout>[0]) => {
            scheduledTimeouts.delete(timeoutId as unknown as number);
        });

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
                latestTurnStatus: 'in_progress',
                thinking: true,
                thinkingAt: t0,
                presence: 'online',
            } satisfies Session,
        ]);
        domain.markSessionOptimisticThinking('s1');

        expect(get().sessions.s1?.optimisticThinkingAt ?? null).not.toBeNull();

        nowMs += 250;
        domain.applySessions([
            {
                id: 's1',
                seq: 0,
                createdAt: t0,
                updatedAt: nowMs,
                active: true,
                activeAt: nowMs,
                metadata: null,
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 1,
                latestTurnStatus: 'completed',
                thinking: false,
                thinkingAt: nowMs,
                presence: 'online',
            } satisfies Session,
        ]);

        expect(get().sessions.s1?.latestTurnStatus).toBe('completed');
        expect(get().sessions.s1?.thinking).toBe(false);
        expect(get().sessions.s1?.optimisticThinkingAt ?? null).toBeNull();
        expect(get().sessions.s1?.thinkingGraceUntil ?? null).toBeNull();
        expect(scheduledTimeouts.size).toBe(0);
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
            } satisfies Session,
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
            } satisfies Session,
        ]);

        expect(get().sessions.s1?.thinking).toBe(false);
        expect(get().sessions.s1?.thinkingAt).toBe(nowMs - 10);
        expect(get().sessions.s1?.thinkingGraceUntil ?? null).toBeNull();
        expect(get().sessionListRenderables.s1?.thinking).toBe(false);
        expect(get().sessionListRenderables.s1?.thinkingGraceUntil ?? null).toBeNull();
        expect(globalThis.setTimeout).toHaveBeenCalledTimes(0);
    });
});
