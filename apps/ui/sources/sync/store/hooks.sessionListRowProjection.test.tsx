import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildSessionListRuntimePriorityRowKeys } from '@/sync/domains/session/listing/sessionListRuntimePriorityRows';
import { storage } from '@/sync/domains/state/storageStore';
import {
    useSessionListRenderableWithServerScope,
    useSessionListRuntimePriorityRowKeysForItems,
} from './hooks';

function buildActiveRenderable(overrides: Partial<SessionListRenderableSession> = {}): SessionListRenderableSession {
    return {
        id: 'session-list-row-projection',
        seq: 10,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 5_000,
        meaningfulActivityAt: Date.now() - 5_000,
        active: true,
        activeAt: Date.now() - 5_000,
        archivedAt: null,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: { path: '/tmp/session-list-row-projection', host: 'localhost' },
        thinking: true,
        thinkingAt: Date.now() - 5_000,
        presence: 'online',
        latestTurnStatus: 'in_progress',
        latestTurnStatusObservedAt: Date.now() - 5_000,
        hasUnreadMessages: true,
        ...overrides,
    };
}

afterEach(() => {
    standardCleanup();
    vi.useRealTimers();
});

describe('useSessionListRenderableWithServerScope row projection', () => {
    it('keeps the projected renderable stable when fresh progress also advances active heartbeat', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
        const previousState = storage.getState();
        const sessionId = 'session-list-row-projection-fresh-heartbeat';
        const firstRenderable = buildActiveRenderable({ id: sessionId });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListRenderables: {
                    ...state.sessionListRenderables,
                    [sessionId]: firstRenderable,
                },
            }));

            const hook = await renderHook(
                () => useSessionListRenderableWithServerScope(null, sessionId),
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            const firstProjection = hook.getCurrent();
            expect(firstProjection?.id).toBe(sessionId);

            const freshProgressRenderable = {
                ...firstRenderable,
                seq: firstRenderable.seq + 1,
                updatedAt: firstRenderable.updatedAt + 5_000,
                meaningfulActivityAt: (firstRenderable.meaningfulActivityAt ?? firstRenderable.updatedAt) + 5_000,
                activeAt: firstRenderable.activeAt + 5_000,
            } satisfies SessionListRenderableSession;
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRenderables: {
                        ...state.sessionListRenderables,
                        [sessionId]: freshProgressRenderable,
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(firstProjection);

            await hook.unmount();
        } finally {
            standardCleanup();
            storage.setState(previousState);
        }
    });

    it('refreshes the projected renderable when the previous active heartbeat is near stale', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
        const previousState = storage.getState();
        const sessionId = 'session-list-row-projection-stale-heartbeat';
        const firstRenderable = buildActiveRenderable({
            id: sessionId,
            activeAt: Date.now() - 119_000,
            latestTurnStatusObservedAt: Date.now() - 119_000,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListRenderables: {
                    ...state.sessionListRenderables,
                    [sessionId]: firstRenderable,
                },
            }));

            const hook = await renderHook(
                () => useSessionListRenderableWithServerScope(null, sessionId),
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            const firstProjection = hook.getCurrent();
            expect(firstProjection?.id).toBe(sessionId);

            const heartbeatRefreshRenderable = {
                ...firstRenderable,
                seq: firstRenderable.seq + 1,
                updatedAt: firstRenderable.updatedAt + 5_000,
                meaningfulActivityAt: (firstRenderable.meaningfulActivityAt ?? firstRenderable.updatedAt) + 5_000,
                activeAt: Date.now(),
            } satisfies SessionListRenderableSession;
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRenderables: {
                        ...state.sessionListRenderables,
                        [sessionId]: heartbeatRefreshRenderable,
                    },
                }));
            });

            expect(hook.getCurrent()).not.toBe(firstProjection);
            expect(hook.getCurrent()?.seq).toBe(heartbeatRefreshRenderable.seq);

            await hook.unmount();
        } finally {
            standardCleanup();
            storage.setState(previousState);
        }
    });

    it('refreshes the projected renderable for runtime activity revision changes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
        const now = Date.now();
        const previousState = storage.getState();
        const sessionId = 'session-list-row-projection-runtime-revision';
        const firstRenderable = buildActiveRenderable({
            id: sessionId,
            active: false,
            activeAt: now - 60_000,
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now - 10_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: now - 1_000,
            runtimeActivityRevision: 1,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListRenderables: {
                    ...state.sessionListRenderables,
                    [sessionId]: firstRenderable,
                },
            }));

            const hook = await renderHook(
                () => useSessionListRenderableWithServerScope(null, sessionId),
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            const firstProjection = hook.getCurrent();
            expect(firstProjection?.id).toBe(sessionId);

            const revisionOnlyRenderable = {
                ...firstRenderable,
                runtimeActivityObservedAt: now + 30_000,
                runtimeActivityRevision: 2,
            } satisfies SessionListRenderableSession;
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRenderables: {
                        ...state.sessionListRenderables,
                        [sessionId]: revisionOnlyRenderable,
                    },
                }));
            });

            expect(hook.getCurrent()).not.toBe(firstProjection);
            expect(hook.getCurrent()).toMatchObject({
                runtimeActivityObservedAt: now + 30_000,
                runtimeActivityRevision: 2,
            });

            await hook.unmount();
        } finally {
            standardCleanup();
            storage.setState(previousState);
        }
    });
});

describe('buildSessionListRuntimePriorityRowKeys', () => {
    it('does not use provider runtime activity as row-priority proof', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
        const now = Date.now();
        const items = [
            { type: 'session', serverId: 'server-a', sessionId: 'fresh-runtime' },
            { type: 'session', serverId: 'server-a', sessionId: 'stale-runtime' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;
        const baseRenderable = buildActiveRenderable({
            active: false,
            activeAt: now - 60_000,
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now - 10_000,
        });

        const keys = buildSessionListRuntimePriorityRowKeys(items, {
            'server-a': {
                'fresh-runtime': {
                    ...baseRenderable,
                    id: 'fresh-runtime',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: now - 1_000,
                    runtimeActivityRevision: now + 60_000,
                },
                'stale-runtime': {
                    ...baseRenderable,
                    id: 'stale-runtime',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: now - 300_000,
                    runtimeActivityRevision: now - 1,
                },
            },
        });

        expect(keys).toEqual(new Set());
    });

    it('expires stale raw thinking while retaining the canonical in-progress turn projection as priority proof', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
        const now = Date.now();
        const items = [
            { type: 'session', serverId: 'server-a', sessionId: 'stale-thinking' },
            { type: 'session', serverId: 'server-a', sessionId: 'stale-in-progress' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;
        const baseRenderable = buildActiveRenderable({
            active: false,
            activeAt: now - 300_000,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now - 10_000,
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            runtimeActivityRevision: null,
        });

        const keys = buildSessionListRuntimePriorityRowKeys(items, {
            'server-a': {
                'stale-thinking': {
                    ...baseRenderable,
                    id: 'stale-thinking',
                    thinking: true,
                    thinkingAt: now - 300_000,
                },
                'stale-in-progress': {
                    ...baseRenderable,
                    id: 'stale-in-progress',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 300_000,
                },
            },
        });

        expect(keys).toEqual(new Set(['server-a\u0000stale-in-progress']));
    });

    it('ignores unread-only row overlay updates when selecting runtime-priority rows', () => {
        const items = [
            { type: 'session', serverId: 'server-a', sessionId: 'active' },
            { type: 'session', serverId: 'server-a', sessionId: 'unread-only' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;
        const activeRenderable = buildActiveRenderable({
            id: 'active',
            active: true,
            thinking: false,
            latestTurnStatus: null,
        });
        const unreadRenderable = buildActiveRenderable({
            id: 'unread-only',
            active: false,
            thinking: false,
            latestTurnStatus: null,
            latestReadyEventSeq: 1,
            latestReadyEventAt: 1_000,
            hasUnreadMessages: true,
        });

        const firstKeys = buildSessionListRuntimePriorityRowKeys(items, {
            'server-a': {
                active: activeRenderable,
                'unread-only': unreadRenderable,
            },
        });
        expect(firstKeys).toEqual(new Set(['server-a\u0000active']));

        const unreadOnlyUpdatedKeys = buildSessionListRuntimePriorityRowKeys(items, {
            'server-a': {
                active: activeRenderable,
                'unread-only': {
                    ...unreadRenderable,
                    latestReadyEventSeq: 2,
                    latestReadyEventAt: 2_000,
                    hasUnreadMessages: true,
                },
            },
        });
        expect(unreadOnlyUpdatedKeys).toEqual(firstKeys);

        const activeUnreadKeys = buildSessionListRuntimePriorityRowKeys(items, {
            'server-a': {
                active: activeRenderable,
                'unread-only': {
                    ...unreadRenderable,
                    active: true,
                    latestReadyEventSeq: 3,
                    latestReadyEventAt: 3_000,
                },
            },
        });
        expect(activeUnreadKeys).toEqual(new Set([
            'server-a\u0000active',
            'server-a\u0000unread-only',
        ]));
    });
});

describe('useSessionListRuntimePriorityRowKeysForItems', () => {
    it('promotes canonical online runtime activity and removes the priority when it becomes idle', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const previousState = storage.getState();
        const items = [
            { type: 'session', serverId: 'server-a', sessionId: 'runtime-active' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;

        try {
            storage.setState((state) => ({
                ...state,
                sessionListRowStateByServerId: {
                    ...state.sessionListRowStateByServerId,
                    'server-a': {
                        ...(state.sessionListRowStateByServerId['server-a'] ?? {}),
                        'runtime-active': buildActiveRenderable({
                            id: 'runtime-active',
                            active: false,
                            thinking: false,
                            presence: 'online',
                            latestTurnStatus: 'completed',
                            latestTurnStatusObservedAt: 990_000,
                            runtimeActivityState: 'active',
                            runtimeActivityActiveCount: 1,
                            runtimeActivityObservedAt: 999_000,
                            runtimeActivityRevision: 1,
                        }),
                    },
                },
            }));

            const hook = await renderHook(() => useSessionListRuntimePriorityRowKeysForItems(items));

            expect(hook.getCurrent()).toEqual(new Set(['server-a\u0000runtime-active']));

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowStateByServerId: {
                        ...state.sessionListRowStateByServerId,
                        'server-a': {
                            ...(state.sessionListRowStateByServerId['server-a'] ?? {}),
                            'runtime-active': buildActiveRenderable({
                                id: 'runtime-active',
                                active: false,
                                thinking: false,
                                presence: 'online',
                                latestTurnStatus: 'completed',
                                latestTurnStatusObservedAt: 990_000,
                                runtimeActivityState: 'idle',
                                runtimeActivityActiveCount: 0,
                                runtimeActivityObservedAt: 1_000_000,
                                runtimeActivityRevision: 2,
                            }),
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).toEqual(new Set());
            await hook.unmount();
        } finally {
            standardCleanup();
            storage.setState(previousState);
        }
    });
});
