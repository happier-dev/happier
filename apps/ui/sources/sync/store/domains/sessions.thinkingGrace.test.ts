import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../domains/state/storageTypes';

import { storage } from '@/sync/domains/state/storage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { activatePendingQueueScope } from '../../engine/pending/pendingQueueV2.testHelpers';

beforeEach(async () => {
    await loadSyncSingletonForTests();
    storage.setState(storage.getInitialState(), true);
    await activatePendingQueueScope({ serverId: 'server_1', accountId: 'account_a' });
});

afterEach(() => {
    storage.setState(storage.getInitialState(), true);
    vi.clearAllMocks();
    vi.restoreAllMocks();
});

function createHarness(_createSessionsDomain: unknown, createReducer: typeof import('@happier-dev/session-core/reducer').createReducer, initialStateOverrides: Record<string, unknown> = {}) {
    storage.setState({
        sessionMessages: {
            s1: {
                messageIdsOldestFirst: [],
                messagesById: {},
                messagesMap: {},
                reducerState: createReducer(),
                latestThinkingMessageId: null,
                latestThinkingMessageActivityAtMs: null,
                messagesVersion: 0,
                isLoaded: true,
            },
        },
        ...initialStateOverrides,
    });
    return { get: storage.getState, domain: storage.getState() };
}

describe('sessions domain: thinking grace', () => {
    it.each([
        { recency: 'creation', hasHistory: false },
        { recency: 'loaded history', hasHistory: true },
    ])('owns a bounded resuming marker until genuine post-attach activity settles it ($recency)', async ({ hasHistory }) => {
        const scheduledTimeouts = new Map<number, { callback: () => void; delay: number }>();
        let nextTimeoutId = 1;
        let nowMs = Date.parse('2026-02-05T00:00:00.000Z');
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
            const timeoutId = nextTimeoutId++;
            if (typeof callback === 'function') {
                scheduledTimeouts.set(timeoutId, {
                    callback: callback as () => void,
                    delay: typeof delay === 'number' ? delay : 0,
                });
            }
            return timeoutId as unknown as ReturnType<typeof setTimeout>;
        });
        vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timeoutId: Parameters<typeof clearTimeout>[0]) => {
            scheduledTimeouts.delete(timeoutId as unknown as number);
        });

        const { createReducer } = await import("@happier-dev/session-core/reducer");
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, createReducer, {
            sessionListRowsByServerId: { server_1: {} },
            sessionListIndexByServerId: {},
        });
        const baseSession = (overrides: Partial<Session>): Session => ({
            id: 's1',
            serverId: 'server_1',
            seq: 0,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            metadata: null,
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
            ...overrides,
        });

        const { fetchAndApplySessionById } = await import('../../engine/sessions/sessionById');
        const hydration = await fetchAndApplySessionById({
            sessionId: 's1',
            serverId: 'server_1',
            credentials: { token: 'plain-account-token' },
            accountCurrentness: {
                mode: 'plain', signingKeyFingerprint: null,
                contentKeyFingerprint: null, updatedAt: 1,
            },
            // The production plaintext Account adapter has no client encryption material.
            encryption: {
                decryptEncryptionKey: async () => null,
                initializeSessions: async () => {},
                getSessionEncryption: () => null,
            },
            sessionDataKeys: new Map(),
            request: async () => Response.json({ session: {
                id: 's1', seq: 0, createdAt: 1, updatedAt: 1,
                active: false, activeAt: 1, encryptionMode: 'plain',
                metadata: '{}', metadataVersion: 0,
                agentState: '{}', agentStateVersion: 1,
                dataEncryptionKey: null, share: null,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: nowMs - 60_000,
                // The admitted legacy HTTP carrier omits meaningfulActivityAt.
            } }),
            applySessions: domain.applySessions,
            getExistingSession: (id) => get().sessions[id],
            log: { log: () => {} },
            includeTurnsProjection: false,
        });
        expect(hydration.ok).toBe(true);
        if (hasHistory) {
            domain.applyMessages('s1', [{
                id: 'historical-message', seq: 1, localId: null, createdAt: 100,
                isSidechain: false, role: 'agent',
                content: [{ type: 'text', text: 'Earlier activity', uuid: 'historical-message', parentUUID: null }],
            }]);
        }
        const ownedRow = get().sessionListRowsByServerId.server_1?.s1;
        if (!ownedRow) throw new Error('Expected the hydrated Session Home row');
        storage.setState({ sessionListRowsByServerId: {
            ...get().sessionListRowsByServerId,
            server_foreign: { s1: { ...ownedRow, meaningfulActivityAt: nowMs + 10_000 } },
        } });
        domain.markSessionOptimisticThinking('s1');
        domain.markSessionResuming('s1');

        expect(get().sessions.s1?.resumingAt).toBe(nowMs);
        expect((get().sessionListRowsByServerId['server_1'] ?? {}).s1?.resumingAt).toBe(nowMs);
        expect(get().sessionListRowsByServerId.server_1?.s1?.resumingAt).toBe(nowMs);
        expect([...scheduledTimeouts.values()].filter((timeout) => timeout.delay === 30_000)).toHaveLength(0);

        domain.armSessionResumingFallback('s1');
        const decay = [...scheduledTimeouts.values()].find((timeout) => timeout.delay === 30_000);
        expect(decay).toBeDefined();

        nowMs += 500;
        domain.applySessions([baseSession({
            active: true,
            activeAt: nowMs,
            presence: 'online',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 60_500,
        })]);
        expect(get().sessions.s1?.resumingAt).toBe(nowMs - 500);
        expect(get().sessionListRowsByServerId.server_1?.s1?.resumingAt).toBe(nowMs - 500);
        expect(get().sessions.s1?.optimisticThinkingAt).toBe(nowMs - 500);

        nowMs += 500;
        domain.applyMessages('s1', [{
            id: 'post-attach-message', seq: 2, localId: null, createdAt: nowMs,
            isSidechain: false, role: 'agent',
            content: [{ type: 'text', text: 'New activity', uuid: 'post-attach-message', parentUUID: null }],
        }]);
        expect(get().sessionListRowsByServerId.server_1?.s1?.meaningfulActivityAt).toBe(nowMs);
        expect(get().sessions.s1?.resumingAt).toBe(nowMs - 1_000);
        domain.applySessions([baseSession({
            active: true, activeAt: nowMs, presence: 'online',
            latestTurnStatus: 'completed', latestTurnStatusObservedAt: nowMs - 61_000,
        })]);
        expect(get().sessions.s1?.resumingAt ?? null).toBeNull();
        expect(get().sessionListRowsByServerId.server_1?.s1?.resumingAt ?? null).toBeNull();

        domain.markSessionOptimisticThinking('s1');
        domain.markSessionResuming('s1');

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
        expect((get().sessionListRowsByServerId['server_1'] ?? {}).s1?.resumingAt ?? null).toBeNull();
        expect(get().sessionListRowsByServerId.server_1?.s1?.resumingAt ?? null).toBeNull();

        nowMs += 500;
        domain.applySessions([baseSession({
            active: false,
            activeAt: nowMs,
            presence: nowMs,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs,
        })]);
        domain.markSessionResuming('s1');
        expect(get().sessions.s1?.resumingAt).toBe(nowMs);

        nowMs += 500;
        domain.applySessions([baseSession({
            active: true,
            activeAt: nowMs,
            presence: 'online',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 500,
        })]);
        expect(get().sessions.s1?.resumingAt ?? null).toBeNull();

        domain.markSessionResuming('s1');
        expect(get().sessions.s1?.resumingAt).toBe(nowMs);
        expect([...scheduledTimeouts.values()].filter((timeout) => timeout.delay === 30_000)).toHaveLength(0);
        domain.armSessionResumingFallback('s1');
        const secondDecay = [...scheduledTimeouts.values()].find((timeout) => timeout.delay === 30_000);
        expect(secondDecay).toBeDefined();
        secondDecay?.callback();
        expect(get().sessions.s1?.resumingAt ?? null).toBeNull();

        for (const activity of ['status', 'ready', 'meaningful'] as const) {
            const previousSession = get().sessions.s1;
            domain.markSessionOptimisticThinking('s1');
            domain.markSessionResuming('s1');
            nowMs += 500;
            domain.applySessions([{
                ...previousSession,
                active: true, activeAt: nowMs, presence: 'online',
                ...(activity === 'status' ? { latestTurnStatusObservedAt: nowMs } : {}),
                ...(activity === 'ready' ? { latestReadyEventSeq: 1, latestReadyEventAt: nowMs } : {}),
                ...(activity === 'meaningful' ? { meaningfulActivityAt: nowMs } : {}),
            }]);
            expect(get().sessions.s1?.resumingAt ?? null, activity).toBeNull();
            expect(get().sessionListRowsByServerId.server_1?.s1?.resumingAt ?? null, activity).toBeNull();
        }
    });

    it('ends thinking in one publication with no deferred indicator timer when a turn stops without a terminal projection', async () => {
        // Stop's local recovery and a runtime thinking=false both land here. Nothing presents a
        // post-thinking "grace", so the turn end must not schedule a later store write for it.
        const scheduledTimeouts = new Map<number, { callback: () => void; delay: number }>();
        let nextTimeoutId = 1;
        let nowMs = Date.parse('2026-02-05T00:00:00.000Z');

        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
            const timeoutId = nextTimeoutId++;
            if (typeof callback === 'function') {
                scheduledTimeouts.set(timeoutId, {
                    callback: callback as () => void,
                    delay: typeof delay === 'number' ? delay : 0,
                });
            }
            return timeoutId as unknown as ReturnType<typeof setTimeout>;
        });
        vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timeoutId: Parameters<typeof clearTimeout>[0]) => {
            scheduledTimeouts.delete(timeoutId as unknown as number);
        });

        const { createReducer } = await import("@happier-dev/session-core/reducer");
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, createReducer);
        const session = (thinking: boolean): Session => ({
            id: 's1', seq: 0, createdAt: 1, updatedAt: nowMs, active: true, activeAt: nowMs,
            metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 1,
            thinking, thinkingAt: nowMs, presence: 'online',
        });

        domain.applySessions([session(true)]);
        nowMs += 250;
        const timersBeforeStop = new Set(scheduledTimeouts.keys());
        let publications = 0;
        const unsubscribe = storage.subscribe(() => { publications += 1; });
        domain.applySessions([session(false)]);
        const stopPublications = publications;
        for (const [id, timeout] of [...scheduledTimeouts]) {
            if (timersBeforeStop.has(id)) continue;
            nowMs += timeout.delay;
            timeout.callback();
        }
        unsubscribe();

        expect(get().sessions.s1?.thinking).toBe(false);
        expect({ stopPublications, deferredPublications: publications - stopPublications })
            .toEqual({ stopPublications: 1, deferredPublications: 0 });
    });

    it('clears optimistic thinking and grace when a terminal primary turn projection arrives', async () => {
        const scheduledTimeouts = new Map<number, { callback: () => void; delay: number }>();
        let nextTimeoutId = 1;
        let nowMs = Date.parse('2026-02-05T00:00:00.000Z');

        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
            const timeoutId = nextTimeoutId++;
            if (typeof callback === 'function') {
                scheduledTimeouts.set(timeoutId, {
                    callback: callback as () => void,
                    delay: typeof delay === 'number' ? delay : 0,
                });
            }
            return timeoutId as unknown as ReturnType<typeof setTimeout>;
        });
        vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timeoutId: Parameters<typeof clearTimeout>[0]) => {
            scheduledTimeouts.delete(timeoutId as unknown as number);
        });

        const { createReducer } = await import("@happier-dev/session-core/reducer");
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
        expect([...scheduledTimeouts.values()].filter((timeout) => (
            timeout.delay === 3_000 || timeout.delay === 15_000
        ))).toHaveLength(0);
    });

    it('does not keep legacy thinking or start grace after a terminal turn projection', async () => {
        let nowMs = Date.parse('2026-02-05T00:00:00.000Z');
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        vi.spyOn(globalThis, 'setTimeout');

        const { createReducer } = await import("@happier-dev/session-core/reducer");
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, createReducer);

        domain.applySessions([
            {
                id: 's1',
                serverId: 'server_1',
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
                serverId: 'server_1',
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
        expect((get().sessionListRowsByServerId['server_1'] ?? {}).s1?.thinking).toBe(false);
        expect(vi.mocked(globalThis.setTimeout).mock.calls.some(([, delay]) => delay === 3_000)).toBe(false);
    });
});
