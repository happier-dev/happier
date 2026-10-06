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
    it('owns a bounded resuming marker until genuine post-attach activity settles it', async () => {
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

        domain.applySessions([baseSession({
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 60_000,
        })]);
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
            latestTurnStatusObservedAt: nowMs - 60_000,
        })]);
        domain.markSessionResuming('s1');
        expect(get().sessions.s1?.resumingAt).toBe(nowMs);

        nowMs += 500;
        domain.applySessions([baseSession({
            active: true,
            activeAt: nowMs,
            presence: 'online',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 60_500,
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
    });

    it('starts thinkingGraceUntil only after thinking turns off (prevents UI flicker without streaming churn)', async () => {
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
        const graceTimeouts = [...scheduledTimeouts.values()].filter((timeout) => timeout.delay === 3_000);
        expect(graceTimeouts).toHaveLength(1);

        // Once the grace timer expires, the marker clears without polling.
        nowMs = (graceUntil as number) + 1;
        const expireThinkingGrace = graceTimeouts[0]?.callback;
        expect(typeof expireThinkingGrace).toBe('function');
        expireThinkingGrace?.();

        expect(get().sessions.s1?.thinkingGraceUntil ?? null).toBeNull();
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
        expect(get().sessions.s1?.thinkingGraceUntil ?? null).toBeNull();
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
        expect((get().sessionListRowsByServerId['server_1'] ?? {}).s1?.thinking).toBe(false);
        expect((get().sessionListRowsByServerId['server_1'] ?? {}).s1?.thinkingGraceUntil ?? null).toBeNull();
        expect(vi.mocked(globalThis.setTimeout).mock.calls.some(([, delay]) => delay === 3_000)).toBe(false);
    });
});
