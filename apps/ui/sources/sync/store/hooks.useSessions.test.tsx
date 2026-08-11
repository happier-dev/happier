import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import { useSessionListViewData, useSessionListViewDataByServerId, useSessionRecentPathEntries, useSessions, useSessionsReady } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { decodeSessionRecentPathEntry } from '@/utils/sessions/recentPathEntries';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    const equivalentIds = new Set(['profile-a', 'legacy-a', 'identity-a']);
    return {
        ...original,
        areServerProfileIdentifiersEquivalent: (leftRaw: string | null | undefined, rightRaw: string | null | undefined) => {
            const left = String(leftRaw ?? '').trim();
            const right = String(rightRaw ?? '').trim();
            if (!left || !right) return false;
            if (left === right) return true;
            return equivalentIds.has(left) && equivalentIds.has(right);
        },
        resolveServerProfileScopeIdForIdentifier: (idRaw: string | null | undefined) => {
            const id = String(idRaw ?? '').trim();
            return equivalentIds.has(id) ? 'identity-a' : id;
        },
    };
});

afterEach(() => {
    standardCleanup();
});

describe('useSessions', () => {
    it('returns loaded sessions from the canonical sessions map when legacy sessionsData is absent', async () => {
        const previousState = storage.getState();
        try {
            const session: Session = {
                id: 's-1',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                archivedAt: null,
                metadata: { path: '/repo', host: 'localhost', machineId: 'm-1' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            };

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { 's-1': session },
                sessionsData: null,
            }));

            const hook = await renderHook(() => useSessions(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toEqual([session]);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps recent path projection stable when streaming updates only touch volatile session fields', async () => {
        const previousState = storage.getState();
        try {
            const session: Session = {
                id: 's-1',
                seq: 1,
                createdAt: 10,
                updatedAt: 20,
                active: true,
                activeAt: 20,
                archivedAt: null,
                metadata: { path: '/repo', host: 'localhost', machineId: 'm-1' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: true,
                thinkingAt: 20,
                presence: 'online',
            };

            storage.setState((state) => ({ ...state, isDataReady: true }));
            act(() => {
                storage.getState().applySessions([session]);
            });

            const hook = await renderHook(() => useSessionRecentPathEntries(), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();
            // Guard against a vacuous stability assertion: the projection must actually hold the
            // row before "unchanged" means anything.
            expect(first).toHaveLength(1);
            expect(decodeSessionRecentPathEntry(first![0]!)).toEqual({
                sessionId: 's-1',
                machineId: 'm-1',
                path: '/repo',
                createdAt: 10,
            });

            act(() => {
                storage.getState().applySessions([{
                    ...session,
                    seq: 2,
                    updatedAt: 30,
                    thinkingAt: 30,
                    metadata: {
                        ...session.metadata,
                        path: session.metadata?.path ?? '',
                        host: session.metadata?.host ?? '',
                        summaryText: 'streaming token chunk',
                    },
                }]);
            });
            await hook.rerender();

            expect(hook.getCurrent()).toBe(first);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('costs no project resolution per store write while a recent-path consumer is mounted', async () => {
        const previousState = storage.getState();
        try {
            const session: Session = {
                id: 's-1',
                seq: 1,
                createdAt: 10,
                updatedAt: 20,
                active: true,
                activeAt: 20,
                archivedAt: null,
                metadata: { path: '/repo', host: 'localhost', machineId: 'm-1' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            };

            storage.setState((state) => ({ ...state, isDataReady: true }));
            act(() => {
                storage.getState().applySessions([session]);
            });

            const hook = await renderHook(() => useSessionRecentPathEntries(), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            expect(hook.getCurrent()).toHaveLength(1);

            // The projection is derived inside the selector, which zustand runs as its
            // snapshot-equality check on every publish. Two costs made that untenable before and
            // both are counted here, because either one returning re-creates the regression:
            //   - `addSession` is the map-writing half of the store's `getProjectForSession`
            //     (three `Map.set`s per path-bearing session), so the selector must resolve the
            //     project key purely instead;
            //   - `new Map(...)` is what the machine-identity lookup used to build per session to
            //     index a record the store already keys by id — and what `useShallow` builds, twice
            //     over the whole entry list, on every publish it guards.
            const projectWrites = vi.spyOn(projectManager, 'addSession');
            const NativeMap = globalThis.Map;
            let mapConstructions = 0;
            class CountingMap<K, V> extends NativeMap<K, V> {
                constructor(entries?: Iterable<readonly [K, V]> | null) {
                    super(entries as never);
                    mapConstructions += 1;
                }
            }
            const globalWithMap = globalThis as unknown as { Map: MapConstructor };
            globalWithMap.Map = CountingMap as unknown as MapConstructor;
            // A publish that leaves the `sessions` record identity alone must not walk it at all,
            // not merely walk it cheaply. Reading this session's path is the first thing the
            // projection does, so a re-derivation cannot hide from the trap.
            const storedSession = storage.getState().sessions['s-1'] as { metadata?: unknown };
            const storedMetadata = storedSession.metadata as Record<string, unknown>;
            const untouchedPath = storedMetadata.path;
            Object.defineProperty(storedMetadata, 'path', {
                configurable: true,
                get: () => {
                    throw new Error('an unrelated store publish must not re-derive recent paths');
                },
            });
            try {
                const writes = 25;
                for (let index = 0; index < writes; index += 1) {
                    act(() => {
                        storage.setState((state) => ({ ...state, lastSyncAt: 1_000 + index }));
                    });
                }

                Object.defineProperty(storedMetadata, 'path', {
                    configurable: true,
                    enumerable: true,
                    writable: true,
                    value: untouchedPath,
                });

                // This publish replaces the record, so the full O(sessions) rebuild actually runs
                // — that is the pass which must also cost nothing, since it is the one that used
                // to register every session it read.
                act(() => {
                    storage.setState((state) => ({ ...state, sessions: { ...state.sessions } }));
                });
            } finally {
                globalWithMap.Map = NativeMap;
            }

            expect(projectWrites).toHaveBeenCalledTimes(0);
            expect(mapConstructions).toBe(0);
            // The rebuild produced the same rows, so consumers must not be re-rendered.
            expect(hook.getCurrent()).toHaveLength(1);
            projectWrites.mockRestore();

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps session list shell data stable when streaming updates only touch row-subscribed fields', async () => {
        const previousState = storage.getState();
        try {
            const firstData: SessionListViewItem[] = [
                {
                    type: 'header',
                    title: 'Active',
                    headerKind: 'active',
                    groupKey: 'server:server-a:active',
                    serverId: 'server-a',
                },
                {
                    type: 'session',
                    section: 'active',
                    groupKey: 'server:server-a:active',
                    groupKind: 'active',
                    serverId: 'server-a',
                    session: {
                        id: 's-1',
                        seq: 1,
                        createdAt: 10,
                        updatedAt: 20,
                        active: true,
                        activeAt: 20,
                        archivedAt: null,
                        metadataVersion: 1,
                        agentStateVersion: 1,
                        metadata: { path: '/repo', host: 'localhost', machineId: 'm-1' },
                        thinking: true,
                        thinkingAt: 20,
                        presence: 'online',
                    },
                },
            ];
            const firstSessionItem = firstData[1];
            if (firstSessionItem.type !== 'session') {
                throw new Error('expected session test fixture');
            }
            const firstMetadata = firstSessionItem.session.metadata;
            if (!firstMetadata) {
                throw new Error('expected metadata test fixture');
            }

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListViewData: firstData,
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionListViewData();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListViewData: [
                        firstData[0],
                        {
                            ...firstSessionItem,
                            session: {
                                ...firstSessionItem.session,
                                seq: 42,
                                updatedAt: 60,
                                metadataVersion: 4,
                                agentStateVersion: 5,
                                thinkingAt: 60,
                            },
                        },
                    ],
                }));
            });

            expect(hook.getCurrent()).toBe(first);
            expect(renderCount).toBe(1);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not rescan unchanged session list shell data on unrelated store publishes', async () => {
        const previousState = storage.getState();
        try {
            const firstData: SessionListViewItem[] = [
                {
                    type: 'header',
                    title: 'Active',
                    headerKind: 'active',
                    groupKey: 'server:server-a:active',
                    serverId: 'server-a',
                },
            ];

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListViewData: firstData,
            }));

            const hook = await renderHook(() => useSessionListViewData(), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();

            Object.defineProperty(firstData[0], 'title', {
                configurable: true,
                get: () => {
                    throw new Error('unchanged session list data must not be signed again');
                },
            });

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: { ...state.sessions },
                }));
            });

            expect(hook.getCurrent()).toBe(first);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('uses the latest equivalent session list reference for future fast paths', async () => {
        const previousState = storage.getState();
        try {
            const firstData: SessionListViewItem[] = [
                {
                    type: 'header',
                    title: 'Active',
                    headerKind: 'active',
                    groupKey: 'server:server-a:active',
                    serverId: 'server-a',
                },
            ];
            const equivalentData: SessionListViewItem[] = [
                {
                    type: 'header',
                    title: 'Active',
                    headerKind: 'active',
                    groupKey: 'server:server-a:active',
                    serverId: 'server-a',
                },
            ];

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListViewData: firstData,
            }));

            const hook = await renderHook(() => useSessionListViewData(), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListViewData: equivalentData,
                }));
            });

            expect(hook.getCurrent()).toBe(first);

            Object.defineProperty(equivalentData[0], 'title', {
                configurable: true,
                get: () => {
                    throw new Error('latest equivalent session list data must not be signed again');
                },
            });

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: { ...state.sessions },
                }));
            });

            expect(hook.getCurrent()).toBe(first);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('updates session list shell data when visible title or pending badge fields change', async () => {
        const previousState = storage.getState();
        try {
            const firstData: SessionListViewItem[] = [
                {
                    type: 'header',
                    title: 'Active',
                    headerKind: 'active',
                    groupKey: 'server:server-a:active',
                    serverId: 'server-a',
                },
                {
                    type: 'session',
                    section: 'active',
                    groupKey: 'server:server-a:active',
                    groupKind: 'active',
                    serverId: 'server-a',
                    session: {
                        id: 's-1',
                        seq: 1,
                        createdAt: 10,
                        updatedAt: 20,
                        active: true,
                        activeAt: 20,
                        archivedAt: null,
                        pendingCount: 0,
                        metadataVersion: 1,
                        agentStateVersion: 1,
                        metadata: {
                            path: '/repo',
                            host: 'localhost',
                            machineId: 'm-1',
                            summaryText: 'Initial summary',
                        },
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'online',
                    },
                },
            ];
            const firstSessionItem = firstData[1];
            if (firstSessionItem.type !== 'session') {
                throw new Error('expected session test fixture');
            }
            const firstMetadata = firstSessionItem.session.metadata;
            if (!firstMetadata) {
                throw new Error('expected metadata test fixture');
            }

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListViewData: firstData,
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionListViewData();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListViewData: [
                        firstData[0],
                        {
                            ...firstSessionItem,
                            session: {
                                ...firstSessionItem.session,
                                pendingCount: 3,
                                metadata: {
                                    ...firstMetadata,
                                    summaryText: 'Updated summary',
                                },
                            },
                        },
                    ],
                }));
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            const next = hook.getCurrent();
            expect(next).not.toBe(first);
            expect(renderCount).toBe(2);
            expect(next?.[1]).toMatchObject({
                type: 'session',
                session: {
                    pendingCount: 3,
                    metadata: {
                        summaryText: 'Updated summary',
                    },
                },
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('updates session list shell data when pending request freshness timing changes', async () => {
        const previousState = storage.getState();
        try {
            const firstData: SessionListViewItem[] = [
                {
                    type: 'session',
                    section: 'active',
                    groupKey: 'server:server-a:active',
                    groupKind: 'active',
                    serverId: 'server-a',
                    session: {
                        id: 's-1',
                        seq: 1,
                        createdAt: 10,
                        updatedAt: 20,
                        active: true,
                        activeAt: 20,
                        archivedAt: null,
                        metadataVersion: 1,
                        agentStateVersion: 1,
                        metadata: { path: '/repo', host: 'localhost', machineId: 'm-1' },
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'online',
                        hasPendingPermissionRequests: true,
                        pendingRequestObservedAt: 100,
                    },
                },
            ];
            const firstSessionItem = firstData[0];
            if (firstSessionItem.type !== 'session') {
                throw new Error('expected session test fixture');
            }

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListViewData: firstData,
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionListViewData();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListViewData: [{
                        ...firstSessionItem,
                        session: {
                            ...firstSessionItem.session,
                            pendingRequestObservedAt: 500,
                        },
                    }],
                }));
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            const next = hook.getCurrent();
            expect(next).not.toBe(first);
            expect(renderCount).toBe(2);
            expect(next?.[0]).toMatchObject({
                type: 'session',
                session: {
                    pendingRequestObservedAt: 500,
                },
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps selected server list shell data stable when unrelated server caches change', async () => {
        const previousState = storage.getState();
        try {
            const selectedData: SessionListViewItem[] = [
                {
                    type: 'session',
                    section: 'inactive',
                    groupKey: 'server:server-a:day:2026-05-04',
                    groupKind: 'date',
                    serverId: 'server-a',
                    session: {
                        id: 's-a',
                        seq: 1,
                        createdAt: 10,
                        updatedAt: 20,
                        active: false,
                        activeAt: 0,
                        archivedAt: null,
                        metadataVersion: 1,
                        agentStateVersion: 1,
                        metadata: { path: '/repo-a', host: 'localhost', machineId: 'm-1' },
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'online',
                    },
                },
            ];
            const unrelatedData: SessionListViewItem[] = [
                {
                    type: 'session',
                    section: 'inactive',
                    groupKey: 'server:server-b:day:2026-05-04',
                    groupKind: 'date',
                    serverId: 'server-b',
                    session: {
                        id: 's-b',
                        seq: 1,
                        createdAt: 10,
                        updatedAt: 20,
                        active: false,
                        activeAt: 0,
                        archivedAt: null,
                        metadataVersion: 1,
                        agentStateVersion: 1,
                        metadata: { path: '/repo-b', host: 'localhost', machineId: 'm-2' },
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'online',
                    },
                },
            ];

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListViewDataByServerId: {
                    'server-a': selectedData,
                    'server-b': unrelatedData,
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionListViewDataByServerId(['server-a']);
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListViewDataByServerId: {
                        ...state.sessionListViewDataByServerId,
                        'server-b': unrelatedData.map((item) => item.type === 'session'
                            ? {
                                ...item,
                                session: {
                                    ...item.session,
                                    seq: 2,
                                    updatedAt: 30,
                                    thinkingAt: 30,
                                },
                            }
                            : item),
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(first);
            expect(Object.keys(hook.getCurrent())).toEqual(['server-a']);
            expect(renderCount).toBe(1);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not rescan selected server session list data when only unselected server caches change', async () => {
        const previousState = storage.getState();
        try {
            const selectedData: SessionListViewItem[] = [
                {
                    type: 'header',
                    title: 'Server A',
                    headerKind: 'active',
                    groupKey: 'server:server-a:active',
                    serverId: 'server-a',
                },
            ];
            const unrelatedData: SessionListViewItem[] = [
                {
                    type: 'header',
                    title: 'Server B',
                    headerKind: 'active',
                    groupKey: 'server:server-b:active',
                    serverId: 'server-b',
                },
            ];

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListViewDataByServerId: {
                    'server-a': selectedData,
                    'server-b': unrelatedData,
                },
            }));

            const hook = await renderHook(() => useSessionListViewDataByServerId(['server-a']), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();

            Object.defineProperty(selectedData[0], 'title', {
                configurable: true,
                get: () => {
                    throw new Error('unchanged selected server data must not be signed again');
                },
            });

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListViewDataByServerId: {
                        ...state.sessionListViewDataByServerId,
                        'server-b': [{
                            ...unrelatedData[0],
                            subtitle: 'Updated unrelated server',
                        }],
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(first);
            expect(Object.keys(hook.getCurrent())).toEqual(['server-a']);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not rescan unchanged server session list data when rebuilding the all-server cache', async () => {
        const previousState = storage.getState();
        try {
            const stableServerData: SessionListViewItem[] = [
                {
                    type: 'header',
                    title: 'Server A',
                    headerKind: 'active',
                    groupKey: 'server:server-a:active',
                    serverId: 'server-a',
                },
            ];
            const changingServerData: SessionListViewItem[] = [
                {
                    type: 'header',
                    title: 'Server B',
                    headerKind: 'active',
                    groupKey: 'server:server-b:active',
                    serverId: 'server-b',
                },
            ];

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListViewDataByServerId: {
                    'server-a': stableServerData,
                    'server-b': changingServerData,
                },
            }));

            const hook = await renderHook(() => useSessionListViewDataByServerId(), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();

            Object.defineProperty(stableServerData[0], 'title', {
                configurable: true,
                get: () => {
                    throw new Error('unchanged all-server data must not be signed again');
                },
            });

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListViewDataByServerId: {
                        ...state.sessionListViewDataByServerId,
                        'server-b': [{
                            ...changingServerData[0],
                            subtitle: 'Updated server B',
                        }],
                    },
                }));
            });

            const next = hook.getCurrent();
            expect(next).not.toBe(first);
            expect(next['server-a']).toBe(first['server-a']);
            expect(next['server-b']).not.toBe(first['server-b']);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('uses the latest equivalent all-server session list reference for future fast paths', async () => {
        const previousState = storage.getState();
        try {
            const firstData: SessionListViewItem[] = [
                {
                    type: 'header',
                    title: 'Server A',
                    headerKind: 'active',
                    groupKey: 'server:server-a:active',
                    serverId: 'server-a',
                },
            ];
            const equivalentData: SessionListViewItem[] = [
                {
                    type: 'header',
                    title: 'Server A',
                    headerKind: 'active',
                    groupKey: 'server:server-a:active',
                    serverId: 'server-a',
                },
            ];

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListViewDataByServerId: {
                    'server-a': firstData,
                },
            }));

            const hook = await renderHook(() => useSessionListViewDataByServerId(), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListViewDataByServerId: {
                        'server-a': equivalentData,
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(first);

            Object.defineProperty(equivalentData[0], 'title', {
                configurable: true,
                get: () => {
                    throw new Error('latest equivalent all-server data must not be signed again');
                },
            });

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: { ...state.sessions },
                }));
            });

            expect(hook.getCurrent()).toBe(first);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('selects session list cache by equivalent server profile identifiers', async () => {
        const previousState = storage.getState();
        try {
            const selectedData: SessionListViewItem[] = [
                {
                    type: 'session',
                    section: 'inactive',
                    groupKey: 'server:identity-a:day:2026-05-04',
                    groupKind: 'date',
                    serverId: 'identity-a',
                    session: {
                        id: 's-a',
                        seq: 1,
                        createdAt: 10,
                        updatedAt: 20,
                        active: false,
                        activeAt: 0,
                        archivedAt: null,
                        metadataVersion: 1,
                        agentStateVersion: 1,
                        metadata: { path: '/repo-a', host: 'localhost', machineId: 'm-1' },
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'online',
                    },
                },
            ];

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListViewDataByServerId: {
                    'identity-a': selectedData,
                },
            }));

            const hook = await renderHook(() => useSessionListViewDataByServerId(['profile-a']), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(Object.keys(hook.getCurrent())).toEqual(['identity-a']);
            expect(hook.getCurrent()['identity-a']).toBe(selectedData);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps sessions readiness stable when unrelated session records change', async () => {
        const previousState = storage.getState();
        try {
            const session: Session = {
                id: 's-1',
                seq: 1,
                createdAt: 10,
                updatedAt: 20,
                active: true,
                activeAt: 20,
                archivedAt: null,
                metadata: { path: '/repo', host: 'localhost', machineId: 'm-1' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: true,
                thinkingAt: 20,
                presence: 'online',
            };

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { 's-1': session },
                sessionsData: null,
            }));

            const seen: boolean[] = [];
            const hook = await renderHook(() => {
                const ready = useSessionsReady();
                seen.push(ready);
                return ready;
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBe(true);

            storage.setState((state) => ({
                ...state,
                sessions: {
                    's-1': {
                        ...session,
                        seq: 2,
                        updatedAt: 30,
                    },
                },
            }));
            await hook.rerender();

            expect(hook.getCurrent()).toBe(true);
            expect(seen).toEqual([true, true]);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
