import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Third-party rendering is outside this listing contract; its streaming renderer is unused here.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

import { renderHook, type RenderHookResult } from '@/dev/testkit';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListServerScopedRowKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';

import type { VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

import { useSessionListRenderModels } from './useSessionListRenderModels';

type SessionListRenderModels = ReturnType<typeof useSessionListRenderModels>;
type RowSubscriptionProps = Readonly<{ rowSubscriptionKeys: ReadonlySet<string> | null }>;
import { computeVisibleSessionListIndex } from '@/sync/domains/session/listing/computeVisibleSessionListIndex';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

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

function rowKey(serverId: string, sessionId: string): string {
    const key = buildSessionListServerScopedRowKey(serverId, sessionId);
    if (!key) {
        throw new Error(`Expected a session-list row key for ${serverId}:${sessionId}`);
    }
    return key;
}

function accountToken(accountId: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub: accountId }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `header.${payload}.signature`;
}

describe('useSessionListRenderModels', () => {
    it('does not return retained Account A row data after the same Home binds Account B', async () => {
        const previousState = storage.getState();
        const profile = await upsertServerProfile({
            serverUrl: 'https://session-render-cache-lifetime.example.test',
            name: 'Session render cache lifetime',
        });
        const otherProfile = await upsertServerProfile({
            serverUrl: 'https://session-render-cache-unrelated.example.test',
            name: 'Unrelated Session render cache',
        });
        const serverId = profile.serverIdentityId ?? profile.id;
        const otherServerId = otherProfile.serverIdentityId ?? otherProfile.id;
        const sessionId = 'same-session';
        const aRow = {
            ...makeRenderable(sessionId, {
                name: 'Account A private title',
                path: '/account-a/private-workspace',
                homeDir: '/account-a',
                host: 'account-a-host',
                machineId: 'machine-a',
            }),
            responsibleAccountId: 'account-a',
            responsibleAccount: {
                kind: 'account' as const,
                accountId: 'account-a',
                firstName: 'Alice',
                lastName: 'Private',
                username: 'alice-private',
                avatarUrl: null,
            },
        } satisfies SessionListRenderableSession;
        const bRow = {
            ...makeRenderable(sessionId, {
                name: 'Account B title',
                path: '/account-b/workspace',
                homeDir: '/account-b',
                host: 'account-b-host',
                machineId: 'machine-b',
            }),
            responsibleAccountId: 'account-b',
            responsibleAccount: {
                kind: 'account' as const,
                accountId: 'account-b',
                firstName: 'Bob',
                lastName: 'Current',
                username: 'bob-current',
                avatarUrl: null,
            },
        } satisfies SessionListRenderableSession;
        const unrelatedRow = makeRenderable('unrelated-session', {
            name: 'Unrelated Account C title',
            path: '/account-c/workspace',
            homeDir: '/account-c',
            host: 'account-c-host',
            machineId: 'machine-c',
        });
        const paneState = {
            summary: { sessionsReady: true, sessionCount: 2 },
            visibleSessionListIndex: [
                {
                    type: 'session' as const,
                    sessionId,
                    serverId,
                    groupKey: 'active',
                },
                {
                    type: 'session' as const,
                    sessionId: unrelatedRow.id,
                    serverId: otherServerId,
                    groupKey: 'active',
                },
            ],
            hasHiddenInactiveSessions: false,
            folderFocus: null,
            folderFeatureEnabledServerIds: [],
            showLoading: false,
            showEmptyState: false,
        } satisfies VisibleSessionListPaneState;
        const common = {
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
            clocksActive: false,
        };
        let hook: RenderHookResult<SessionListRenderModels, RowSubscriptionProps> | null = null;

        try {
            await TokenStorage.setCredentialsForServerUrl(profile.serverUrl, { serverId }, {
                token: accountToken('account-a'),
            });
            await TokenStorage.setCredentialsForServerUrl(otherProfile.serverUrl, { serverId: otherServerId }, {
                token: accountToken('account-c'),
            });
            storage.setState((state) => ({
                ...state,
                sessionListRowsByServerId: {
                    ...state.sessionListRowsByServerId,
                    [serverId]: { [sessionId]: aRow },
                    [otherServerId]: { [unrelatedRow.id]: unrelatedRow },
                },
            }));
            hook = await renderHook<SessionListRenderModels, RowSubscriptionProps>(
                (props) => useSessionListRenderModels({
                    ...common,
                    rowSubscriptionKeys: props.rowSubscriptionKeys,
                }),
                { initialProps: { rowSubscriptionKeys: null } },
            );
            await vi.waitFor(() => {
                expect(hook?.getCurrent().rowViewModels[0]?.session?.metadata?.name)
                    .toBe('Account A private title');
            });
            const unrelatedSessionBeforeRetirement = hook.getCurrent().rowViewModels[1]?.session;

            await act(async () => {
                await TokenStorage.setCredentialsForServerUrl(profile.serverUrl, { serverId }, {
                    token: accountToken('account-b'),
                });
                storage.setState((state) => ({
                    ...state,
                    sessionListRowsByServerId: {
                        ...state.sessionListRowsByServerId,
                        [serverId]: {},
                    },
                }));
                await hook?.rerender({ rowSubscriptionKeys: new Set<string>() });
            });
            await flushHookEffects({ cycles: 2, turns: 2 });

            const placeholderJson = JSON.stringify(hook.getCurrent().rowViewModels[0] ?? null);
            expect(placeholderJson).not.toContain('Account A private title');
            expect(placeholderJson).not.toContain('/account-a/private-workspace');
            expect(placeholderJson).not.toContain('alice-private');
            expect(hook.getCurrent().rowViewModels[0]?.session).toBeNull();
            expect(hook.getCurrent().rowViewModels[1]?.session).toBe(unrelatedSessionBeforeRetirement);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowsByServerId: {
                        ...state.sessionListRowsByServerId,
                        [serverId]: { [sessionId]: bRow },
                    },
                }));
                await hook?.rerender({ rowSubscriptionKeys: new Set([rowKey(serverId, sessionId)]) });
            });
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(hook.getCurrent().rowViewModels[0]?.session?.metadata?.name).toBe('Account B title');
            expect(hook.getCurrent().rowViewModels[0]?.session?.responsibleAccountId).toBe('account-b');
            expect(JSON.stringify(hook.getCurrent().rowViewModels[0])).not.toContain('Account A');
        } finally {
            await hook?.unmount();
            storage.setState(previousState);
            await TokenStorage.removeCredentialsForServerUrl(profile.serverUrl, { serverId });
            await TokenStorage.removeCredentialsForServerUrl(otherProfile.serverUrl, { serverId: otherServerId });
            await removeServerProfile(profile.id);
            await removeServerProfile(otherProfile.id);
        }
    });

    it('keeps retained row context stable when only the Home query phase becomes offline', async () => {
        const previousState = storage.getState();
        const row = makeRenderable('same-session', { path: '/workspace/project', host: 'home-a' });
        const makeQueryState = (phase: 'ready' | 'offline') => ({
            requestedQueryKey: 'query-a',
            appliedQueryKey: 'query-a',
            addresses: [{ serverId: 'home-a', sessionId: 'same-session' }],
            nextCursor: null,
            hasNext: false,
            attentionNextCursor: null,
            attentionHasNext: false,
            phase,
            freshnessAt: 1_000,
            failureReason: null,
            failureCode: null,
            appliedSourceKind: 'query' as const,
        });
        const pane = (phase: 'ready' | 'offline'): VisibleSessionListPaneState => ({
            summary: { sessionsReady: true, sessionCount: 1 },
            visibleSessionListIndex: [{
                type: 'session', sessionId: 'same-session', serverId: 'home-a', groupKey: 'active',
            }],
            hasHiddenInactiveSessions: false,
            folderFocus: null,
            folderFeatureEnabledServerIds: [],
            showLoading: false,
            showEmptyState: false,
            query: {
                active: true,
                statesByServerId: { 'home-a': makeQueryState(phase) },
                byServerId: {},
                source: [],
                coverageComplete: phase === 'ready',
                loadNext: async () => {},
                refresh: async () => {},
            },
        });
        storage.setState((state) => ({
            ...state,
            sessionListRowsByServerId: { 'home-a': { 'same-session': row } },
            concurrentSessionListCacheByServerId: {},
        }));
        const common = {
            collapsedGroupKeys: {}, machineDisplayById: {}, workspaceLabels: {}, workspaceRefs: [],
            pinnedKeySet: new Set<string>(), sessionTags: {}, selectedSessionId: null,
            showServerBadge: false, showPinnedServerBadge: false, clocksActive: false,
        };
        const hook = await renderHook(
            (props: { paneState: VisibleSessionListPaneState }) => useSessionListRenderModels({ ...common, ...props }),
            { initialProps: { paneState: pane('ready') } },
        );
        try {
            const readySubtitle = hook.getCurrent().rowViewModels[0]?.subtitleOverride;
            expect(readySubtitle).not.toContain('Offline');
            await hook.rerender({ paneState: pane('offline') });
            expect(hook.getCurrent().rowViewModels[0]?.subtitleOverride).toBe(readySubtitle);
        } finally {
            await hook.unmount();
            storage.setState(previousState);
        }
    });

    it.each([1_000, 10_000])('measures layout and visible subscription work for %i loaded rows', async (count) => {
        syncPerformanceTelemetry.configure({ enabled: true, slowThresholdMs: 0 });
        const previousState = storage.getState();
        const rowsByServer: Record<string, Record<string, SessionListRenderableSession>> = {};
        const source: SessionListIndexItem[] = [];
        const subscribedKeys = new Set<string>();
        for (let index = 0; index < count; index += 1) {
            const serverId = `measurement-home-${index % 3}`;
            const id = `measurement-session-${index}`;
            const row = {
                ...makeRenderable(id, { path: `/workspace/project-${index % 10}`, host: serverId }),
                meaningfulActivityAt: 1_700_000_000_000 - index * 300_000,
            };
            (rowsByServer[serverId] ??= {})[id] = row;
            source.push({ type: 'session', sessionId: id, serverId, section: 'inactive', groupKind: 'project', groupKey: `${serverId}:project-${index % 10}` });
            if (index < 30) subscribedKeys.add(rowKey(serverId, id));
        }
        const indexTimes: { layout: string; durationMs: number }[] = [];
        const buildIndex = (layout: 'projects' | 'recent_activity') => {
            const start = performance.now();
            const result = computeVisibleSessionListIndex({
                source,
                resolveSessionRow: (serverId, id) => rowsByServer[serverId ?? '']?.[id] ?? null,
                hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
                sessionListSectionModeV1: 'single', sessionListLayoutChoice: layout,
                presentation: { enabled: false, presentation: 'grouped' }, nowMs: 1_700_000_000_000,
            });
            indexTimes.push({ layout, durationMs: performance.now() - start });
            return result;
        };
        let renderCount = 0;
        const pane = (index: ReadonlyArray<SessionListIndexItem> | null) => ({
            summary: { sessionsReady: true, sessionCount: count },
            visibleSessionListIndex: index, hasHiddenInactiveSessions: false,
            folderFocus: null, folderFeatureEnabledServerIds: [], showLoading: false, showEmptyState: false,
        } as VisibleSessionListPaneState);
        const common = {
            collapsedGroupKeys: {}, machineDisplayById: {}, workspaceLabels: {}, workspaceRefs: [],
            pinnedKeySet: new Set<string>(), sessionTags: {}, selectedSessionId: null,
            showServerBadge: false, showPinnedServerBadge: false, clocksActive: false,
            rowViewModelMode: 'deferred' as const,
        };
        storage.setState({ sessionListRowsByServerId: rowsByServer });
        const started = performance.now();
        const hook = await renderHook<
            SessionListRenderModels,
            Readonly<{ paneState: VisibleSessionListPaneState } & RowSubscriptionProps>
        >((props) => {
            renderCount += 1;
            return useSessionListRenderModels({ ...common, ...props });
        }, { initialProps: { paneState: pane(buildIndex('projects')), rowSubscriptionKeys: null } });
        try {
            await flushHookEffects({ cycles: 1, turns: 2 });
            const initialModelMs = performance.now() - started;
            expect(hook.getCurrent().rowViewModels).toHaveLength(count);
            // Match the production shell's deferred row models and virtualizer lifecycle.
            await hook.rerender({ paneState: pane(source), rowSubscriptionKeys: subscribedKeys });
            const beforeUnrelated = renderCount;
            await act(async () => {
                const id = `measurement-session-${count - 1}`;
                const serverId = `measurement-home-${(count - 1) % 3}`;
                const rows = rowsByServer[serverId]!;
                storage.setState({ sessionListRowsByServerId: {
                    ...rowsByServer, [serverId]: { ...rows, [id]: { ...rows[id]!, updatedAt: 999 } },
                } });
            });
            await flushHookEffects({ cycles: 1, turns: 2 });
            const offscreenUpdateRenders = renderCount - beforeUnrelated;
            expect(offscreenUpdateRenders).toBe(0);
            const switchStarted = performance.now();
            for (let change = 0; change < 6; change += 1) {
                await hook.rerender({ paneState: pane(buildIndex(change % 2 === 0 ? 'recent_activity' : 'projects')), rowSubscriptionKeys: subscribedKeys });
                expect(hook.getCurrent().listItems.filter((item) => item.type === 'session')).toHaveLength(count);
                expect(hook.getCurrent().rowViewModels.filter(Boolean)).toHaveLength(0);
            }
            console.info('SESSION_ROW_MODEL_MEASUREMENT', JSON.stringify({
                loadedRows: count, homes: 3, subscribedRows: subscribedKeys.size,
                initialModelMs, offscreenUpdateRenders, hookRenders: renderCount,
                layoutChanges: 6, layoutSwitchMs: performance.now() - switchStarted, indexTimes,
                derivations: syncPerformanceTelemetry.snapshot().events.map(({ name, count, totalMs, maxMs }) => ({ name, count, totalMs, maxMs })),
                boundary: 'real index and production deferred shell; not native row paint or geometry',
            }));
        } finally {
            await hook.unmount();
            storage.setState(previousState);
        }
    }, 60_000);

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
                sessionListRowsByServerId: {
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
                folderFeatureEnabledServerIds: [],
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

    it('does not rerender parent render models when a subscribed row renderable changes without reachability changes', async () => {
        const previousState = storage.getState();
        let hook: RenderHookResult<SessionListRenderModels, void> | null = null;
        try {
            const row = makeRenderable('session-1', {
                machineId: 'machine-1',
                path: '/workspace/active',
                host: 'workstation.local',
            });
            storage.setState((state) => ({
                ...state,
                sessionListRowsByServerId: {
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
                folderFeatureEnabledServerIds: [],
                showLoading: false,
                showEmptyState: false,
            } as VisibleSessionListPaneState;

            let renderCount = 0;
            hook = await renderHook(() => {
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
                    rowViewModelMode: 'deferred',
                });
            });
            await flushHookEffects({ cycles: 1, turns: 2 });
            const stableRenderCount = renderCount;
            const initial = hook.getCurrent();

            act(() => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowsByServerId: {
                        ...state.sessionListRowsByServerId,
                        'server-1': {
                            ...state.sessionListRowsByServerId?.['server-1'],
                            'session-1': {
                                ...row,
                                active: true,
                                activeAt: 1_000,
                                thinking: true,
                                thinkingAt: 1_000,
                                presence: 'online',
                            },
                        },
                    },
                }));
            });
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(renderCount).toBe(stableRenderCount);
            expect(hook.getCurrent()).toBe(initial);
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
            folderFeatureEnabledServerIds: [],
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
            folderFeatureEnabledServerIds: [],
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

        const refreshed = await hook.rerender({
            paneState: {
                ...paneState,
                visibleSessionListIndex: paneState.visibleSessionListIndex?.map((item) => ({ ...item })) ?? null,
            },
            collapsedGroupKeys: {},
            workspaceLabels: {},
            workspaceRefs: [],
            sessionTags: {},
        });
        expect(refreshed.existingDraftBySessionKey).toBe(first.existingDraftBySessionKey);
        expect(refreshed.reachableSessionDisplayById).toBe(first.reachableSessionDisplayById);
        expect(refreshed.reachableSessionDisplayByKey).toBe(first.reachableSessionDisplayByKey);
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
            folderFeatureEnabledServerIds: [],
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

        // Telemetry aggregates repeated derivations of one event name: `fields`
        // sums every observation, so asserting exact summed cardinality silently
        // depends on the render-pass count, and mount-time subscription hydration
        // (audience/credential bindings) legitimately re-renders the hook. Assert
        // per-derivation cardinality through `fieldStats` instead: min/max bound
        // every single observation, so a derivation observing stale or leaked
        // counts still fails, while the number of render passes does not matter.
        const events = syncPerformanceTelemetry.snapshot().events;
        const expectPerDerivationCardinality = (name: string, fields: Record<string, number>) => {
            const event = events.find((candidate) => candidate.name === name);
            expect(event?.count ?? 0).toBeGreaterThan(0);
            for (const [field, value] of Object.entries(fields)) {
                expect(event?.fieldStats[field]).toMatchObject({ min: value, max: value, last: value });
            }
        };
        expectPerDerivationCardinality('ui.sessionsList.render.collapsedFiltering', { items: 2, collapsedGroups: 0 });
        expectPerDerivationCardinality('ui.sessionsList.render.reachabilityDisplayMap', { items: 2, machines: 0, displayRows: 1 });
        expectPerDerivationCardinality('ui.sessionsList.render.selectedMapping', { items: 2, selectable: 1 });
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
            folderFeatureEnabledServerIds: [],
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
                    selectedTagIds: [],
                    searchableTextBySessionKey: {
                        [sessionAddressKey({ serverId: 'server-1', sessionId: 'session-1' })]: 'rebound workspace',
                    },
                },
                selectedSessionId: null,
                showServerBadge: false,
                showPinnedServerBadge: false,
            }));

        expect(hook.getCurrent().listItems.map((item) => item.type === 'session' ? item.sessionId : item.type === 'header' ? item.title : `run:${item.runId}`)).toEqual([
            'Active',
            'Today',
            'session-1',
        ]);

        await hook.unmount();
    });

    it('keeps the one-section corpus rendered when only the Pinned section is collapsed', async () => {
        const pinnedGroupKey = 'pinned';
        const projectGroupKey = 'server:server-1:project:repo';
        const paneState = {
            summary: {
                sessionsReady: true,
                sessionCount: 2,
            },
            // Projects and Recent activity head the corpus with `sessions`, never
            // with Active/Inactive, so collapsing Pinned must not swallow it.
            visibleSessionListIndex: [
                {
                    type: 'header',
                    title: 'Pinned',
                    headerKind: 'pinned',
                    groupKey: pinnedGroupKey,
                },
                {
                    type: 'session',
                    sessionId: 'pinned-session',
                    serverId: 'server-1',
                    groupKey: pinnedGroupKey,
                    groupKind: 'pinned',
                },
                {
                    type: 'header',
                    title: 'Sessions',
                    headerKind: 'sessions',
                    groupKey: 'sessions:server-1',
                    serverId: 'server-1',
                },
                {
                    type: 'header',
                    title: 'Repo',
                    headerKind: 'project',
                    groupKey: projectGroupKey,
                    serverId: 'server-1',
                },
                {
                    type: 'session',
                    sessionId: 'session-1',
                    serverId: 'server-1',
                    groupKey: projectGroupKey,
                    groupKind: 'project',
                },
            ] satisfies ReadonlyArray<SessionListIndexItem>,
            hasHiddenInactiveSessions: false,
            folderFocus: null,
            folderFeatureEnabledServerIds: [],
            showLoading: false,
            showEmptyState: false,
        } as VisibleSessionListPaneState;

        const hook = await renderHook(() =>
            useSessionListRenderModels({
                paneState,
                collapsedGroupKeys: { [pinnedGroupKey]: true },
                machineDisplayById: {},
                workspaceLabels: {},
                workspaceRefs: [],
                pinnedKeySet: new Set<string>(),
                sessionTags: {},
                selectedSessionId: null,
                showServerBadge: false,
                showPinnedServerBadge: false,
            }));

        expect(hook.getCurrent().listItems.map((item) => item.type === 'session' ? item.sessionId : item.type === 'header' ? item.title : `run:${item.runId}`)).toEqual([
            'Pinned',
            'Sessions',
            'Repo',
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
                sessionListRowsByServerId: {
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
                folderFeatureEnabledServerIds: [],
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
                    sessionListRowsByServerId: {
                        ...state.sessionListRowsByServerId,
                        'server-1': {
                            ...(state.sessionListRowsByServerId['server-1'] ?? {}),
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
                sessionListRowsByServerId: {
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
                folderFeatureEnabledServerIds: [],
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
                await hook.rerender({ rowSubscriptionKeys: new Set([rowKey('server-1', 'session-1')]) });
            });
            const narrowedRows = hook.getCurrent().rowViewModels;
            expect(narrowedRows[1]?.session?.id).toBe(backgroundRow.id);
            const renderCountAfterNarrow = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowsByServerId: {
                        ...state.sessionListRowsByServerId,
                        'server-1': {
                            ...(state.sessionListRowsByServerId['server-1'] ?? {}),
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
                    sessionListRowsByServerId: {
                        ...state.sessionListRowsByServerId,
                        'server-1': {
                            ...(state.sessionListRowsByServerId['server-1'] ?? {}),
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

    it('subscribes uncached inserted rows even when viewability keys are still stale', async () => {
        const previousState = storage.getState();
        try {
            const existingRow = makeRenderable('session-1', {
                machineId: 'machine-1',
                path: '/workspace/existing',
                host: 'workstation.local',
            });
            const insertedRow = makeRenderable('session-0', {
                machineId: 'machine-1',
                path: '/workspace/inserted',
                host: 'workstation.local',
            });
            storage.setState((state) => ({
                ...state,
                sessionListRowsByServerId: {
                    'server-1': {
                        'session-1': existingRow,
                    },
                },
            }));

            const initialPaneState = {
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
                folderFeatureEnabledServerIds: [],
                showLoading: false,
                showEmptyState: false,
            } as VisibleSessionListPaneState;
            const insertedPaneState = {
                ...initialPaneState,
                summary: {
                    sessionsReady: true,
                    sessionCount: 2,
                },
                visibleSessionListIndex: [
                    {
                        type: 'session',
                        sessionId: 'session-0',
                        serverId: 'server-1',
                        groupKey: 'active',
                    },
                    ...initialPaneState.visibleSessionListIndex!,
                ] satisfies ReadonlyArray<SessionListIndexItem>,
            } as VisibleSessionListPaneState;
            const staleViewabilityKeys = new Set([rowKey('server-1', 'session-1')]);

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
                    rowSubscriptionKeys: staleViewabilityKeys,
                }), {
                initialProps: { paneState: initialPaneState },
            });

            expect(hook.getCurrent().rowViewModels[0]?.session?.id).toBe('session-1');

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowsByServerId: {
                        ...state.sessionListRowsByServerId,
                        'server-1': {
                            ...(state.sessionListRowsByServerId['server-1'] ?? {}),
                            'session-0': insertedRow,
                        },
                    },
                }));
                await hook.rerender({ paneState: insertedPaneState });
            });
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(hook.getCurrent().rowViewModels[0]?.session?.id).toBe('session-0');
            expect(hook.getCurrent().rowViewModels[1]?.session?.id).toBe('session-1');

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not subscribe uncached inserted rows while row subscriptions are explicitly inactive', async () => {
        const previousState = storage.getState();
        try {
            const existingRow = makeRenderable('session-1', {
                machineId: 'machine-1',
                path: '/workspace/existing',
                host: 'workstation.local',
            });
            const insertedRow = makeRenderable('session-0', {
                machineId: 'machine-1',
                path: '/workspace/inserted',
                host: 'workstation.local',
            });
            storage.setState((state) => ({
                ...state,
                sessionListRowsByServerId: {
                    'server-1': {
                        'session-1': existingRow,
                    },
                },
            }));

            const initialPaneState = {
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
                folderFeatureEnabledServerIds: [],
                showLoading: false,
                showEmptyState: false,
            } as VisibleSessionListPaneState;
            const insertedPaneState = {
                ...initialPaneState,
                summary: {
                    sessionsReady: true,
                    sessionCount: 2,
                },
                visibleSessionListIndex: [
                    {
                        type: 'session',
                        sessionId: 'session-0',
                        serverId: 'server-1',
                        groupKey: 'active',
                    },
                    ...initialPaneState.visibleSessionListIndex!,
                ] satisfies ReadonlyArray<SessionListIndexItem>,
            } as VisibleSessionListPaneState;

            let renderCount = 0;
            const initialInput: {
                paneState: VisibleSessionListPaneState;
                rowSubscriptionKeys: ReadonlySet<string> | null;
            } = {
                paneState: initialPaneState,
                rowSubscriptionKeys: null,
            };
            const hook = await renderHook((input: {
                paneState: VisibleSessionListPaneState;
                rowSubscriptionKeys: ReadonlySet<string> | null;
            }) => {
                renderCount += 1;
                return useSessionListRenderModels({
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
                    rowSubscriptionKeys: input.rowSubscriptionKeys,
                });
            }, {
                initialProps: initialInput,
            });

            expect(hook.getCurrent().rowViewModels[0]?.session?.id).toBe('session-1');

            await act(async () => {
                await hook.rerender({
                    paneState: insertedPaneState,
                    rowSubscriptionKeys: new Set<string>(),
                });
            });
            const inactiveRows = hook.getCurrent().rowViewModels;
            const inactiveRenderCount = renderCount;
            expect(inactiveRows[0]?.session?.id).toBeUndefined();
            expect(inactiveRows[1]?.session?.id).toBe('session-1');

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowsByServerId: {
                        ...state.sessionListRowsByServerId,
                        'server-1': {
                            ...(state.sessionListRowsByServerId['server-1'] ?? {}),
                            'session-0': insertedRow,
                        },
                    },
                }));
            });
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(renderCount).toBe(inactiveRenderCount);
            expect(hook.getCurrent().rowViewModels[0]).toBe(inactiveRows[0]);
            expect(hook.getCurrent().rowViewModels[0]?.session?.id).toBeUndefined();

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
                sessionListRowsByServerId: {
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
                folderFeatureEnabledServerIds: [],
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
                    sessionListRowsByServerId: {
                        ...state.sessionListRowsByServerId,
                        'server-1': {
                            ...(state.sessionListRowsByServerId['server-1'] ?? {}),
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
