import { afterEach, describe, expect, it, vi } from 'vitest';

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
    openApprovalSessionIds: [] as ReadonlyArray<string>,
    pathname: '/session/none',
    focusedSessionId: null as string | null,
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

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSessionListRowStateByServerId: () => viewState.rowsByServerId,
            useArtifacts: () => {
                throw new Error('session list view state must use open approval session ids instead of full artifacts');
            },
            useOpenApprovalSessionIds: () => viewState.openApprovalSessionIds,
            useSetting: ((key: string) => {
                if (key === 'hideInactiveSessions') return viewState.hideInactiveSessions;
                if (key === 'pinnedSessionKeysV1') return [];
                if (key === 'sessionListOrderingModeV1') {
                    viewState.observedOrderingMode.push(viewState.orderingMode);
                    return viewState.orderingMode;
                }
                if (key === 'sessionListAttentionPromotionModeV1') return viewState.attentionPromotionMode;
                if (key === 'sessionListWorkingPlacementModeV1') return viewState.workingPlacementMode;
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
        },
    });
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'sessions.folders'
        ? viewState.sessionFoldersFeatureEnabled
        : true,
}));

vi.mock('expo-router', () => ({
    usePathname: () => viewState.pathname,
}));

vi.mock('@/sync/domains/session/sessionSurfaceVisibility', () => ({
    useFocusedSessionId: () => viewState.focusedSessionId,
}));

vi.mock('./useVisibleSessionListSourceState', () => ({
    useVisibleSessionListSourceState: () => ({
        selection: viewState.selection,
        activeIndex: viewState.source,
        byServerId: {},
        source: viewState.source,
    }),
}));

describe('useVisibleSessionListViewState (index pipeline)', () => {
    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
        viewState.orderingMode = 'updated';
        viewState.attentionPromotionMode = 'off';
        viewState.workingPlacementMode = 'off';
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
        viewState.openApprovalSessionIds = [];
        viewState.pathname = '/session/none';
        viewState.focusedSessionId = null;
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

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        const sessionIds = (hook.getCurrent()?.visibleSessionListIndex ?? [])
            .filter((item) => item.type === 'session')
            .map((item) => (item as Extract<SessionListIndexItem, { type: 'session' }>).sessionId);

        expect(sessionIds).toEqual(['a', 'b']);
        expect(viewState.observedOrderingMode).toEqual(['updated']);
        expect(viewState.setGroupOrder).not.toHaveBeenCalled();
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

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
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

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
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

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([]);
        expect(hook.getCurrent()?.hasHiddenInactiveSessions).toBe(true);
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

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'attention' }),
            expect.objectContaining({ type: 'session', sessionId: 'done', groupKind: 'attention' }),
            expect.objectContaining({ type: 'header', headerKind: 'date' }),
            expect.objectContaining({ type: 'session', sessionId: 'quiet', groupKind: 'date' }),
        ]);
    });

    it('promotes open approval artifacts through the index row-state resolver', async () => {
        viewState.attentionPromotionMode = 'global';
        viewState.openApprovalSessionIds = ['approval-session'];
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
                    updatedAt: 200,
                }),
            },
        };

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
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

    it('promotes only the matching server-scoped row when approval session ids collide across servers', async () => {
        viewState.attentionPromotionMode = 'global';
        viewState.openApprovalSessionIds = ['s2:approval-session'];
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
                    updatedAt: 200,
                }),
            },
        };

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
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

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
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

    it('demotes approval artifact attention rows after the approval closes', async () => {
        viewState.attentionPromotionMode = 'global';
        viewState.openApprovalSessionIds = ['approval-session'];
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
                    updatedAt: 200,
                }),
            },
        };

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();
        expect(hook.getCurrent()?.visibleSessionListIndex?.[1]).toEqual(expect.objectContaining({
            type: 'session',
            sessionId: 'approval-session',
            groupKind: 'attention',
        }));

        viewState.openApprovalSessionIds = [];
        await hook.rerender();
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'active' }),
            expect.objectContaining({ type: 'session', sessionId: 'approval-session', groupKind: 'active' }),
            expect.objectContaining({ type: 'session', sessionId: 'normal', groupKind: 'active' }),
        ]);
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

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'attention' }),
            expect.objectContaining({ type: 'session', sessionId: 'done', groupKind: 'attention' }),
            expect.objectContaining({ type: 'header', headerKind: 'date' }),
            expect.objectContaining({ type: 'session', sessionId: 'quiet', groupKind: 'date' }),
        ]);
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

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
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

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
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

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
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

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'project' }),
            expect.objectContaining({ type: 'header', headerKind: 'folder', folderId: 'folder-a' }),
            expect.objectContaining({ type: 'session', sessionId: 'at-root', folderId: null }),
        ]);
    });

    it('leaves folder metadata inactive when the feature is disabled or Direct mode is selected', async () => {
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

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
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

        expect(directHook.getCurrent()?.visibleSessionListIndex).toEqual([]);
        expect(directHook.getCurrent()?.folderFocus).toBeNull();
    });
});
