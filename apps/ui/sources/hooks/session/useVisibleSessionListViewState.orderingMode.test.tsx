import { afterEach, describe, expect, it, vi } from 'vitest';

// Third-party rendering is outside this listing contract; its streaming renderer is unused here.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

type SessionListOrderingModeV1 = 'custom' | 'created' | 'updated';
type SessionListAttentionPromotionModeV1 = 'off' | 'global' | 'withinGroups';
type SessionListWorkingPlacementModeV1 = 'off' | 'global' | 'withinGroups';

const viewState = vi.hoisted(() => ({
    orderingMode: 'updated' as SessionListOrderingModeV1,
    attentionPromotionMode: 'off' as SessionListAttentionPromotionModeV1,
    workingPlacementMode: 'off' as SessionListWorkingPlacementModeV1,
    sectionMode: 'single' as 'activity' | 'single',
    activeGrouping: 'project' as 'project' | 'date',
    hideInactiveSessions: false,
    selection: {
        enabled: true,
        presentation: 'grouped',
        activeServerId: 's1',
        allowedServerIds: ['s1'],
        explicit: false,
        activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
    } as any,
    source: null as SessionListIndexItem[] | null,
    groupOrder: {
        'server:s1:day:2026-02-17': ['s1:missing', 's1:a'],
    } as Record<string, string[]>,
    setGroupOrder: vi.fn(),
    rowsByServerId: {} as Record<string, Record<string, SessionListRenderableSession>>,
    observedOrderingMode: [] as Array<SessionListOrderingModeV1>,
    sessionFolders: { v: 1, folders: [] } as any,
    sessionFolderViewMode: 'off' as 'off' | 'tree',
    sessionFoldersFeatureEnabled: true,
    focusedSessionFolder: null as any,
    sessionFolderAssignmentsBySessionKey: {} as Record<string, string | null>,
    sessionOrganizationProjection: null as any,
    sessionOrganizationProjectionsByServerId: null as Record<string, any> | null,
    openApprovalSessionReferences: [] as ReadonlyArray<
        | { kind: 'exact'; address: { serverId: string; sessionId: string } }
        | { kind: 'legacy_unscoped'; sessionId: string }
    >,
    pathname: '/session/none',
    focusedSessionId: null as string | null,
    sourceStateOptions: [] as Array<Record<string, unknown>>,
    query: {
        active: false,
        statesByServerId: {} as Record<string, { appliedSourceKind: 'query' | 'ordinary' | null } | undefined>,
    },
    visibleIndexComputeCount: 0,
}));

function makeSessionRow(id: string, partial?: Partial<SessionListRenderableSession>): SessionListRenderableSession {
    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: 0,
        archivedAt: null,
        pendingVersion: undefined,
        pendingCount: undefined,
        metadataVersion: 0,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
        owner: undefined,
        accessLevel: undefined,
        canApprovePermissions: undefined,
        hasPendingPermissionRequests: undefined,
        hasPendingUserActionRequests: undefined,
        hasUnreadMessages: false,
        keepVisibleWhenInactive: false,
        ...(partial ?? {}),
    };
}

function makeSourceIndex(): SessionListIndexItem[] {
    const groupKey = 'server:s1:day:2026-02-17';
    return [
        { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
        { type: 'session', sessionId: 'b', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        { type: 'session', sessionId: 'a', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
    ];
}

function setSessionOrganizationProjection(params: Readonly<{
    pinnedSessionIds?: readonly string[];
    folders?: ReadonlyArray<Readonly<{
        id: string;
        name: string;
        workspace: Readonly<{
            t: 'workspaceScope';
            serverId: string;
            machineId: string;
            rootPath: string;
        }>;
        parentId?: string | null;
        sortKey?: string | null;
    }>>;
    folderAssignmentsBySessionId?: Readonly<Record<string, string | null>>;
}>): void {
    viewState.sessionOrganizationProjection = {
        schemaVersion: 1,
        version: 1,
        pinnedSessionIds: params.pinnedSessionIds ?? [],
        pinsBySessionId: Object.fromEntries((params.pinnedSessionIds ?? []).map((sessionId, index) => [
            sessionId,
            { sessionId, sortKey: String(index + 1).padStart(4, '0'), pinnedAt: index + 1 },
        ])),
        foldersById: Object.fromEntries((params.folders ?? []).map((folder, index) => [
            folder.id,
            {
                folderId: folder.id,
                folderKey: folder.id,
                parentFolderId: folder.parentId ?? null,
                parentFolderKey: folder.parentId ?? null,
                sortKey: folder.sortKey ?? String(index + 1).padStart(4, '0'),
                display: {
                    t: 'plain',
                    v: {
                        name: folder.name,
                        workspace: folder.workspace,
                    },
                },
                displayState: { status: 'available', value: null },
                archivedAt: null,
                createdAt: 1,
                updatedAt: 1,
            },
        ])),
        folderAssignmentsBySessionId: params.folderAssignmentsBySessionId ?? {},
        tagsById: {},
        tagAssignmentsBySessionId: {},
        attentionStandingsBySessionId: {},
        orderEntriesByScopeKey: {},
        labelsByLabelKey: {},
    };
}

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const store = createStorageStoreMock({ workflowRunListWindows: {}, workflowRunsById: {} });
    return createStorageModuleStub({
            storage: store,
            getStorage: () => store,
            useSessionListRowsByServerId: () => viewState.rowsByServerId,
            useArtifacts: () => {
                throw new Error('session list view state must use canonical row state instead of full artifacts');
            },
            useOpenApprovalSessionReferences: () => viewState.openApprovalSessionReferences,
            useSetting: ((key: string) => {
                if (key === 'hideInactiveSessions') return viewState.hideInactiveSessions;
                if (key === 'pinnedSessionKeysV1') return [];
                if (key === 'sessionListOrderingModeV1') {
                    viewState.observedOrderingMode.push(viewState.orderingMode);
                    return viewState.orderingMode;
                }
                if (key === 'sessionListAttentionPromotionModeV1') return viewState.attentionPromotionMode;
                if (key === 'sessionListWorkingPlacementModeV1') return viewState.workingPlacementMode;
                if (key === 'sessionListSectionModeV1') return viewState.sectionMode;
                if (key === 'sessionListActiveGroupingV1') return viewState.activeGrouping;
                if (key === 'sessionFoldersV1') return viewState.sessionFolders;
                if (key === 'sessionFolderViewModeV1') return viewState.sessionFolderViewMode;
                return null;
            }) as any,
            useSettingMutable: ((key: string) => {
                if (key === 'sessionListGroupOrderV1') {
                    return [viewState.groupOrder, viewState.setGroupOrder];
                }
                return [null, vi.fn()];
            }) as any,
            useLocalSetting: ((key: string) => {
                if (key === 'sessionListFocusedFolderV1') return viewState.focusedSessionFolder;
                return null;
            }) as any,
            useSessionFolderAssignmentsBySessionKey: () => viewState.sessionFolderAssignmentsBySessionKey,
            useSessionOrganizationProjection: () => viewState.sessionOrganizationProjection,
            useSessionOrganizationProjections: (serverIds: readonly string[]) => viewState.sessionOrganizationProjectionsByServerId
                ? Object.fromEntries(serverIds.flatMap((serverId) => {
                    const projection = viewState.sessionOrganizationProjectionsByServerId?.[serverId];
                    return projection ? [[serverId, projection]] : [];
                }))
                : viewState.sessionOrganizationProjection
                    ? Object.fromEntries(serverIds.map((serverId) => [serverId, viewState.sessionOrganizationProjection]))
                    : {},
    });
});

vi.mock('@/sync/domains/session/listing/useSessionListQuerySourceState', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/session/listing/useSessionListQuerySourceState')>()),
    useSessionListFeatureHomeSupportByServerId: (
        _featureId: string,
        serverIds: readonly string[],
    ) => Object.fromEntries(serverIds.map((serverId) => [serverId, viewState.sessionFoldersFeatureEnabled])),
}));

vi.mock('expo-router', () => ({
    usePathname: () => viewState.pathname,
}));

vi.mock('@/sync/domains/session/sessionSurfaceVisibility', () => ({
    useFocusedSessionId: () => viewState.focusedSessionId,
    useFocusedSessionAddress: () => viewState.focusedSessionId
        ? { serverId: viewState.selection.activeServerId, sessionId: viewState.focusedSessionId }
        : null,
}));

vi.mock('./useVisibleSessionListSourceState', () => ({
    useVisibleSessionListSourceState: (options: Record<string, unknown>) => {
        viewState.sourceStateOptions.push(options);
        return {
            selection: viewState.selection,
            activeIndex: viewState.source,
            byServerId: {},
            source: viewState.source,
            query: viewState.query,
        };
    },
}));

vi.mock('@/sync/domains/session/listing/computeVisibleSessionListIndex', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/session/listing/computeVisibleSessionListIndex')>();
    return {
        ...actual,
        computeVisibleSessionListIndex: (...args: Parameters<typeof actual.computeVisibleSessionListIndex>) => {
            viewState.visibleIndexComputeCount += 1;
            return actual.computeVisibleSessionListIndex(...args);
        },
    };
});

// Complete the real hook graph during collection, after the boundary factories
// initialize, rather than charging its cold imports to the first test's clock.
const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');

describe('useVisibleSessionListViewState (index pipeline)', () => {
    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
        viewState.orderingMode = 'updated';
        viewState.attentionPromotionMode = 'off';
        viewState.workingPlacementMode = 'off';
        viewState.sectionMode = 'single';
        viewState.activeGrouping = 'project';
        viewState.source = null;
        viewState.selection = {
            enabled: true,
            presentation: 'grouped',
            activeServerId: 's1',
            allowedServerIds: ['s1'],
            explicit: false,
            activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
        };
        viewState.groupOrder = {
            'server:s1:day:2026-02-17': ['s1:missing', 's1:a'],
        };
        viewState.hideInactiveSessions = false;
        viewState.rowsByServerId = {};
        viewState.observedOrderingMode.length = 0;
        viewState.setGroupOrder.mockClear();
        viewState.sessionFolders = { v: 1, folders: [] };
        viewState.sessionFolderViewMode = 'off';
        viewState.sessionFoldersFeatureEnabled = true;
        viewState.focusedSessionFolder = null;
        viewState.sessionFolderAssignmentsBySessionKey = {};
        viewState.sessionOrganizationProjection = null;
        viewState.sessionOrganizationProjectionsByServerId = null;
        viewState.openApprovalSessionReferences = [];
        viewState.pathname = '/session/none';
        viewState.focusedSessionId = null;
        viewState.sourceStateOptions = [];
        viewState.query = { active: false, statesByServerId: {} };
        viewState.visibleIndexComputeCount = 0;
    });

    it('forwards authoritative empty-query completeness to the source owner', async () => {
        await renderHook(() => useVisibleSessionListViewState('all', {
            queryHomes: [],
            emptyQuerySelectionComplete: true,
        }));

        expect(viewState.sourceStateOptions.at(-1)).toMatchObject({
            queryHomes: [],
            emptyQuerySelectionComplete: true,
        });
    });

    it('keeps dormant manual group order data untouched when ordering mode is updated', async () => {
        viewState.orderingMode = 'updated';
        viewState.source = makeSourceIndex();
        viewState.rowsByServerId = {
            s1: {
                a: makeSessionRow('a', { createdAt: 20, updatedAt: 200 }),
                b: makeSessionRow('b', { createdAt: 10, updatedAt: 100 }),
            },
        };

        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        const sessionIds = (hook.getCurrent()?.visibleSessionListIndex ?? [])
            .filter((item) => item.type === 'session')
            .map((item) => (item as Extract<SessionListIndexItem, { type: 'session' }>).sessionId);

        expect(sessionIds).toEqual(['a', 'b']);
        expect(viewState.observedOrderingMode.length).toBeGreaterThan(0);
        expect(viewState.observedOrderingMode.every((mode) => mode === 'updated')).toBe(true);
        expect(viewState.setGroupOrder).not.toHaveBeenCalled();
    });

    it('renders the visible list state without a Node stdout stream', async () => {
        viewState.source = makeSourceIndex();
        viewState.rowsByServerId = {
            s1: {
                a: makeSessionRow('a', { createdAt: 20, updatedAt: 200 }),
                b: makeSessionRow('b', { createdAt: 10, updatedAt: 100 }),
            },
        };
        const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout');
        Object.defineProperty(process, 'stdout', {
            configurable: true,
            value: undefined,
        });

        let unmount: (() => Promise<void> | void) | null = null;
        try {
            const hook = await renderHook(() => useVisibleSessionListViewState('all'));
            unmount = () => hook.unmount();

            expect(hook.getCurrent().visibleSessionListIndex?.map((item) => item.type === 'header'
                ? `header:${item.headerKind ?? 'unknown'}`
                : item.type === 'session' ? `session:${item.sessionId}` : `run:${item.runId}`
            )).toEqual([
                'header:date',
                'session:a',
                'session:b',
            ]);
        } finally {
            if (unmount) await unmount();
            if (stdoutDescriptor) {
                Object.defineProperty(process, 'stdout', stdoutDescriptor);
            }
        }
    });

    it('uses server organization projection for pins and folder placement instead of legacy settings', async () => {
        viewState.sessionFolderViewMode = 'tree';
        viewState.source = [
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:s1:active:project:hash-a',
                workspaceKey: 'wl_hash_a',
                serverId: 's1',
                workspaceScopeHint: {
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
            },
            {
                type: 'session',
                sessionId: 'in-folder',
                serverId: 's1',
                section: 'active',
                groupKey: 'server:s1:active:project:hash-a',
                groupKind: 'project',
            },
            {
                type: 'session',
                sessionId: 'pinned',
                serverId: 's1',
                section: 'active',
                groupKey: 'server:s1:active:project:hash-a',
                groupKind: 'project',
            },
        ];
        viewState.rowsByServerId = {
            s1: {
                'in-folder': makeSessionRow('in-folder', { active: true, createdAt: 10 }),
                pinned: makeSessionRow('pinned', { active: true, createdAt: 9 }),
            },
        };
        viewState.sessionFolders = { v: 1, folders: [] };
        viewState.sessionFolderAssignmentsBySessionKey = {};
        viewState.sessionOrganizationProjection = {
            schemaVersion: 1,
            version: 7,
            pinnedSessionIds: ['pinned'],
            pinsBySessionId: {
                pinned: { sessionId: 'pinned', sortKey: '0001', pinnedAt: 1 },
            },
            foldersById: {
                'folder-a': {
                    folderId: 'folder-a',
                    folderKey: 'folder-a',
                    parentFolderId: null,
                    parentFolderKey: null,
                    sortKey: '0001',
                    display: {
                        t: 'plain',
                        v: {
                            name: 'Planning',
                            workspace: {
                                t: 'workspaceScope',
                                serverId: 's1',
                                machineId: 'm1',
                                rootPath: '/repo',
                            },
                        },
                    },
                    displayState: { status: 'available', value: null },
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                },
            },
            folderAssignmentsBySessionId: {
                'in-folder': 'folder-a',
            },
            tagsById: {},
            tagAssignmentsBySessionId: {},
            attentionStandingsBySessionId: {},
            orderEntriesByScopeKey: {},
            labelsByLabelKey: {},
        };

        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'pinned' }),
            expect.objectContaining({ type: 'session', sessionId: 'pinned', pinned: true }),
            expect.objectContaining({ type: 'header', headerKind: 'project' }),
            expect.objectContaining({ type: 'header', headerKind: 'folder', folderId: 'folder-a' }),
            expect.objectContaining({ type: 'session', sessionId: 'in-folder', folderId: 'folder-a' }),
        ]);
    });

    it('uses each selected Home organization projection and restores its scoped state after removal and re-add', async () => {
        viewState.sessionFolderViewMode = 'tree';
        viewState.selection = {
            enabled: true,
            presentation: 'grouped',
            activeServerId: 'home-a',
            allowedServerIds: ['home-a', 'home-b'],
            explicit: true,
            activeTarget: { kind: 'group', id: 'both' },
        };
        const workspace = (serverId: string) => ({
            t: 'workspaceScope' as const,
            serverId,
            machineId: `machine-${serverId}`,
            rootPath: '/repo',
        });
        viewState.source = ['home-a', 'home-b'].flatMap((serverId) => {
            const groupKey = `server:${serverId}:active:project:repo`;
            return [
                {
                    type: 'header' as const,
                    title: '/repo',
                    headerKind: 'project' as const,
                    groupKey,
                    serverId,
                    workspaceScopeHint: workspace(serverId),
                },
                {
                    type: 'session' as const,
                    sessionId: 'same-session',
                    serverId,
                    section: 'active' as const,
                    groupKey,
                    groupKind: 'project' as const,
                },
            ];
        });
        viewState.rowsByServerId = {
            'home-a': { 'same-session': makeSessionRow('same-session', { active: true }) },
            'home-b': { 'same-session': makeSessionRow('same-session', { active: true }) },
        };
        const projection = (serverId: string, pinned: boolean) => ({
            schemaVersion: 1,
            version: 1,
            pinnedSessionIds: pinned ? ['same-session'] : [],
            pinsBySessionId: pinned
                ? { 'same-session': { sessionId: 'same-session', sortKey: '0001', pinnedAt: 1 } }
                : {},
            foldersById: {
                [`folder-${serverId}`]: {
                    folderId: `folder-${serverId}`,
                    folderKey: `folder-${serverId}`,
                    parentFolderId: null,
                    parentFolderKey: null,
                    sortKey: '0001',
                    display: { t: 'plain', v: { name: `Folder ${serverId}`, workspace: workspace(serverId) } },
                    displayState: { status: 'available', value: null },
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                },
            },
            folderAssignmentsBySessionId: { 'same-session': `folder-${serverId}` },
            tagsById: {},
            tagAssignmentsBySessionId: {},
            attentionStandingsBySessionId: {},
            orderEntriesByScopeKey: {},
            labelsByLabelKey: {},
        });
        viewState.sessionOrganizationProjectionsByServerId = {
            'home-a': projection('home-a', false),
            'home-b': projection('home-b', false),
        };

        let queryHomes = [{ serverId: 'home-a' }, { serverId: 'home-b' }] as any;
        const hook = await renderHook(() => useVisibleSessionListViewState('all', { queryHomes }));
        await flushHookEffects();
        const readSessions = () => (hook.getCurrent().visibleSessionListIndex ?? [])
            .filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session')
            .map((item) => ({ serverId: item.serverId, folderId: item.folderId, pinned: item.pinned === true }));

        expect(readSessions()).toEqual(expect.arrayContaining([
            { serverId: 'home-a', folderId: 'folder-home-a', pinned: false },
            { serverId: 'home-b', folderId: 'folder-home-b', pinned: false },
        ]));

        viewState.sessionOrganizationProjectionsByServerId = {
            ...viewState.sessionOrganizationProjectionsByServerId,
            'home-b': projection('home-b', true),
        };
        await hook.rerender();
        await flushHookEffects();
        expect(readSessions()).toEqual(expect.arrayContaining([
            { serverId: 'home-b', folderId: 'folder-home-b', pinned: true },
        ]));

        queryHomes = [{ serverId: 'home-a' }] as any;
        await hook.rerender();
        await flushHookEffects();
        expect(readSessions().some((item) => item.serverId === 'home-b' && item.pinned)).toBe(false);

        queryHomes = [{ serverId: 'home-a' }, { serverId: 'home-b' }] as any;
        await hook.rerender();
        await flushHookEffects();
        expect(readSessions()).toEqual(expect.arrayContaining([
            { serverId: 'home-b', folderId: 'folder-home-b', pinned: true },
        ]));
    });

    it('does not write normalized manual group order while the sessions surface is not data-active', async () => {
        viewState.orderingMode = 'custom';
        viewState.source = makeSourceIndex();
        viewState.rowsByServerId = {
            s1: {
                a: makeSessionRow('a', { createdAt: 20, updatedAt: 200 }),
                b: makeSessionRow('b', { createdAt: 10, updatedAt: 100 }),
            },
        };

        const hook = await renderHook(() => useVisibleSessionListViewState('all', {
            sessionListSurfaceDataActive: false,
        }));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'session', sessionId: 'a' }),
            expect.objectContaining({ type: 'session', sessionId: 'b' }),
        ]));
        expect(viewState.setGroupOrder).not.toHaveBeenCalled();
    });

    it('keeps the visible index stable when unrelated row-state timing fields change', async () => {
        viewState.orderingMode = 'custom';
        viewState.source = makeSourceIndex();
        viewState.rowsByServerId = {
            s1: {
                a: makeSessionRow('a', { createdAt: 20, updatedAt: 200, thinkingAt: 20 }),
                b: makeSessionRow('b', { createdAt: 10, updatedAt: 100, thinkingAt: 10 }),
            },
        };

        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();
        const firstIndex = hook.getCurrent()?.visibleSessionListIndex;

        viewState.rowsByServerId = {
            s1: {
                a: makeSessionRow('a', { createdAt: 20, updatedAt: 250, thinkingAt: 25 }),
                b: makeSessionRow('b', { createdAt: 10, updatedAt: 150, thinkingAt: 15 }),
            },
        };
        await hook.rerender();
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toBe(firstIndex);
    });

    it('exposes when the inactive filter hides all visible sessions', async () => {
        viewState.hideInactiveSessions = true;
        viewState.source = [
            { type: 'session', sessionId: 'inactive', serverId: 's1', section: 'inactive', groupKey: 'server:s1:day:2026-02-17', groupKind: 'date' },
        ];
        viewState.rowsByServerId = {
            s1: {
                inactive: makeSessionRow('inactive', { active: false, keepVisibleWhenInactive: false }),
            },
        };

        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([]);
        expect(hook.getCurrent()?.hasHiddenInactiveSessions).toBe(true);
    });

    it('does not re-apply the hidden-inactive rule to rows the strict query already filtered', async () => {
        viewState.hideInactiveSessions = true;
        viewState.source = [
            { type: 'session', sessionId: 'served-inactive', serverId: 's1', section: 'inactive', groupKey: 'server:s1:day:2026-02-17', groupKind: 'date' },
        ];
        viewState.rowsByServerId = {
            s1: {
                'served-inactive': makeSessionRow('served-inactive', { active: false, keepVisibleWhenInactive: false }),
            },
        };
        viewState.query = {
            active: true,
            statesByServerId: { s1: { appliedSourceKind: 'query' } },
        };

        const queryHomes = [{ serverId: 's1', query: {
            v: 1 as const, storage: 'active' as const, includeInactive: false,
            scope: 'my_work' as const, attention: 'any' as const, audiences: [], tagIds: [],
        } }];
        const hook = await renderHook(() => useVisibleSessionListViewState('all', { queryHomes }));
        await flushHookEffects();

        // The server returned this inactive row on purpose (it needs attention);
        // the client must not run a second, weaker inactive rule over it.
        expect(hook.getCurrent()?.visibleSessionListIndex?.filter((item) => item.type === 'session').map((item) => item.sessionId))
            .toEqual(['served-inactive']);
        expect(hook.getCurrent()?.hasHiddenInactiveSessions).toBe(false);

        // A Runs-inclusive query fetches inactive steps, so its ordinary inactive
        // Sessions still need the client's hide-inactive rule.
        const expandedQueryHook = await renderHook(() => useVisibleSessionListViewState('all', {
            queryHomes: queryHomes.map((home) => ({ ...home, query: { ...home.query, includeInactive: true } })),
        }));
        await flushHookEffects();
        expect(expandedQueryHook.getCurrent()?.visibleSessionListIndex).toEqual([]);

        // The released GET adapter answered this Home, so the local rule still applies.
        viewState.query = {
            active: true,
            statesByServerId: { s1: { appliedSourceKind: 'ordinary' } },
        };
        const ordinaryHook = await renderHook(() => useVisibleSessionListViewState('all', { queryHomes }));
        await flushHookEffects();
        expect(ordinaryHook.getCurrent()?.visibleSessionListIndex).toEqual([]);
        expect(ordinaryHook.getCurrent()?.hasHiddenInactiveSessions).toBe(true);
    });

    it('uses the attention promotion setting while preserving the canonical index pipeline', async () => {
        viewState.orderingMode = 'custom';
        viewState.attentionPromotionMode = 'global';
        viewState.selection = {
            enabled: false,
            presentation: 'grouped',
            activeServerId: 's1',
            allowedServerIds: ['s1'],
            explicit: false,
            activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
        };
        viewState.source = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: 'server:s1:day:2026-02-17' },
            { type: 'session', sessionId: 'done', serverId: 's1', section: 'inactive', groupKey: 'server:s1:day:2026-02-17', groupKind: 'date' },
            { type: 'session', sessionId: 'quiet', serverId: 's1', section: 'inactive', groupKey: 'server:s1:day:2026-02-17', groupKind: 'date' },
        ];
        viewState.rowsByServerId = {
            s1: {
                done: makeSessionRow('done', {
                    seq: 3,
                    latestTurnStatus: 'completed',
                    lastTurnCompletedAt: 300,
                    lastViewedSessionSeq: 2,
                    updatedAt: 300,
                }),
                quiet: makeSessionRow('quiet', { seq: 1, updatedAt: 100 }),
            },
        };

        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'attention' }),
            expect.objectContaining({ type: 'session', sessionId: 'done', groupKind: 'attention' }),
            expect.objectContaining({ type: 'header', headerKind: 'date' }),
            expect.objectContaining({ type: 'session', sessionId: 'quiet', groupKind: 'date' }),
        ]);
    });

    it('promotes a fresh pending-permission row through the index row-state resolver', async () => {
        viewState.attentionPromotionMode = 'global';
        viewState.source = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1', groupKey: 'server:s1:active' },
            { type: 'session', sessionId: 'normal', serverId: 's1', section: 'active', groupKey: 'server:s1:active', groupKind: 'active' },
            { type: 'session', sessionId: 'approval-session', serverId: 's1', section: 'active', groupKey: 'server:s1:active', groupKind: 'active' },
        ];
        viewState.rowsByServerId = {
            s1: {
                normal: makeSessionRow('normal', { active: true, presence: 'online', updatedAt: 100 }),
                'approval-session': makeSessionRow('approval-session', {
                    active: true,
                    activeAt: Date.now(),
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: Date.now(),
                    hasPendingPermissionRequests: true,
                    pendingRequestObservedAt: Date.now(),
                    updatedAt: 200,
                }),
            },
        };

        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'attention' }),
            expect.objectContaining({
                type: 'session',
                sessionId: 'approval-session',
                groupKind: 'attention',
                attentionPlacementReason: 'permission_required',
            }),
            expect.objectContaining({ type: 'header', headerKind: 'active' }),
            expect.objectContaining({ type: 'session', sessionId: 'normal', groupKind: 'active' }),
        ]);
    });

    it('does not reconstruct permission attention from an open approval artifact', async () => {
        viewState.attentionPromotionMode = 'global';
        viewState.openApprovalSessionReferences = [{ kind: 'legacy_unscoped', sessionId: 'approval-session' }];
        viewState.source = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1', groupKey: 'server:s1:active' },
            { type: 'session', sessionId: 'approval-session', serverId: 's1', section: 'active', groupKey: 'server:s1:active', groupKind: 'active' },
        ];
        viewState.rowsByServerId = {
            s1: {
                'approval-session': makeSessionRow('approval-session', {
                    active: true,
                    presence: 'online',
                    hasPendingPermissionRequests: false,
                    pendingRequestObservedAt: Date.now(),
                }),
            },
        };

        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'active' }),
            expect.objectContaining({
                type: 'session',
                sessionId: 'approval-session',
                groupKind: 'active',
            }),
        ]);
    });

    it('promotes only the matching server-scoped row when approval session ids collide across servers', async () => {
        viewState.attentionPromotionMode = 'global';
        viewState.source = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1', groupKey: 'server:s1:active' },
            { type: 'session', sessionId: 'approval-session', serverId: 's1', section: 'active', groupKey: 'server:s1:active', groupKind: 'active' },
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's2', groupKey: 'server:s2:active' },
            { type: 'session', sessionId: 'approval-session', serverId: 's2', section: 'active', groupKey: 'server:s2:active', groupKind: 'active' },
        ];
        viewState.rowsByServerId = {
            s1: {
                'approval-session': makeSessionRow('approval-session', { active: true, presence: 'online', updatedAt: 100 }),
            },
            s2: {
                'approval-session': makeSessionRow('approval-session', {
                    active: true,
                    activeAt: Date.now(),
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: Date.now(),
                    hasPendingPermissionRequests: true,
                    pendingRequestObservedAt: Date.now(),
                    updatedAt: 200,
                }),
            },
        };

        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'session',
                sessionId: 'approval-session',
                serverId: 's2',
                groupKind: 'attention',
                attentionPlacementReason: 'permission_required',
            }),
        ]));
        expect(hook.getCurrent()?.visibleSessionListIndex).not.toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'session',
                sessionId: 'approval-session',
                serverId: 's1',
                groupKind: 'attention',
            }),
        ]));
    });

    it('fails closed for a legacy unscoped approval when two Homes currently admit the same session id', async () => {
        viewState.attentionPromotionMode = 'global';
        viewState.openApprovalSessionReferences = [{ kind: 'legacy_unscoped', sessionId: 'approval-session' }];
        viewState.source = ['s1', 's2'].flatMap((serverId) => [
            { type: 'header' as const, headerKind: 'active' as const, title: 'Active', serverId, groupKey: `server:${serverId}:active` },
            { type: 'session' as const, sessionId: 'approval-session', serverId, section: 'active' as const,
                groupKey: `server:${serverId}:active`, groupKind: 'active' as const },
        ]);
        viewState.rowsByServerId = {
            s1: { 'approval-session': makeSessionRow('approval-session', { active: true, presence: 'online' }) },
            s2: { 'approval-session': makeSessionRow('approval-session', { active: true, presence: 'online' }) },
        };

        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).not.toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'session',
                sessionId: 'approval-session',
                groupKind: 'attention',
            }),
        ]));
    });

    it('retains previously visible working rows after switching active sessions', async () => {
        const now = 1_000_000;
        vi.useFakeTimers();
        vi.setSystemTime(now);
        viewState.orderingMode = 'custom';
        viewState.workingPlacementMode = 'global';
        viewState.pathname = '/session/other';
        viewState.source = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1', groupKey: 'server:s1:active' },
            { type: 'session', sessionId: 'stale-working', serverId: 's1', section: 'active', groupKey: 'server:s1:active', groupKind: 'active' },
            { type: 'session', sessionId: 'other', serverId: 's1', section: 'active', groupKey: 'server:s1:active', groupKind: 'active' },
        ];
        viewState.rowsByServerId = {
            s1: {
                'stale-working': makeSessionRow('stale-working', {
                    active: true,
                    activeAt: now - 1_000,
                    presence: 'online',
                    thinking: true,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    updatedAt: 200,
                }),
                other: makeSessionRow('other', { active: true, presence: 'online', updatedAt: 100 }),
            },
        };

        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'working' }),
            expect.objectContaining({ type: 'session', sessionId: 'stale-working', groupKind: 'working' }),
            expect.objectContaining({ type: 'header', headerKind: 'active' }),
            expect.objectContaining({ type: 'session', sessionId: 'other', groupKind: 'active' }),
        ]);

        vi.setSystemTime(now + 130_000);
        viewState.pathname = '/session/other';
        viewState.rowsByServerId = {
            s1: {
                'stale-working': makeSessionRow('stale-working', {
                    active: true,
                    activeAt: now - 1_000,
                    presence: 'online',
                    thinking: true,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    updatedAt: 200,
                }),
                other: makeSessionRow('other', { active: true, presence: 'online', updatedAt: 100 }),
            },
        };
        await hook.rerender();
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'working' }),
            expect.objectContaining({ type: 'session', sessionId: 'stale-working', groupKind: 'working' }),
            expect.objectContaining({ type: 'header', headerKind: 'active' }),
            expect.objectContaining({ type: 'session', sessionId: 'other', groupKind: 'active' }),
        ]);

        viewState.rowsByServerId = {
            s1: {
                'stale-working': makeSessionRow('stale-working', {
                    active: false,
                    presence: 'online',
                    latestTurnStatus: 'cancelled',
                    latestTurnStatusObservedAt: now + 130_000,
                    updatedAt: 300,
                }),
                other: makeSessionRow('other', { active: true, presence: 'online', updatedAt: 100 }),
            },
        };
        await hook.rerender();
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'active' }),
            expect.objectContaining({ type: 'session', sessionId: 'stale-working', groupKind: 'active' }),
            expect.objectContaining({ type: 'session', sessionId: 'other', groupKind: 'active' }),
        ]);
    });

    it('uses a retained visible-index seed after the pane-state hook remounts', async () => {
        const now = 1_000_000;
        vi.useFakeTimers();
        vi.setSystemTime(now);
        viewState.orderingMode = 'custom';
        viewState.workingPlacementMode = 'global';
        viewState.pathname = '/session/other';
        viewState.source = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1', groupKey: 'server:s1:active' },
            { type: 'session', sessionId: 'stale-working', serverId: 's1', section: 'active', groupKey: 'server:s1:active', groupKind: 'active' },
            { type: 'session', sessionId: 'other', serverId: 's1', section: 'active', groupKey: 'server:s1:active', groupKind: 'active' },
        ];
        viewState.rowsByServerId = {
            s1: {
                'stale-working': makeSessionRow('stale-working', {
                    active: true,
                    activeAt: now - 1_000,
                    presence: 'online',
                    thinking: true,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    updatedAt: 200,
                }),
                other: makeSessionRow('other', { active: true, presence: 'online', updatedAt: 100 }),
            },
        };

        const firstHook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        const retainedVisibleSessionListIndex = firstHook.getCurrent()?.visibleSessionListIndex;
        expect(retainedVisibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'working' }),
            expect.objectContaining({ type: 'session', sessionId: 'stale-working', groupKind: 'working' }),
            expect.objectContaining({ type: 'header', headerKind: 'active' }),
            expect.objectContaining({ type: 'session', sessionId: 'other', groupKind: 'active' }),
        ]);
        await firstHook.unmount();

        vi.setSystemTime(now + 130_000);
        const remountOptions: Parameters<typeof useVisibleSessionListViewState>[1] & Readonly<{
            retainedVisibleSessionListIndex: typeof retainedVisibleSessionListIndex;
        }> = {
            retainedVisibleSessionListIndex,
        };
        const remountedHook = await renderHook(() => useVisibleSessionListViewState('all', remountOptions));
        await flushHookEffects();

        expect(remountedHook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'working' }),
            expect.objectContaining({ type: 'session', sessionId: 'stale-working', groupKind: 'working' }),
            expect.objectContaining({ type: 'header', headerKind: 'active' }),
            expect.objectContaining({ type: 'session', sessionId: 'other', groupKind: 'active' }),
        ]);
    });

    it('reuses an unchanged retained visible projection after the pane-state hook remounts', async () => {
        viewState.source = makeSourceIndex();
        viewState.rowsByServerId = {
            s1: {
                a: makeSessionRow('a', { createdAt: 20, updatedAt: 200 }),
                b: makeSessionRow('b', { createdAt: 10, updatedAt: 100 }),
            },
        };

        const firstHook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();
        const retainedVisibleSessionListIndex = firstHook.getCurrent()?.visibleSessionListIndex;
        expect(retainedVisibleSessionListIndex).not.toBeNull();
        const computeCountBeforeRemount = viewState.visibleIndexComputeCount;
        await firstHook.unmount();

        viewState.source = viewState.source?.map((item) => ({ ...item })) ?? null;
        viewState.rowsByServerId = Object.fromEntries(
            Object.entries(viewState.rowsByServerId).map(([serverId, rows]) => [serverId, { ...rows }]),
        );
        const remountedHook = await renderHook(() => useVisibleSessionListViewState('all', {
            retainedVisibleSessionListIndex,
        }));
        await flushHookEffects();

        expect(remountedHook.getCurrent()?.visibleSessionListIndex).toBe(retainedVisibleSessionListIndex);
        expect(viewState.visibleIndexComputeCount).toBe(computeCountBeforeRemount);
    });

    it('demotes pending-permission attention rows after the permission closes', async () => {
        viewState.attentionPromotionMode = 'global';
        viewState.source = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1', groupKey: 'server:s1:active' },
            { type: 'session', sessionId: 'normal', serverId: 's1', section: 'active', groupKey: 'server:s1:active', groupKind: 'active' },
            { type: 'session', sessionId: 'approval-session', serverId: 's1', section: 'active', groupKey: 'server:s1:active', groupKind: 'active' },
        ];
        viewState.rowsByServerId = {
            s1: {
                normal: makeSessionRow('normal', { active: true, presence: 'online', updatedAt: 100 }),
                'approval-session': makeSessionRow('approval-session', {
                    active: true,
                    activeAt: Date.now(),
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: Date.now(),
                    hasPendingPermissionRequests: true,
                    pendingRequestObservedAt: Date.now(),
                    updatedAt: 200,
                }),
            },
        };

        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();
        expect(hook.getCurrent()?.visibleSessionListIndex?.[1]).toEqual(expect.objectContaining({
            type: 'session',
            sessionId: 'approval-session',
            groupKind: 'attention',
        }));

        viewState.rowsByServerId = {
            ...viewState.rowsByServerId,
            s1: {
                ...viewState.rowsByServerId.s1,
                'approval-session': {
                    ...viewState.rowsByServerId.s1['approval-session'],
                    hasPendingPermissionRequests: false,
                },
            },
        };
        await hook.rerender();
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'active' }),
            expect.objectContaining({ type: 'session', sessionId: 'approval-session', groupKind: 'active' }),
            expect.objectContaining({ type: 'session', sessionId: 'normal', groupKind: 'active' }),
        ]);
    });

    it('does not replay a resolved permission reason onto the retained open session', async () => {
        // The row the user is READING is retained in the band so it cannot slide away
        // mid-read. Retention must not also resurrect the reason that placed it: once
        // the user approves the permission, `attentionPlacementReason` is what the row
        // renders its "permission required" affordance from, so replaying it paints an
        // approved session as still blocked.
        viewState.orderingMode = 'custom';
        viewState.attentionPromotionMode = 'global';
        viewState.pathname = '/session/approval-session';
        viewState.selection = {
            enabled: false,
            presentation: 'grouped',
            activeServerId: 's1',
            allowedServerIds: ['s1'],
            explicit: false,
            activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
        };
        viewState.source = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1', groupKey: 'server:s1:active' },
            { type: 'session', sessionId: 'approval-session', serverId: 's1', section: 'active', groupKey: 'server:s1:active', groupKind: 'active' },
        ];
        viewState.rowsByServerId = {
            s1: {
                'approval-session': makeSessionRow('approval-session', {
                    active: true,
                    presence: 'online',
                    seq: 3,
                    lastViewedSessionSeq: 3,
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 200,
                    lastTurnCompletedAt: 200,
                    hasPendingPermissionRequests: true,
                    pendingRequestObservedAt: Date.now(),
                    updatedAt: 200,
                }),
            },
        };

        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex?.[1]).toEqual(expect.objectContaining({
            type: 'session',
            sessionId: 'approval-session',
            groupKind: 'attention',
            attentionPlacementReason: 'permission_required',
        }));

        // The user approves the permission while still on the session.
        viewState.rowsByServerId = {
            s1: {
                'approval-session': {
                    ...viewState.rowsByServerId.s1['approval-session'],
                    hasPendingPermissionRequests: false,
                },
            },
        };
        await hook.rerender();
        await flushHookEffects();

        const retainedRow = hook.getCurrent()?.visibleSessionListIndex?.[1];
        expect(retainedRow).toEqual(expect.objectContaining({
            type: 'session',
            sessionId: 'approval-session',
            groupKind: 'attention',
        }));
        expect(retainedRow).not.toEqual(expect.objectContaining({
            attentionPlacementReason: 'permission_required',
        }));
    });

    it('does not promote a quiet selected session through retention', async () => {
        viewState.orderingMode = 'custom';
        viewState.attentionPromotionMode = 'global';
        viewState.pathname = '/session/quiet';
        viewState.selection = {
            enabled: false,
            presentation: 'grouped',
            activeServerId: 's1',
            allowedServerIds: ['s1'],
            explicit: false,
            activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
        };
        viewState.source = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: 'server:s1:day:2026-02-17' },
            { type: 'session', sessionId: 'done', serverId: 's1', section: 'inactive', groupKey: 'server:s1:day:2026-02-17', groupKind: 'date' },
            { type: 'session', sessionId: 'quiet', serverId: 's1', section: 'inactive', groupKey: 'server:s1:day:2026-02-17', groupKind: 'date' },
        ];
        viewState.rowsByServerId = {
            s1: {
                done: makeSessionRow('done', {
                    seq: 3,
                    latestTurnStatus: 'completed',
                    lastTurnCompletedAt: 300,
                    lastViewedSessionSeq: 2,
                    updatedAt: 300,
                }),
                quiet: makeSessionRow('quiet', { seq: 1, updatedAt: 100 }),
            },
        };

        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'attention' }),
            expect.objectContaining({ type: 'session', sessionId: 'done', groupKind: 'attention' }),
            expect.objectContaining({ type: 'header', headerKind: 'date' }),
            expect.objectContaining({ type: 'session', sessionId: 'quiet', groupKind: 'date' }),
        ]);
    });

    it.each(['global', 'withinGroups'] as const)('keeps an opened reminder in its %s position across repeated projections until leaving', async (mode) => {
        viewState.orderingMode = 'custom';
        viewState.attentionPromotionMode = mode;
        viewState.selection = { enabled: false, presentation: 'grouped', activeServerId: 's1', allowedServerIds: ['s1'], explicit: false, activeTarget: { kind: 'server', id: 's1', serverId: 's1' } };
        viewState.source = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: 'day' },
            ...['kept', 'reminded', 'unread', 'quiet'].map((sessionId) => ({
                type: 'session' as const, sessionId, serverId: 's1', section: 'inactive' as const, groupKey: 'day', groupKind: 'date' as const,
            })),
        ];
        viewState.rowsByServerId = { s1: Object.fromEntries(['kept', 'reminded', 'unread', 'quiet'].map((id) => [id, makeSessionRow(id, {
            seq: id === 'unread' ? 5 : 4, lastViewedSessionSeq: 4, hasUnreadMessages: id === 'unread',
        })])) };
        setSessionOrganizationProjection({});
        viewState.sessionOrganizationProjection = { ...viewState.sessionOrganizationProjection, attentionStandingsBySessionId: {
            kept: { sessionId: 'kept', standing: true, updatedAt: 1 },
            reminded: { sessionId: 'reminded', standing: false, remindAt: 1, updatedAt: 1 },
        } };
        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        const positions = () => hook.getCurrent()?.visibleSessionListIndex?.filter((item) => item.type === 'session')
            .map((item) => `${item.sessionId}:${item.attentionPlacementReason ? 'attention' : 'normal'}`);
        const before = positions();
        expect(before).toEqual(['unread:attention', 'kept:attention', 'reminded:attention', 'quiet:normal']);
        viewState.focusedSessionId = 'reminded';
        viewState.pathname = '/session/reminded';
        viewState.sessionOrganizationProjection = { ...viewState.sessionOrganizationProjection, attentionStandingsBySessionId: {
            kept: { sessionId: 'kept', standing: true, updatedAt: 1 },
        } };
        await hook.rerender();
        expect(positions()).toEqual(before);
        await hook.rerender();
        expect(positions()).toEqual(before);
        viewState.focusedSessionId = null;
        viewState.pathname = '/session/none';
        await hook.rerender();
        expect(positions()).not.toEqual(before);
        expect(positions()).toContain('reminded:normal');
        await hook.unmount();
    });

    it('retains the selected attention session after acknowledgement catches up', async () => {
        viewState.orderingMode = 'custom';
        viewState.attentionPromotionMode = 'global';
        viewState.pathname = '/session/done';
        viewState.selection = {
            enabled: false,
            presentation: 'grouped',
            activeServerId: 's1',
            allowedServerIds: ['s1'],
            explicit: false,
            activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
        };
        viewState.source = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: 'server:s1:day:2026-02-17' },
            { type: 'session', sessionId: 'done', serverId: 's1', section: 'inactive', groupKey: 'server:s1:day:2026-02-17', groupKind: 'date' },
            { type: 'session', sessionId: 'quiet', serverId: 's1', section: 'inactive', groupKey: 'server:s1:day:2026-02-17', groupKind: 'date' },
        ];
        viewState.rowsByServerId = {
            s1: {
                done: makeSessionRow('done', {
                    seq: 3,
                    latestTurnStatus: 'completed',
                    lastTurnCompletedAt: 300,
                    lastViewedSessionSeq: 2,
                    updatedAt: 300,
                }),
                quiet: makeSessionRow('quiet', { seq: 1, updatedAt: 100 }),
            },
        };

        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'attention' }),
            expect.objectContaining({ type: 'session', sessionId: 'done', groupKind: 'attention' }),
            expect.objectContaining({ type: 'header', headerKind: 'date' }),
            expect.objectContaining({ type: 'session', sessionId: 'quiet', groupKind: 'date' }),
        ]);

        viewState.rowsByServerId = {
            s1: {
                done: makeSessionRow('done', {
                    seq: 3,
                    latestTurnStatus: 'completed',
                    lastTurnCompletedAt: 300,
                    lastViewedSessionSeq: 3,
                    updatedAt: 300,
                }),
                quiet: makeSessionRow('quiet', { seq: 1, updatedAt: 100 }),
            },
        };
        await hook.rerender();
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'attention' }),
            expect.objectContaining({ type: 'session', sessionId: 'done', groupKind: 'attention' }),
            expect.objectContaining({ type: 'header', headerKind: 'date' }),
            expect.objectContaining({ type: 'session', sessionId: 'quiet', groupKind: 'date' }),
        ]);
    });

    it('uses a retained foreground pathname when retaining selected attention after remount', async () => {
        viewState.orderingMode = 'custom';
        viewState.attentionPromotionMode = 'global';
        viewState.pathname = '/session/done';
        viewState.selection = {
            enabled: false,
            presentation: 'grouped',
            activeServerId: 's1',
            allowedServerIds: ['s1'],
            explicit: false,
            activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
        };
        viewState.source = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: 'server:s1:day:2026-02-17' },
            { type: 'session', sessionId: 'done', serverId: 's1', section: 'inactive', groupKey: 'server:s1:day:2026-02-17', groupKind: 'date' },
            { type: 'session', sessionId: 'quiet', serverId: 's1', section: 'inactive', groupKey: 'server:s1:day:2026-02-17', groupKind: 'date' },
        ];
        viewState.rowsByServerId = {
            s1: {
                done: makeSessionRow('done', {
                    seq: 3,
                    latestTurnStatus: 'completed',
                    lastTurnCompletedAt: 300,
                    lastViewedSessionSeq: 2,
                    updatedAt: 300,
                }),
                quiet: makeSessionRow('quiet', { seq: 1, updatedAt: 100 }),
            },
        };

        const firstHook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();
        const retainedVisibleSessionListIndex = firstHook.getCurrent()?.visibleSessionListIndex;
        expect(retainedVisibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'attention' }),
            expect.objectContaining({ type: 'session', sessionId: 'done', groupKind: 'attention' }),
            expect.objectContaining({ type: 'header', headerKind: 'date' }),
            expect.objectContaining({ type: 'session', sessionId: 'quiet', groupKind: 'date' }),
        ]);
        await firstHook.unmount();

        viewState.rowsByServerId = {
            s1: {
                done: makeSessionRow('done', {
                    seq: 3,
                    latestTurnStatus: 'completed',
                    lastTurnCompletedAt: 300,
                    lastViewedSessionSeq: 3,
                    updatedAt: 300,
                }),
                quiet: makeSessionRow('quiet', { seq: 1, updatedAt: 100 }),
            },
        };
        viewState.pathname = '/';
        let remountOptions: Parameters<typeof useVisibleSessionListViewState>[1] & Readonly<{
            retainedPathname: string;
            retainedVisibleSessionListIndex: typeof retainedVisibleSessionListIndex;
        }> = {
            pathname: '/',
            retainedPathname: '/session/done',
            retainedVisibleSessionListIndex,
        };
        const remountedHook = await renderHook(() => useVisibleSessionListViewState('all', remountOptions));
        await flushHookEffects();

        expect(remountedHook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'attention' }),
            expect.objectContaining({ type: 'session', sessionId: 'done', groupKind: 'attention' }),
            expect.objectContaining({ type: 'header', headerKind: 'date' }),
            expect.objectContaining({ type: 'session', sessionId: 'quiet', groupKind: 'date' }),
        ]);
        await remountedHook.rerender();
        expect(remountedHook.getCurrent()?.visibleSessionListIndex?.some((item) => item.type === 'session' && item.sessionId === 'done' && item.groupKind === 'attention')).toBe(true);
        remountOptions = { ...remountOptions, retainedPathname: '/' };
        await remountedHook.rerender();
        expect(remountedHook.getCurrent()?.visibleSessionListIndex?.some((item) => item.type === 'session' && item.sessionId === 'done' && item.groupKind === 'attention')).toBe(false);
        await remountedHook.unmount();
    });

    it('uses an explicit pathname override for retained root session-list state', async () => {
        viewState.orderingMode = 'custom';
        viewState.attentionPromotionMode = 'global';
        viewState.pathname = '/session/done';
        viewState.selection = {
            enabled: false,
            presentation: 'grouped',
            activeServerId: 's1',
            allowedServerIds: ['s1'],
            explicit: false,
            activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
        };
        viewState.source = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: 'server:s1:day:2026-02-17' },
            { type: 'session', sessionId: 'done', serverId: 's1', section: 'inactive', groupKey: 'server:s1:day:2026-02-17', groupKind: 'date' },
            { type: 'session', sessionId: 'quiet', serverId: 's1', section: 'inactive', groupKey: 'server:s1:day:2026-02-17', groupKind: 'date' },
        ];
        viewState.rowsByServerId = {
            s1: {
                done: makeSessionRow('done', {
                    seq: 3,
                    latestTurnStatus: 'completed',
                    lastTurnCompletedAt: 300,
                    lastViewedSessionSeq: 2,
                    updatedAt: 300,
                }),
                quiet: makeSessionRow('quiet', { seq: 1, updatedAt: 100 }),
            },
        };

        const hook = await renderHook(() => useVisibleSessionListViewState('all', { pathname: '/' }));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'attention' }),
            expect.objectContaining({ type: 'session', sessionId: 'done', groupKind: 'attention' }),
            expect.objectContaining({ type: 'header', headerKind: 'date' }),
            expect.objectContaining({ type: 'session', sessionId: 'quiet', groupKind: 'date' }),
        ]);

        viewState.rowsByServerId = {
            s1: {
                done: makeSessionRow('done', {
                    seq: 3,
                    latestTurnStatus: 'completed',
                    lastTurnCompletedAt: 300,
                    lastViewedSessionSeq: 3,
                    updatedAt: 300,
                }),
                quiet: makeSessionRow('quiet', { seq: 1, updatedAt: 100 }),
            },
        };
        await hook.rerender();
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'date' }),
            expect.objectContaining({ type: 'session', sessionId: 'done', groupKind: 'date' }),
            expect.objectContaining({ type: 'session', sessionId: 'quiet', groupKind: 'date' }),
        ]);
    });

    it('builds a folder tree from durable workspace refs and scopes focused folders', async () => {
        viewState.sessionFolderViewMode = 'tree';
        viewState.source = [
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:s1:active:project:hash-a',
                workspaceKey: 'wl_hash_a',
                serverId: 's1',
                workspaceScopeHint: {
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
            },
            {
                type: 'session',
                sessionId: 'in-folder',
                serverId: 's1',
                section: 'active',
                groupKey: 'server:s1:active:project:hash-a',
                groupKind: 'project',
            },
            {
                type: 'session',
                sessionId: 'at-root',
                serverId: 's1',
                section: 'active',
                groupKey: 'server:s1:active:project:hash-a',
                groupKind: 'project',
            },
        ];
        viewState.rowsByServerId = {
            s1: {
                'in-folder': makeSessionRow('in-folder', { active: true, createdAt: 10 }),
                'at-root': makeSessionRow('at-root', { active: true, createdAt: 9 }),
            },
        };
        viewState.sessionFolders = {
            v: 1,
            folders: [{
                id: 'folder-a',
                workspace: {
                    t: 'workspaceScope',
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
                renderWorkspaceKey: 'wl_old_hash',
                parentId: null,
                name: 'Planning',
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        viewState.sessionFolderAssignmentsBySessionKey = {
            's1:in-folder': 'folder-a',
        };
        setSessionOrganizationProjection({
            folders: [{
                id: 'folder-a',
                workspace: {
                    t: 'workspaceScope',
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
                parentId: null,
                name: 'Planning',
            }],
            folderAssignmentsBySessionId: {
                'in-folder': 'folder-a',
            },
        });

        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'project' }),
            expect.objectContaining({ type: 'header', headerKind: 'folder', folderId: 'folder-a', folderDepth: 0 }),
            expect.objectContaining({ type: 'session', sessionId: 'in-folder', folderId: 'folder-a' }),
            expect.objectContaining({ type: 'session', sessionId: 'at-root', folderId: null }),
        ]);

        viewState.focusedSessionFolder = {
            serverId: 's1',
            workspace: {
                t: 'workspaceScope',
                serverId: 's1',
                machineId: 'm1',
                rootPath: '/repo',
            },
            folderId: 'folder-a',
        };
        const focusedHook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        const focusedSessions = (focusedHook.getCurrent()?.visibleSessionListIndex ?? [])
            .filter((item) => item.type === 'session')
            .map((item) => (item as Extract<SessionListIndexItem, { type: 'session' }>).sessionId);
        expect(focusedSessions).toEqual(['in-folder']);
        expect(focusedHook.getCurrent()?.folderFocus?.breadcrumbs.map((crumb: any) => crumb.name)).toEqual(['Planning']);
    });

    it('keeps empty folder rows visible after workspace root sessions', async () => {
        viewState.sessionFolderViewMode = 'tree';
        viewState.source = [
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:s1:active:project:hash-a',
                workspaceKey: 'wl_hash_a',
                serverId: 's1',
                workspaceScopeHint: {
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
            },
            {
                type: 'session',
                sessionId: 'at-root',
                serverId: 's1',
                section: 'active',
                groupKey: 'server:s1:active:project:hash-a',
                groupKind: 'project',
            },
        ];
        viewState.rowsByServerId = {
            s1: {
                'at-root': makeSessionRow('at-root', { active: true, createdAt: 9 }),
            },
        };
        viewState.sessionFolders = {
            v: 1,
            folders: [{
                id: 'folder-a',
                workspace: {
                    t: 'workspaceScope',
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
                parentId: null,
                name: 'Planning',
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        viewState.sessionFolderAssignmentsBySessionKey = {};
        setSessionOrganizationProjection({
            folders: [{
                id: 'folder-a',
                workspace: {
                    t: 'workspaceScope',
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
                parentId: null,
                name: 'Planning',
            }],
        });

        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'project' }),
            expect.objectContaining({ type: 'header', headerKind: 'folder', folderId: 'folder-a' }),
            expect.objectContaining({ type: 'session', sessionId: 'at-root', folderId: null }),
        ]);
    });

    it('leaves folder metadata inactive only when the folder feature is disabled', async () => {
        viewState.sessionFolderViewMode = 'tree';
        viewState.sessionFoldersFeatureEnabled = false;
        viewState.source = [
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:s1:active:project:hash-a',
                workspaceKey: 'wl_hash_a',
                serverId: 's1',
                workspaceScopeHint: {
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
            },
            {
                type: 'session',
                sessionId: 'in-folder',
                serverId: 's1',
                section: 'active',
                groupKey: 'server:s1:active:project:hash-a',
                groupKind: 'project',
                storageKind: 'direct',
            },
        ];
        viewState.rowsByServerId = {
            s1: {
                'in-folder': makeSessionRow('in-folder', { active: true, createdAt: 10 }),
            },
        };
        viewState.sessionFolders = {
            v: 1,
            folders: [{
                id: 'folder-a',
                workspace: {
                    t: 'workspaceScope',
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
                parentId: null,
                name: 'Planning',
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        viewState.sessionFolderAssignmentsBySessionKey = {
            's1:in-folder': 'folder-a',
        };
        setSessionOrganizationProjection({
            folders: [{
                id: 'folder-a',
                workspace: {
                    t: 'workspaceScope',
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
                parentId: null,
                name: 'Planning',
            }],
            folderAssignmentsBySessionId: {
                'in-folder': 'folder-a',
            },
        });

        const disabledHook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(disabledHook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'project' }),
            expect.objectContaining({ type: 'session', sessionId: 'in-folder', groupKind: 'project' }),
        ]);
        expect(disabledHook.getCurrent()?.folderFocus).toBeNull();

        viewState.sessionFoldersFeatureEnabled = true;
        const directHook = await renderHook(() => useVisibleSessionListViewState('direct'));
        await flushHookEffects();

        expect(directHook.getCurrent()?.visibleSessionListIndex).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'header', headerKind: 'folder', folderId: 'folder-a' }),
            expect.objectContaining({ type: 'session', sessionId: 'in-folder', folderId: 'folder-a' }),
        ]));

        viewState.focusedSessionFolder = {
            serverId: 's1',
            workspace: {
                t: 'workspaceScope',
                serverId: 's1',
                machineId: 'm1',
                rootPath: '/repo',
            },
            folderId: 'folder-a',
        };
        const focusedDirectHook = await renderHook(() => useVisibleSessionListViewState('direct'));
        await flushHookEffects();

        expect(focusedDirectHook.getCurrent()?.folderFocus?.folder.id).toBe('folder-a');
        expect((focusedDirectHook.getCurrent()?.visibleSessionListIndex ?? [])
            .filter((item) => item.type === 'session')
            .map((item) => item.sessionId)).toEqual(['in-folder']);

        viewState.activeGrouping = 'date';
        const recentHook = await renderHook(() => useVisibleSessionListViewState('direct'));
        await flushHookEffects();

        expect(recentHook.getCurrent()?.folderFocus?.folder.id).toBe('folder-a');
        expect((recentHook.getCurrent()?.visibleSessionListIndex ?? []).some((item) => (
            item.type === 'header' && (item.headerKind === 'folder' || item.headerKind === 'project')
        ))).toBe(false);
        expect((recentHook.getCurrent()?.visibleSessionListIndex ?? [])
            .filter((item) => item.type === 'session')
            .map((item) => item.sessionId)).toEqual(['in-folder']);
    });

    it('keeps direct sessions visible when legacy index items omit storageKind but row state has direct metadata', async () => {
        viewState.source = [
            { type: 'header', title: 'dev', headerKind: 'project', groupKey: 'server:s1:project:dev', serverId: 's1' },
            { type: 'session', sessionId: 'direct-session', serverId: 's1', section: 'active', groupKey: 'server:s1:project:dev', groupKind: 'project' },
            { type: 'session', sessionId: 'persisted-session', serverId: 's1', section: 'active', groupKey: 'server:s1:project:dev', groupKind: 'project' },
        ];
        viewState.rowsByServerId = {
            s1: {
                'direct-session': makeSessionRow('direct-session', {
                    active: true,
                    metadata: {
                        path: '/repo',
                        externalSessionV1: {
                            v: 1,
                            agentId: 'opencode',
                            machineId: 'machine-1',
                            remoteSessionId: 'remote-1',
                            source: {
                                kind: 'opencodeServer',
                                baseUrl: 'http://127.0.0.1:4096',
                                directory: '/repo',
                            },
                        },
                    },
                }),
                'persisted-session': makeSessionRow('persisted-session', {
                    active: true,
                    metadata: { path: '/repo' },
                }),
            },
        };

        const hook = await renderHook(() => useVisibleSessionListViewState('direct'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'project' }),
            expect.objectContaining({ type: 'session', sessionId: 'direct-session' }),
        ]);
    });

    it('recomputes working placement from the shared runtime clock when freshness expires without a store update', async () => {
        const now = 1_000_000;
        vi.useFakeTimers();
        vi.setSystemTime(now);
        viewState.orderingMode = 'custom';
        viewState.workingPlacementMode = 'global';
        viewState.source = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1', groupKey: 'server:s1:active' },
            { type: 'session', sessionId: 'thinking-only', serverId: 's1', section: 'active', groupKey: 'server:s1:active', groupKind: 'active' },
        ];
        // Legacy-thinking working signal only: not a working-retention
        // candidate (latestTurnStatus is not in_progress), so once the
        // freshness window expires the session must LEAVE the working group —
        // driven purely by the shared clock wake, with no store update.
        viewState.rowsByServerId = {
            s1: {
                'thinking-only': makeSessionRow('thinking-only', {
                    active: true,
                    activeAt: now - 1_000,
                    presence: 'online',
                    thinking: true,
                    thinkingAt: now - 1_000,
                    updatedAt: 200,
                }),
            },
        };

        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'working' }),
            expect.objectContaining({ type: 'session', sessionId: 'thinking-only', groupKind: 'working' }),
        ]);

        await flushHookEffects({ advanceTimersMs: 121_000, cycles: 1, turns: 2 });

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'active' }),
            expect.objectContaining({ type: 'session', sessionId: 'thinking-only', groupKind: 'active' }),
        ]);
    });
});
