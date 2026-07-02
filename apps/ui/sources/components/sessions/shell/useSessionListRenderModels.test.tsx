import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { storage } from '@/sync/domains/state/storageStore';

import type { VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

import { useSessionListRenderModels } from './useSessionListRenderModels';

function makeRenderable(id: string, metadata: SessionListRenderableSession['metadata']): SessionListRenderableSession {
    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: 0,
        archivedAt: null,
        metadata,
        metadataVersion: 0,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
    } satisfies SessionListRenderableSession;
}

describe('useSessionListRenderModels', () => {
    beforeEach(() => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not tick row clocks while the session-list surface is inactive', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const previousState = storage.getState();
        let hook: { unmount: () => Promise<void> } | null = null;
        try {
            const row = {
                ...makeRenderable('session-1', {
                    machineId: 'machine-1',
                    path: '/workspace/active',
                    host: 'workstation.local',
                }),
                active: true,
                activeAt: 1_000,
                thinking: true,
                thinkingAt: 1_000,
                presence: 'online',
                meaningfulActivityAt: 1_000,
            } satisfies SessionListRenderableSession;
            storage.setState((state) => ({
                ...state,
                sessionListRowStateByServerId: {
                    'server-1': {
                        'session-1': row,
                    },
                },
            }));
            const paneState = {
                summary: {
                    sessionsReady: true,
                    sessionCount: 1,
                },
                visibleSessionListIndex: [
                    {
                        type: 'session',
                        sessionId: 'session-1',
                        serverId: 'server-1',
                        groupKey: 'active',
                    },
                ] satisfies ReadonlyArray<SessionListIndexItem>,
                hasHiddenInactiveSessions: false,
                folderFocus: null,
                showLoading: false,
                showEmptyState: false,
            } as VisibleSessionListPaneState;

            let renderCount = 0;
            hook = await renderHook((input: { clocksActive: boolean }) => {
                renderCount += 1;
                return useSessionListRenderModels({
                    paneState,
                    collapsedGroupKeys: {},
                    machineDisplayById: {},
                    workspaceLabels: {},
                    workspaceRefs: [],
                    pinnedKeySet: new Set<string>(),
                    sessionTags: {},
                    selectedSessionId: null,
                    showServerBadge: false,
                    showPinnedServerBadge: false,
                    clocksActive: input.clocksActive,
                });
            }, {
                initialProps: { clocksActive: false },
            });
            await flushHookEffects({ cycles: 1, turns: 2 });
            const inactiveRenderCount = renderCount;

            vi.setSystemTime(121_000);
            await flushHookEffects({ advanceTimersMs: 120_000, cycles: 1, turns: 2 });

            expect(renderCount).toBe(inactiveRenderCount);
        } finally {
            await hook?.unmount();
            storage.setState(previousState);
        }
    });

    it('reuses the same empty render model bundle for empty visible list input', async () => {
        const paneState: VisibleSessionListPaneState = {
            summary: {
                sessionsReady: true,
                sessionCount: 0,
            },
            visibleSessionListIndex: [],
            hasHiddenInactiveSessions: false,
            folderFocus: null,
            showLoading: false,
            showEmptyState: true,
        };

        const hook = await renderHook((input: { paneState: VisibleSessionListPaneState }) =>
            useSessionListRenderModels({
                paneState: input.paneState,
                collapsedGroupKeys: {},
                machineDisplayById: {},
                workspaceLabels: {},
                workspaceRefs: [],
                pinnedKeySet: new Set<string>(),
                sessionTags: {},
                selectedSessionId: null,
                showServerBadge: false,
                showPinnedServerBadge: false,
            }), {
            initialProps: { paneState },
        });

        const first = hook.getCurrent();
        const second = await hook.rerender({ paneState });

        expect(first).toBe(second);
        expect(first).toMatchObject({
            listItems: [],
            hasMultipleMachines: false,
            projectHeaderViewModelState: {
                projectHeaderViewModelByGroupKey: expect.any(Map),
                scopeHintByLegacyWorkspaceKey: expect.any(Map),
            },
            reachableSessionDisplayById: expect.any(Map),
            rowViewModels: [],
        });
        expect(first.reachableSessionDisplayById.size).toBe(0);
        expect(first.projectHeaderViewModelState.projectHeaderViewModelByGroupKey.size).toBe(0);
        expect(first.projectHeaderViewModelState.scopeHintByLegacyWorkspaceKey.size).toBe(0);
    });

    it('reuses the same non-empty render model bundle when fresh empty shell inputs are normalized', async () => {
        const paneState = {
            summary: {
                sessionsReady: true,
                sessionCount: 1,
            },
            visibleSessionListIndex: [
                {
                    type: 'session',
                    sessionId: 'session-1',
                },
            ] satisfies ReadonlyArray<SessionListIndexItem>,
            hasHiddenInactiveSessions: false,
            folderFocus: null,
            showLoading: false,
            showEmptyState: false,
        } as VisibleSessionListPaneState;

        const hook = await renderHook((input: {
            paneState: VisibleSessionListPaneState;
            collapsedGroupKeys: Record<string, boolean>;
            workspaceLabels: Record<string, string>;
            workspaceRefs: Array<{
                id: string;
                serverId: string;
                machineId: string;
                rootPath: string;
                label: string | null;
                createdAtMs: number;
                lastOpenedAtMs: number | null;
            }>;
            sessionTags: Record<string, string[]>;
        }) =>
            useSessionListRenderModels({
                paneState: input.paneState,
                collapsedGroupKeys: input.collapsedGroupKeys,
                machineDisplayById: {},
                workspaceLabels: input.workspaceLabels,
                workspaceRefs: input.workspaceRefs,
                pinnedKeySet: new Set<string>(),
                sessionTags: input.sessionTags,
                selectedSessionId: null,
                showServerBadge: false,
                showPinnedServerBadge: false,
            }), {
            initialProps: {
                paneState,
                collapsedGroupKeys: {},
                workspaceLabels: {},
                workspaceRefs: [],
                sessionTags: {},
            },
        });

        const first = hook.getCurrent();
        const second = await hook.rerender({
            paneState,
            collapsedGroupKeys: {},
            workspaceLabels: {},
            workspaceRefs: [],
            sessionTags: {},
        });

        expect(first).toBe(second);
        expect(first.listItems).toHaveLength(1);
        expect(first.rowViewModels).toHaveLength(1);
    });

    it('records low-volume render derivation telemetry for non-empty list models', async () => {
        syncPerformanceTelemetry.configure({ enabled: true, slowThresholdMs: 0 });
        syncPerformanceTelemetry.reset();
        const paneState = {
            summary: {
                sessionsReady: true,
                sessionCount: 1,
            },
            visibleSessionListIndex: [
                {
                    type: 'header',
                    title: 'Active',
                    headerKind: 'active',
                    groupKey: 'active',
                    serverId: 'server-1',
                },
                {
                    type: 'session',
                    sessionId: 'session-1',
                    serverId: 'server-1',
                    groupKey: 'active',
                },
            ] satisfies ReadonlyArray<SessionListIndexItem>,
            hasHiddenInactiveSessions: false,
            folderFocus: null,
            showLoading: false,
            showEmptyState: false,
        } as VisibleSessionListPaneState;

        await renderHook(() =>
            useSessionListRenderModels({
                paneState,
                collapsedGroupKeys: {},
                machineDisplayById: {},
                workspaceLabels: {},
                workspaceRefs: [],
                pinnedKeySet: new Set<string>(),
                sessionTags: {},
                selectedSessionId: 'session-1',
                showServerBadge: false,
                showPinnedServerBadge: false,
            }));

        const events = syncPerformanceTelemetry.snapshot().events;
        expect(events.find((event) => event.name === 'ui.sessionsList.render.collapsedFiltering')?.fields)
            .toMatchObject({ items: 2, collapsedGroups: 0 });
        expect(events.find((event) => event.name === 'ui.sessionsList.render.reachabilityDisplayMap')?.fields)
            .toMatchObject({ items: 2, machines: 0, displayRows: 1 });
        expect(events.find((event) => event.name === 'ui.sessionsList.render.selectedMapping')?.fields)
            .toMatchObject({ items: 2, selectable: 1 });
        syncPerformanceTelemetry.configure({ enabled: false });
    });

    it('shows matching rows from collapsed groups while header filters are active', async () => {
        const collapsedGroupKey = 'server:server-1:day:2026-02-17';
        const paneState = {
            summary: {
                sessionsReady: true,
                sessionCount: 1,
            },
            visibleSessionListIndex: [
                {
                    type: 'header',
                    title: 'Active',
                    headerKind: 'active',
                    groupKey: 'active',
                    serverId: 'server-1',
                },
                {
                    type: 'header',
                    title: 'Today',
                    headerKind: 'date',
                    groupKey: collapsedGroupKey,
                    serverId: 'server-1',
                },
                {
                    type: 'session',
                    sessionId: 'session-1',
                    serverId: 'server-1',
                    groupKey: collapsedGroupKey,
                    groupKind: 'date',
                },
            ] satisfies ReadonlyArray<SessionListIndexItem>,
            hasHiddenInactiveSessions: false,
            folderFocus: null,
            showLoading: false,
            showEmptyState: false,
        } as VisibleSessionListPaneState;

        const hook = await renderHook(() =>
            useSessionListRenderModels({
                paneState,
                collapsedGroupKeys: { [collapsedGroupKey]: true },
                machineDisplayById: {},
                workspaceLabels: {},
                workspaceRefs: [],
                pinnedKeySet: new Set<string>(),
                sessionTags: {},
                headerFilters: {
                    searchQuery: 'rebound',
                    selectedTags: [],
                    searchableTextBySessionKey: {
                        'server-1:session-1': 'rebound workspace',
                    },
                },
                selectedSessionId: null,
                showServerBadge: false,
                showPinnedServerBadge: false,
            }));

        expect(hook.getCurrent().listItems.map((item) => item.type === 'session' ? item.sessionId : item.title)).toEqual([
            'Active',
            'Today',
            'session-1',
        ]);

        await hook.unmount();
    });

    it('does not rerun reachability derivation for background row timing updates', async () => {
        const previousState = storage.getState();
        try {
            syncPerformanceTelemetry.configure({ enabled: true, slowThresholdMs: 0 });
            syncPerformanceTelemetry.reset();
            const visibleRow = makeRenderable('session-1', {
                machineId: 'machine-1',
                path: '/workspace/visible',
                host: 'workstation.local',
            });
            const backgroundRow = makeRenderable('session-2', {
                machineId: 'machine-1',
                path: '/workspace/background',
                host: 'workstation.local',
            });
            storage.setState((state) => ({
                ...state,
                sessionListRowStateByServerId: {
                    'server-1': {
                        'session-1': visibleRow,
                        'session-2': backgroundRow,
                    },
                },
            }));

            const paneState = {
                summary: {
                    sessionsReady: true,
                    sessionCount: 1,
                },
                visibleSessionListIndex: [
                    {
                        type: 'session',
                        sessionId: 'session-1',
                        serverId: 'server-1',
                        groupKey: 'active',
                    },
                ] satisfies ReadonlyArray<SessionListIndexItem>,
                hasHiddenInactiveSessions: false,
                folderFocus: null,
                showLoading: false,
                showEmptyState: false,
            } as VisibleSessionListPaneState;

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionListRenderModels({
                    paneState,
                    collapsedGroupKeys: {},
                    machineDisplayById: {},
                    workspaceLabels: {},
                    workspaceRefs: [],
                    pinnedKeySet: new Set<string>(),
                    sessionTags: {},
                    selectedSessionId: null,
                    showServerBadge: false,
                    showPinnedServerBadge: false,
                });
            });

            const initialReachabilityDerivations = syncPerformanceTelemetry.snapshot().events
                .filter((event) => event.name === 'ui.sessionsList.render.reachabilityDisplayMap')
                .length;
            const initialModels = hook.getCurrent();
            const initialRenderCount = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowStateByServerId: {
                        ...state.sessionListRowStateByServerId,
                        'server-1': {
                            ...(state.sessionListRowStateByServerId['server-1'] ?? {}),
                            'session-2': {
                                ...backgroundRow,
                                updatedAt: 42,
                                thinkingAt: 42,
                                pendingVersion: 42,
                            },
                        },
                    },
                }));
            });
            await flushHookEffects({ cycles: 1, turns: 2 });

            const nextReachabilityDerivations = syncPerformanceTelemetry.snapshot().events
                .filter((event) => event.name === 'ui.sessionsList.render.reachabilityDisplayMap')
                .length;

            expect(hook.getCurrent()).toBe(initialModels);
            expect(renderCount).toBe(initialRenderCount);
            expect(nextReachabilityDerivations).toBe(initialReachabilityDerivations);

            await hook.unmount();
        } finally {
            syncPerformanceTelemetry.configure({ enabled: false });
            storage.setState(previousState);
        }
    });

    it('narrows row renderable subscriptions after viewability while retaining cached offscreen rows', async () => {
        const previousState = storage.getState();
        try {
            const visibleRow = makeRenderable('session-1', {
                machineId: 'machine-1',
                path: '/workspace/visible',
                host: 'workstation.local',
            });
            const backgroundRow = makeRenderable('session-2', {
                machineId: 'machine-1',
                path: '/workspace/background',
                host: 'workstation.local',
            });
            storage.setState((state) => ({
                ...state,
                sessionListRowStateByServerId: {
                    'server-1': {
                        'session-1': visibleRow,
                        'session-2': backgroundRow,
                    },
                },
            }));

            const paneState = {
                summary: {
                    sessionsReady: true,
                    sessionCount: 2,
                },
                visibleSessionListIndex: [
                    {
                        type: 'session',
                        sessionId: 'session-1',
                        serverId: 'server-1',
                        groupKey: 'active',
                    },
                    {
                        type: 'session',
                        sessionId: 'session-2',
                        serverId: 'server-1',
                        groupKey: 'active',
                    },
                ] satisfies ReadonlyArray<SessionListIndexItem>,
                hasHiddenInactiveSessions: false,
                folderFocus: null,
                showLoading: false,
                showEmptyState: false,
            } as VisibleSessionListPaneState;

            let renderCount = 0;
            const initialInput: { rowSubscriptionKeys: ReadonlySet<string> | null } = { rowSubscriptionKeys: null };
            const hook = await renderHook((input: { rowSubscriptionKeys: ReadonlySet<string> | null }) => {
                renderCount += 1;
                return useSessionListRenderModels({
                    paneState,
                    collapsedGroupKeys: {},
                    machineDisplayById: {},
                    workspaceLabels: {},
                    workspaceRefs: [],
                    pinnedKeySet: new Set<string>(),
                    sessionTags: {},
                    selectedSessionId: null,
                    showServerBadge: false,
                    showPinnedServerBadge: false,
                    rowSubscriptionKeys: input.rowSubscriptionKeys,
                });
            }, {
                initialProps: initialInput,
            });

            const initialRows = hook.getCurrent().rowViewModels;
            expect(initialRows[0]?.session?.id).toBe(visibleRow.id);
            expect(initialRows[1]?.session?.id).toBe(backgroundRow.id);

            await act(async () => {
                await hook.rerender({ rowSubscriptionKeys: new Set(['server-1:session-1']) });
            });
            const narrowedRows = hook.getCurrent().rowViewModels;
            expect(narrowedRows[1]?.session?.id).toBe(backgroundRow.id);
            const renderCountAfterNarrow = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowStateByServerId: {
                        ...state.sessionListRowStateByServerId,
                        'server-1': {
                            ...(state.sessionListRowStateByServerId['server-1'] ?? {}),
                            'session-2': {
                                ...backgroundRow,
                                hasUnreadMessages: true,
                                updatedAt: 400,
                            },
                        },
                    },
                }));
            });
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(renderCount).toBe(renderCountAfterNarrow);
            expect(hook.getCurrent().rowViewModels[1]).toBe(narrowedRows[1]);
            expect(hook.getCurrent().rowViewModels[1]?.hasUnreadMessages).toBe(false);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowStateByServerId: {
                        ...state.sessionListRowStateByServerId,
                        'server-1': {
                            ...(state.sessionListRowStateByServerId['server-1'] ?? {}),
                            'session-1': {
                                ...visibleRow,
                                hasUnreadMessages: true,
                                updatedAt: 500,
                            },
                        },
                    },
                }));
            });
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(renderCount).toBeGreaterThan(renderCountAfterNarrow);
            expect(hook.getCurrent().rowViewModels[0]).not.toBe(narrowedRows[0]);
            expect(hook.getCurrent().rowViewModels[0]?.hasUnreadMessages).toBe(true);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('preserves unaffected visible row view-model references when one row renderable changes', async () => {
        const previousState = storage.getState();
        try {
            const firstRow = makeRenderable('session-1', {
                machineId: 'machine-1',
                path: '/workspace/one',
                host: 'workstation.local',
            });
            const secondRow = makeRenderable('session-2', {
                machineId: 'machine-1',
                path: '/workspace/two',
                host: 'workstation.local',
            });
            storage.setState((state) => ({
                ...state,
                sessionListRowStateByServerId: {
                    'server-1': {
                        'session-1': firstRow,
                        'session-2': secondRow,
                    },
                },
            }));

            const paneState = {
                summary: {
                    sessionsReady: true,
                    sessionCount: 2,
                },
                visibleSessionListIndex: [
                    {
                        type: 'session',
                        sessionId: 'session-1',
                        serverId: 'server-1',
                        groupKey: 'active',
                    },
                    {
                        type: 'session',
                        sessionId: 'session-2',
                        serverId: 'server-1',
                        groupKey: 'active',
                    },
                ] satisfies ReadonlyArray<SessionListIndexItem>,
                hasHiddenInactiveSessions: false,
                folderFocus: null,
                showLoading: false,
                showEmptyState: false,
            } as VisibleSessionListPaneState;

            const hook = await renderHook(() =>
                useSessionListRenderModels({
                    paneState,
                    collapsedGroupKeys: {},
                    machineDisplayById: {},
                    workspaceLabels: {},
                    workspaceRefs: [],
                    pinnedKeySet: new Set<string>(),
                    sessionTags: {},
                    selectedSessionId: null,
                    showServerBadge: false,
                    showPinnedServerBadge: false,
                }));

            const initialRows = hook.getCurrent().rowViewModels;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowStateByServerId: {
                        ...state.sessionListRowStateByServerId,
                        'server-1': {
                            ...(state.sessionListRowStateByServerId['server-1'] ?? {}),
                            'session-2': {
                                ...secondRow,
                                meaningfulActivityAt: secondRow.meaningfulActivityAt === 200 ? 300 : 200,
                                updatedAt: 300,
                            },
                        },
                    },
                }));
            });
            await flushHookEffects({ cycles: 1, turns: 2 });

            const nextRows = hook.getCurrent().rowViewModels;
            expect(nextRows[0]).toBe(initialRows[0]);
            expect(nextRows[1]).not.toBe(initialRows[1]);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

});
