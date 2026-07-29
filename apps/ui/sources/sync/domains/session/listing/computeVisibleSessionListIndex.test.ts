import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import type { SessionListRenderableSession } from './sessionListRenderable';
import { computeVisibleSessionListIndex } from './computeVisibleSessionListIndex';

type OrderingMode = 'custom' | 'created' | 'updated';
type FolderSortMode = 'foldersFirst' | 'mixed';

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

function makeResolver(rowsByKey: Record<string, SessionListRenderableSession>) {
    return (serverId: string | null | undefined, sessionId: string) => {
        const key = `${String(serverId ?? '').trim()}:${String(sessionId ?? '').trim()}`;
        return rowsByKey[key] ?? null;
    };
}

function describeItems(items: ReadonlyArray<SessionListIndexItem>): string[] {
    return items.map((item) => {
        if (item.type === 'header') {
            return item.headerKind === 'attention'
                ? 'h:attention'
                : item.headerKind === 'working'
                    ? 'h:working'
                : `h:${item.headerKind ?? 'unknown'}:${item.title}`;
        }
        return `s:${item.sessionId}:${item.groupKind ?? 'none'}:${item.groupKey ?? 'none'}`;
    });
}

describe('computeVisibleSessionListIndex', () => {
    afterEach(() => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('returns the original array when custom ordering inputs are no-ops', () => {
        const g = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 's1', groupKey: g },
            { type: 'session', sessionId: 'a', serverId: 's1', section: 'active', groupKey: g, groupKind: 'project' },
            { type: 'session', sessionId: 'b', serverId: 's1', section: 'active', groupKey: g, groupKind: 'project' },
        ];

        const resolveSessionRow = makeResolver({
            's1:a': makeSessionRow('a', { active: true, createdAt: 10, updatedAt: 20 }),
            's1:b': makeSessionRow('b', { active: true, createdAt: 20, updatedAt: 30 }),
        });

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [g]: [] },
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result).toBe(source);
    });

    it('records visible compute telemetry with index counts', () => {
        syncPerformanceTelemetry.configure({ enabled: true });
        const g = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 's1', groupKey: g },
            { type: 'session', sessionId: 'a', serverId: 's1', section: 'active', groupKey: g, groupKind: 'project' },
            { type: 'session', sessionId: 'b', serverId: 's1', section: 'active', groupKey: g, groupKind: 'project' },
        ];

        const resolveSessionRow = makeResolver({
            's1:a': makeSessionRow('a', { active: true, createdAt: 10, updatedAt: 20 }),
            's1:b': makeSessionRow('b', { active: true, createdAt: 20, updatedAt: 30 }),
        });

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        expect(result).toBe(source);
        expect(syncPerformanceTelemetry.snapshot().events).toEqual([
            expect.objectContaining({
                name: 'sync.sessions.list.visible.compute',
                count: 1,
                fields: expect.objectContaining({
                    items: 3,
                    sessions: 2,
                    headers: 1,
                    fastPath: 1,
                    hideInactive: 0,
                    pins: 0,
                    customOrder: 0,
                    presentationEnabled: 0,
                    storageFilter: 0,
                }),
            }),
        ]);
    });

    it('records missing pinned keys and visible placeholder rows in compute telemetry', () => {
        syncPerformanceTelemetry.configure({ enabled: true });
        const g = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 's1', groupKey: g },
            { type: 'session', sessionId: 'pinned-present', serverId: 's1', section: 'active', groupKey: g, groupKind: 'project' },
            { type: 'session', sessionId: 'visible-placeholder', serverId: 's1', section: 'active', groupKey: g, groupKind: 'project' },
        ];

        computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:pinned-present': makeSessionRow('pinned-present', {
                    active: true,
                    createdAt: 10,
                    updatedAt: 20,
                    metadata: { path: '/repo' },
                }),
                's1:visible-placeholder': makeSessionRow('visible-placeholder', {
                    active: true,
                    createdAt: 20,
                    updatedAt: 30,
                    metadata: null,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['s1:pinned-present', 's1:pinned-missing'],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        expect(syncPerformanceTelemetry.snapshot().events).toEqual([
            expect.objectContaining({
                name: 'sync.sessions.list.visible.compute',
                count: 1,
                fields: expect.objectContaining({
                    missingPinnedSessionKeys: 1,
                    visiblePlaceholderRows: 1,
                }),
            }),
        ]);
    });

    it('records visible placeholder rows when the projection returns the no-op source', () => {
        syncPerformanceTelemetry.configure({ enabled: true });
        const g = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 's1', groupKey: g },
            { type: 'session', sessionId: 'visible-placeholder', serverId: 's1', section: 'active', groupKey: g, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:visible-placeholder': makeSessionRow('visible-placeholder', {
                    active: true,
                    metadata: null,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        expect(result).toBe(source);
        expect(syncPerformanceTelemetry.snapshot().events).toEqual([
            expect.objectContaining({
                name: 'sync.sessions.list.visible.compute',
                count: 1,
                fields: expect.objectContaining({
                    missingPinnedSessionKeys: 0,
                    visiblePlaceholderRows: 1,
                }),
            }),
        ]);
    });

    it('keeps pinned sessions in their existing list order and normalizes pinned variants to default', () => {
        const g = 'server:s1:project:m1:/repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: g },
            { type: 'session', sessionId: 'a', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'project', variant: 'no-path' },
            { type: 'session', sessionId: 'b', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'project', variant: 'no-path' },
        ];

        const resolveSessionRow = makeResolver({
            's1:a': makeSessionRow('a'),
            's1:b': makeSessionRow('b'),
        });

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['s1:a', 's1:b'],
            sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result[0]).toMatchObject({ type: 'header', headerKind: 'pinned' });
        const pinnedSessions = result.filter((i) => i.type === 'session' && i.pinned === true) as Array<Extract<SessionListIndexItem, { type: 'session' }>>;
        expect(pinnedSessions.map((s) => s.sessionId)).toEqual(['a', 'b']);
        expect(pinnedSessions.map((s) => s.variant)).toEqual(['default', 'default']);
    });

    it('drops stale session index items when current row state is missing', () => {
        const g = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: g },
            { type: 'session', sessionId: 'stale', serverId: 's1', section: 'active', groupKey: g, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({}),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'updated' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result).toEqual([]);
    });

    it('promotes pinned attention sessions globally while preserving pinned state', () => {
        const now = Date.now();
        const activeGroup = 'server:s1:active:project:repo';
        const inactiveGroup = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: activeGroup },
            { type: 'session', sessionId: 'action', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
            { type: 'header', headerKind: 'inactive', title: 'Inactive', serverId: 's1' },
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: inactiveGroup },
            { type: 'session', sessionId: 'pinned-ready', serverId: 's1', section: 'inactive', groupKey: inactiveGroup, groupKind: 'date' },
            { type: 'session', sessionId: 'ready', serverId: 's1', section: 'inactive', groupKey: inactiveGroup, groupKind: 'date' },
            { type: 'session', sessionId: 'quiet', serverId: 's1', section: 'inactive', groupKey: inactiveGroup, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:action': makeSessionRow('action', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    hasPendingUserActionRequests: true,
                    updatedAt: 300,
                }),
                's1:working': makeSessionRow('working', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    updatedAt: 400,
                }),
                's1:ready': makeSessionRow('ready', {
                    seq: 10,
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 1_000,
                    meaningfulActivityAt: 1_044,
                    lastTurnCompletedAt: 200,
                    lastViewedSessionSeq: 9,
                    updatedAt: 200,
                }),
                's1:pinned-ready': makeSessionRow('pinned-ready', {
                    seq: 12,
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 1_000,
                    meaningfulActivityAt: 1_044,
                    lastTurnCompletedAt: 250,
                    lastViewedSessionSeq: 11,
                    updatedAt: 250,
                }),
                's1:quiet': makeSessionRow('quiet', { updatedAt: 100 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['s1:pinned-ready', 's1:quiet'],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(describeItems(result)).toEqual([
            'h:attention',
            's:action:attention:attention-promotion-v1',
            's:pinned-ready:attention:attention-promotion-v1',
            's:ready:attention:attention-promotion-v1',
            'h:pinned:Pinned',
            's:quiet:pinned:pinned-v1',
            'h:active:Active',
            'h:project:~/repo',
            's:working:project:server:s1:active:project:repo',
        ]);
        const pinnedReady = result.find((item): item is Extract<SessionListIndexItem, { type: 'session' }> => (
            item.type === 'session' && item.sessionId === 'pinned-ready'
        ));
        expect(pinnedReady).toMatchObject({
            type: 'session',
            groupKind: 'attention',
            groupKey: 'attention-promotion-v1',
            pinned: true,
        });
        expect(pinnedReady?.attentionPlacementReason).toBe('ready');
        expect(pinnedReady?.workingPlacementReason).toBeUndefined();
    });

    it('promotes pinned foreground and background working sessions globally while preserving pinned state', () => {
        const now = Date.now();
        const activeGroup = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: activeGroup },
            { type: 'session', sessionId: 'normal', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
            { type: 'session', sessionId: 'pinned-working', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
            { type: 'session', sessionId: 'pinned-normal', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:normal': makeSessionRow('normal', { active: true, presence: 'online', updatedAt: 10 }),
                's1:working': makeSessionRow('working', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    updatedAt: 30,
                }),
                's1:pinned-working': makeSessionRow('pinned-working', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: now - 5_000,
                    runtimeActivityState: 'active',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: now - 1_000,
                    runtimeActivityRevision: 1,
                    updatedAt: 20,
                }),
                's1:pinned-normal': makeSessionRow('pinned-normal', { active: true, presence: 'online', updatedAt: 5 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['s1:pinned-working', 's1:pinned-normal'],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: { mode: 'global' },
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & { workingPlacement: { mode: 'global' } })!;

        expect(describeItems(result)).toEqual([
            'h:working',
            's:working:working:working-placement-v1',
            's:pinned-working:working:working-placement-v1',
            'h:pinned:Pinned',
            's:pinned-normal:pinned:pinned-v1',
            'h:active:Active',
            'h:project:~/repo',
            's:normal:project:server:s1:active:project:repo',
        ]);
        const pinnedWorking = result.find((item): item is Extract<SessionListIndexItem, { type: 'session' }> => (
            item.type === 'session' && item.sessionId === 'pinned-working'
        ));
        expect(pinnedWorking).toMatchObject({
            type: 'session',
            groupKind: 'working',
            groupKey: 'working-placement-v1',
            pinned: true,
        });
        expect(pinnedWorking?.attentionPlacementReason).toBeUndefined();
        expect(pinnedWorking?.workingPlacementReason).toBe('working');
    });

    it('keeps working placement in source order when only updatedAt differs', () => {
        const now = Date.now();
        const activeGroup = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: activeGroup },
            { type: 'session', sessionId: 'first-working', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
            { type: 'session', sessionId: 'second-working', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:first-working': makeSessionRow('first-working', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    updatedAt: 10,
                }),
                's1:second-working': makeSessionRow('second-working', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    updatedAt: 100,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: { mode: 'global' },
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & { workingPlacement: { mode: 'global' } })!;

        expect(describeItems(result)).toEqual([
            'h:working',
            's:first-working:working:working-placement-v1',
            's:second-working:working:working-placement-v1',
        ]);
    });

    it('preserves the previous working row order across source order changes', () => {
        const now = Date.now();
        const activeGroup = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: activeGroup },
            { type: 'session', sessionId: 'second-retained', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
            { type: 'session', sessionId: 'first-retained', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:first-retained': makeSessionRow('first-retained', {
                    active: true,
                    activeAt: now - 130_000,
                    presence: 'online',
                    thinking: true,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 130_000,
                    updatedAt: 10,
                }),
                's1:second-retained': makeSessionRow('second-retained', {
                    active: true,
                    activeAt: now - 130_000,
                    presence: 'online',
                    thinking: true,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 130_000,
                    updatedAt: 20,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: {
                mode: 'global',
                retainSessionKeys: ['s1:first-retained', 's1:second-retained'],
            },
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
            workingPlacement: { mode: 'global'; retainSessionKeys: string[] };
        })!;

        expect(describeItems(result)).toEqual([
            'h:working',
            's:first-retained:working:working-placement-v1',
            's:second-retained:working:working-placement-v1',
        ]);
    });

    it('keeps old and recent canonical active-turn projections live', () => {
        const now = Date.now();
        const activeGroup = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: activeGroup },
            { type: 'session', sessionId: 'live-working', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
            { type: 'session', sessionId: 'retained-working', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:live-working': makeSessionRow('live-working', {
                    active: true,
                    activeAt: now - 1_000,
                    presence: 'online',
                    thinking: true,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    updatedAt: 10,
                }),
                's1:retained-working': makeSessionRow('retained-working', {
                    active: true,
                    activeAt: now - 130_000,
                    presence: 'online',
                    thinking: true,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 130_000,
                    updatedAt: 20,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: {
                mode: 'global',
                retainSessionKeys: ['s1:retained-working'],
            },
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
            workingPlacement: { mode: 'global'; retainSessionKeys: string[] };
        })!;

        const sessions = result.filter(
            (item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session',
        );
        expect(sessions.map((item) => `${item.sessionId}:${item.workingPlacementReason ?? 'none'}`)).toEqual([
            'live-working:working',
            'retained-working:working',
        ]);
    });

    it('keeps a projected active turn working until durable terminal state overrides it', () => {
        const now = Date.now();
        const activeGroup = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: activeGroup },
            { type: 'session', sessionId: 'stale-working', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
        ];

        const staleWorkingRow = makeSessionRow('stale-working', {
            active: true,
            activeAt: now - 130_000,
            presence: 'online',
            thinking: true,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now - 130_000,
            updatedAt: 30,
        });

        const retained = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:stale-working': staleWorkingRow,
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: { mode: 'global', retainSessionKeys: ['s1:stale-working'] },
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
            workingPlacement: { mode: 'global'; retainSessionKeys: string[] };
        })!;

        expect(describeItems(retained)).toEqual([
            'h:working',
            's:stale-working:working:working-placement-v1',
        ]);

        const completed = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:stale-working': makeSessionRow('stale-working', {
                    ...staleWorkingRow,
                    seq: 4,
                    active: false,
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: now - 1_000,
                    lastTurnCompletedAt: now - 1_000,
                    lastViewedSessionSeq: 3,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
            workingPlacement: { mode: 'global', retainSessionKeys: ['s1:stale-working'] },
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
            workingPlacement: { mode: 'global'; retainSessionKeys: string[] };
        })!;

        expect(describeItems(completed)).toEqual([
            'h:attention',
            's:stale-working:attention:attention-promotion-v1',
        ]);
    });

    it('does not treat a cleared legacy thinking flag as terminal for a projected active turn', () => {
        const now = Date.now();
        const activeGroup = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: activeGroup },
            { type: 'session', sessionId: 'stale-working', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:stale-working': makeSessionRow('stale-working', {
                    active: true,
                    activeAt: now - 1_000,
                    presence: 'online',
                    thinking: false,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 130_000,
                    updatedAt: 30,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: { mode: 'global', retainSessionKeys: ['s1:stale-working'] },
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
            workingPlacement: { mode: 'global'; retainSessionKeys: string[] };
        })!;

        expect(describeItems(result)).toEqual([
            'h:working',
            's:stale-working:working:working-placement-v1',
        ]);
    });

    it('does not expire a projected active turn at the list retention limit', () => {
        vi.useFakeTimers();
        const now = new Date(2026, 4, 19, 10, 0).getTime();
        vi.setSystemTime(now);
        try {
            const activeGroup = 'server:s1:active:project:repo';
            const source: SessionListIndexItem[] = [
                { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
                { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: activeGroup },
                { type: 'session', sessionId: 'stale-working', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
            ];

            const result = computeVisibleSessionListIndex({
                source,
                resolveSessionRow: makeResolver({
                    's1:stale-working': makeSessionRow('stale-working', {
                        active: true,
                        activeAt: now - (13 * 60 * 60 * 1000),
                        presence: 'online',
                        latestTurnStatus: 'in_progress',
                        latestTurnStatusObservedAt: now - (13 * 60 * 60 * 1000),
                        updatedAt: now - (13 * 60 * 60 * 1000),
                    }),
                }),
                hideInactiveSessions: false,
                pinnedSessionKeysV1: [],
                sessionListGroupOrderV1: {},
                sessionListOrderingModeV1: 'custom' as OrderingMode,
                presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
                workingPlacement: { mode: 'global', retainSessionKeys: ['s1:stale-working'] },
            } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
                workingPlacement: { mode: 'global'; retainSessionKeys: string[] };
            })!;

            expect(describeItems(result)).toEqual([
                'h:working',
                's:stale-working:working:working-placement-v1',
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps a projected active turn working across generic row updates', () => {
        vi.useFakeTimers();
        const now = new Date(2026, 4, 19, 10, 0).getTime();
        vi.setSystemTime(now);
        try {
            const staleAnchor = now - (13 * 60 * 60 * 1000);
            const activeGroup = 'server:s1:active:project:repo';
            const source: SessionListIndexItem[] = [
                { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
                { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: activeGroup },
                { type: 'session', sessionId: 'stale-working', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
            ];

            const result = computeVisibleSessionListIndex({
                source,
                resolveSessionRow: makeResolver({
                    's1:stale-working': makeSessionRow('stale-working', {
                        active: true,
                        activeAt: staleAnchor,
                        presence: 'online',
                        latestTurnStatus: 'in_progress',
                        latestTurnStatusObservedAt: staleAnchor,
                        thinkingAt: staleAnchor,
                        optimisticThinkingAt: staleAnchor,
                        updatedAt: now - 1_000,
                    }),
                }),
                hideInactiveSessions: false,
                pinnedSessionKeysV1: [],
                sessionListGroupOrderV1: {},
                sessionListOrderingModeV1: 'custom' as OrderingMode,
                presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
                workingPlacement: { mode: 'global', retainSessionKeys: ['s1:stale-working'] },
            } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
                workingPlacement: { mode: 'global'; retainSessionKeys: string[] };
            })!;

            expect(describeItems(result)).toEqual([
                'h:working',
                's:stale-working:working:working-placement-v1',
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('uses a stable caller timestamp for placement recomputes', () => {
        vi.useFakeTimers();
        const now = new Date(2026, 4, 19, 10, 0).getTime();
        vi.setSystemTime(now + 300_000);
        try {
            const activeGroup = 'server:s1:active:project:repo';
            const source: SessionListIndexItem[] = [
                { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
                { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: activeGroup },
                { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
            ];

            const result = computeVisibleSessionListIndex({
                source,
                resolveSessionRow: makeResolver({
                    's1:working': makeSessionRow('working', {
                        active: true,
                        activeAt: now - 1_000,
                        presence: 'online',
                        latestTurnStatus: 'in_progress',
                        latestTurnStatusObservedAt: now - 1_000,
                        updatedAt: now - 1_000,
                    }),
                }),
                hideInactiveSessions: false,
                pinnedSessionKeysV1: [],
                sessionListGroupOrderV1: {},
                sessionListOrderingModeV1: 'custom' as OrderingMode,
                presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
                workingPlacement: { mode: 'global' },
                nowMs: now,
            } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
                workingPlacement: { mode: 'global' };
                nowMs: number;
            })!;

            expect(describeItems(result)).toEqual([
                'h:working',
                's:working:working:working-placement-v1',
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('moves working sessions to the top of their current group in within-groups mode', () => {
        const now = Date.now();
        const activeGroup = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: activeGroup },
            { type: 'session', sessionId: 'normal', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:normal': makeSessionRow('normal', { active: true, presence: 'online', updatedAt: 10 }),
                's1:working': makeSessionRow('working', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    updatedAt: 30,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            workingPlacement: { mode: 'withinGroups' },
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & { workingPlacement: { mode: 'withinGroups' } })!;

        expect(describeItems(result)).toEqual([
            'h:active:Active',
            'h:project:~/repo',
            's:working:project:server:s1:active:project:repo',
            's:normal:project:server:s1:active:project:repo',
        ]);
    });

    it('clears stale working placement metadata when within-group attention overrides working', () => {
        const now = Date.now();
        const activeGroup = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: activeGroup },
            {
                type: 'session',
                sessionId: 'needs-permission',
                serverId: 's1',
                section: 'active',
                groupKey: activeGroup,
                groupKind: 'project',
                workingPlacementReason: 'working',
                keepVisibleWhenInactive: true,
            },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:needs-permission': makeSessionRow('needs-permission', {
                    active: true,
                    activeAt: now - 1_000,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 130_000,
                    hasPendingPermissionRequests: true,
                    pendingRequestObservedAt: now - 1_000,
                    updatedAt: 30,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'withinGroups' },
            workingPlacement: { mode: 'withinGroups', retainSessionKeys: ['s1:needs-permission'] },
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
            workingPlacement: { mode: 'withinGroups'; retainSessionKeys: string[] };
        })!;

        expect(result).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'active' }),
            expect.objectContaining({ type: 'header', headerKind: 'project' }),
            expect.objectContaining({
                type: 'session',
                sessionId: 'needs-permission',
                attentionPlacementReason: 'permission_required',
                workingPlacementReason: undefined,
            }),
        ]);
    });

    it('moves a completed unread session from working placement to attention placement', () => {
        const activeGroup = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: activeGroup },
            { type: 'session', sessionId: 'completed', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:completed': makeSessionRow('completed', {
                    seq: 5,
                    active: false,
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 1_000,
                    meaningfulActivityAt: 1_044,
                    lastTurnCompletedAt: 200,
                    lastViewedSessionSeq: 4,
                    updatedAt: 30,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
            workingPlacement: { mode: 'global' },
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & { workingPlacement: { mode: 'global' } })!;

        expect(describeItems(result)).toEqual([
            'h:attention',
            's:completed:attention:attention-promotion-v1',
        ]);
    });

    it('orders pending attention rows by pendingRequestObservedAt instead of updatedAt', () => {
        const now = Date.now();
        const activeGroup = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: activeGroup },
            { type: 'session', sessionId: 'older-request', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
            { type: 'session', sessionId: 'newer-request', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
            { type: 'session', sessionId: 'blocked-pending', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:older-request': makeSessionRow('older-request', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    hasPendingPermissionRequests: true,
                    pendingRequestObservedAt: now - 10_000,
                    updatedAt: now,
                }),
                's1:newer-request': makeSessionRow('newer-request', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    hasPendingPermissionRequests: true,
                    pendingRequestObservedAt: now - 1_000,
                    updatedAt: now - 20_000,
                }),
                's1:blocked-pending': makeSessionRow('blocked-pending', {
                    pendingBlockedCount: 1,
                    pendingRequestObservedAt: undefined,
                    hasPendingPermissionRequests: false,
                    hasPendingUserActionRequests: false,
                    updatedAt: now - 500,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(describeItems(result)).toEqual([
            'h:attention',
            's:blocked-pending:attention:attention-promotion-v1',
            's:newer-request:attention:attention-promotion-v1',
            's:older-request:attention:attention-promotion-v1',
        ]);
    });

    it('keeps pending attention rows in source order when transition timestamps are unchanged', () => {
        const now = Date.now();
        const activeGroup = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: activeGroup },
            { type: 'session', sessionId: 'first-request', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
            { type: 'session', sessionId: 'second-request', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:first-request': makeSessionRow('first-request', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    hasPendingPermissionRequests: true,
                    pendingRequestObservedAt: now - 1_000,
                    updatedAt: 100,
                }),
                's1:second-request': makeSessionRow('second-request', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    hasPendingPermissionRequests: true,
                    pendingRequestObservedAt: now - 1_000,
                    updatedAt: 10,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(describeItems(result)).toEqual([
            'h:attention',
            's:first-request:attention:attention-promotion-v1',
            's:second-request:attention:attention-promotion-v1',
        ]);
    });

    it('orders ready and failed attention rows by durable transition timestamps', () => {
        const dateGroup = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: dateGroup },
            { type: 'session', sessionId: 'older-failed', serverId: 's1', section: 'inactive', groupKey: dateGroup, groupKind: 'date' },
            { type: 'session', sessionId: 'newer-failed', serverId: 's1', section: 'inactive', groupKey: dateGroup, groupKind: 'date' },
            { type: 'session', sessionId: 'older-ready', serverId: 's1', section: 'inactive', groupKey: dateGroup, groupKind: 'date' },
            { type: 'session', sessionId: 'newer-ready', serverId: 's1', section: 'inactive', groupKey: dateGroup, groupKind: 'date' },
        ];

        const failedIssue = {
            v: 1 as const,
            scope: 'primary_session' as const,
            status: 'failed' as const,
            code: 'runtime_error',
            source: 'agent_session_error' as const,
        };

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:older-failed': makeSessionRow('older-failed', {
                    seq: 10,
                    lastViewedSessionSeq: 9,
                    hasUnreadMessages: true,
                    latestTurnStatus: 'failed',
                    latestTurnStatusObservedAt: 1_000,
                    lastRuntimeIssue: { ...failedIssue, occurredAt: 1_000 },
                    updatedAt: 10_000,
                }),
                's1:newer-failed': makeSessionRow('newer-failed', {
                    seq: 11,
                    lastViewedSessionSeq: 10,
                    hasUnreadMessages: true,
                    latestTurnStatus: 'failed',
                    latestTurnStatusObservedAt: 2_000,
                    lastRuntimeIssue: { ...failedIssue, occurredAt: 2_000 },
                    updatedAt: 100,
                }),
                's1:older-ready': makeSessionRow('older-ready', {
                    seq: 10,
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 3_000,
                    latestReadyEventSeq: 10,
                    latestReadyEventAt: 3_000,
                    lastViewedSessionSeq: 9,
                    updatedAt: 20_000,
                }),
                's1:newer-ready': makeSessionRow('newer-ready', {
                    seq: 11,
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 4_000,
                    latestReadyEventSeq: 11,
                    latestReadyEventAt: 4_000,
                    lastViewedSessionSeq: 10,
                    updatedAt: 200,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(describeItems(result)).toEqual([
            'h:attention',
            's:newer-failed:attention:attention-promotion-v1',
            's:older-failed:attention:attention-promotion-v1',
            's:newer-ready:attention:attention-promotion-v1',
            's:older-ready:attention:attention-promotion-v1',
        ]);
    });

    it('does not promote an inactive read failed session', () => {
        const dateGroup = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: dateGroup },
            { type: 'session', sessionId: 'read-failed', serverId: 's1', section: 'inactive', groupKey: dateGroup, groupKind: 'date' },
        ];
        const failedIssue = {
            v: 1 as const,
            scope: 'primary_session' as const,
            status: 'failed' as const,
            code: 'usage_limit',
            source: 'usage_limit' as const,
            occurredAt: 1_000,
        };
        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:read-failed': makeSessionRow('read-failed', {
                    seq: 10,
                    lastViewedSessionSeq: 10,
                    hasUnreadMessages: false,
                    latestTurnStatus: 'failed',
                    latestTurnStatusObservedAt: 1_000,
                    lastRuntimeIssue: failedIssue,
                    updatedAt: 1_000,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(describeItems(result)).toEqual([
            'h:date:Today',
            's:read-failed:date:server:s1:day:2026-02-17',
        ]);
    });

    it('keeps active read failed sessions in attention after later diagnostic activity', () => {
        const dateGroup = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: dateGroup },
            { type: 'session', sessionId: 'active-failed', serverId: 's1', section: 'active', groupKey: dateGroup, groupKind: 'date' },
        ];
        const failedIssue = {
            v: 1 as const,
            scope: 'primary_session' as const,
            status: 'failed' as const,
            code: 'usage_limit',
            source: 'usage_limit' as const,
            occurredAt: 1_000,
        };

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:active-failed': makeSessionRow('active-failed', {
                    active: true,
                    seq: 10,
                    lastViewedSessionSeq: 10,
                    hasUnreadMessages: false,
                    latestTurnStatus: 'failed',
                    latestTurnStatusObservedAt: 1_000,
                    meaningfulActivityAt: 2_500,
                    updatedAt: 2_500,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(describeItems(result)).toEqual([
            'h:attention',
            's:active-failed:attention:attention-promotion-v1',
        ]);
    });

    it('keeps inactive unread failed sessions in attention after later diagnostic activity', () => {
        const dateGroup = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: dateGroup },
            { type: 'session', sessionId: 'unread-failed', serverId: 's1', section: 'inactive', groupKey: dateGroup, groupKind: 'date' },
        ];
        const failedIssue = {
            v: 1 as const,
            scope: 'primary_session' as const,
            status: 'failed' as const,
            code: 'usage_limit',
            source: 'usage_limit' as const,
            occurredAt: 1_000,
        };

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:unread-failed': makeSessionRow('unread-failed', {
                    seq: 11,
                    lastViewedSessionSeq: 10,
                    hasUnreadMessages: true,
                    latestTurnStatus: 'failed',
                    latestTurnStatusObservedAt: 1_000,
                    meaningfulActivityAt: 2_500,
                    lastRuntimeIssue: failedIssue,
                    updatedAt: 2_500,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(describeItems(result)).toEqual([
            'h:attention',
            's:unread-failed:attention:attention-promotion-v1',
        ]);
    });

    it('does not re-promote an acknowledged completed turn after a later non-terminal update', () => {
        const dateGroup = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: dateGroup },
            { type: 'session', sessionId: 'done', serverId: 's1', section: 'inactive', groupKey: dateGroup, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:done': makeSessionRow('done', {
                    seq: 12,
                    latestTurnStatus: 'completed',
                    lastTurnCompletedAt: 1_000,
                    lastViewedSessionSeq: 10,
                    updatedAt: 1_500,
                    metadata: {
                        path: '',
                        readStateV1: {
                            v: 1,
                            sessionSeq: 10,
                            pendingActivityAt: 0,
                            updatedAt: 1_100,
                        },
                    },
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(describeItems(result)).toEqual([
            'h:date:Today',
            's:done:date:server:s1:day:2026-02-17',
        ]);
    });

    it('promotes unread completed turns with stale thinking flags', () => {
        const dateGroup = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: dateGroup },
            { type: 'session', sessionId: 'done', serverId: 's1', section: 'inactive', groupKey: dateGroup, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:done': makeSessionRow('done', {
                    seq: 12,
                    latestTurnStatus: 'completed',
                    lastTurnCompletedAt: 1_000,
                    lastViewedSessionSeq: 10,
                    thinking: true,
                    optimisticThinkingAt: 1_000,
                    thinkingGraceUntil: Date.now() + 10_000,
                    updatedAt: 1_000,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(describeItems(result)).toEqual([
            'h:attention',
            's:done:attention:attention-promotion-v1',
        ]);
    });

    it('keeps attention sessions inside current groups when within-groups mode is selected', () => {
        const now = Date.now();
        const folderGroup = 'folder:s1:workspaceScope:s1:m1:/repo:planning';
        const dateGroup = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'folder', title: 'Planning', serverId: 's1', groupKey: folderGroup, folderId: 'planning', folderDepth: 0 },
            { type: 'session', sessionId: 'folder-quiet', serverId: 's1', section: 'active', groupKey: folderGroup, groupKind: 'folder', folderId: 'planning', folderDepth: 1 },
            { type: 'session', sessionId: 'folder-action', serverId: 's1', section: 'active', groupKey: folderGroup, groupKind: 'folder', folderId: 'planning', folderDepth: 1 },
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: dateGroup },
            { type: 'session', sessionId: 'date-quiet', serverId: 's1', section: 'inactive', groupKey: dateGroup, groupKind: 'date' },
            { type: 'session', sessionId: 'date-ready', serverId: 's1', section: 'inactive', groupKey: dateGroup, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:folder-quiet': makeSessionRow('folder-quiet', { active: true, updatedAt: 100 }),
                's1:folder-action': makeSessionRow('folder-action', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    hasPendingUserActionRequests: true,
                    updatedAt: 200,
                }),
                's1:date-quiet': makeSessionRow('date-quiet', { updatedAt: 100 }),
                's1:date-ready': makeSessionRow('date-ready', {
                    seq: 10,
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 1_000,
                    meaningfulActivityAt: 1_044,
                    lastTurnCompletedAt: 200,
                    lastViewedSessionSeq: 9,
                    updatedAt: 200,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'withinGroups' },
        })!;

        expect(result.some((item) => item.type === 'header' && item.headerKind === 'attention')).toBe(false);
        expect(describeItems(result)).toEqual([
            'h:folder:Planning',
            's:folder-action:folder:folder:s1:workspaceScope:s1:m1:/repo:planning',
            's:folder-quiet:folder:folder:s1:workspaceScope:s1:m1:/repo:planning',
            'h:date:Today',
            's:date-ready:date:server:s1:day:2026-02-17',
            's:date-quiet:date:server:s1:day:2026-02-17',
        ]);
    });

    it('orders sessions by bucketed meaningful activity when ordering mode is updated', () => {
        const g = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: g },
            { type: 'session', sessionId: 'raw-newer', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
            { type: 'session', sessionId: 'activity-newer', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
        ];

        const resolveSessionRow = makeResolver({
            's1:raw-newer': makeSessionRow('raw-newer', {
                createdAt: 100,
                updatedAt: 900_000,
                meaningfulActivityAt: 120_000,
            }),
            's1:activity-newer': makeSessionRow('activity-newer', {
                createdAt: 90,
                updatedAt: 100,
                meaningfulActivityAt: 650_000,
            }),
        });

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            sessionListOrderingModeV1: 'updated' as OrderingMode,
        })!;

        const sessions = result.filter((i) => i.type === 'session') as Array<Extract<SessionListIndexItem, { type: 'session' }>>;
        expect(sessions.map((s) => s.sessionId)).toEqual(['activity-newer', 'raw-newer']);
    });

    it('returns the source array for updated mode when meaningful activity stays within the same bucket', () => {
        const g = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: g },
            { type: 'session', sessionId: 'stable-first', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
            { type: 'session', sessionId: 'raw-newer', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:stable-first': makeSessionRow('stable-first', {
                    createdAt: 200,
                    updatedAt: 100,
                    meaningfulActivityAt: 650_000,
                }),
                's1:raw-newer': makeSessionRow('raw-newer', {
                    createdAt: 100,
                    updatedAt: 900_000,
                    meaningfulActivityAt: 640_000,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            sessionListOrderingModeV1: 'updated' as OrderingMode,
        })!;

        expect(result).toBe(source);
    });

    it('reorders updated mode when meaningful activity crosses a bucket boundary', () => {
        const g = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: g },
            { type: 'session', sessionId: 'older-bucket', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
            { type: 'session', sessionId: 'newer-bucket', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:older-bucket': makeSessionRow('older-bucket', {
                    createdAt: 200,
                    updatedAt: 900_000,
                    meaningfulActivityAt: 590_000,
                }),
                's1:newer-bucket': makeSessionRow('newer-bucket', {
                    createdAt: 100,
                    updatedAt: 100,
                    meaningfulActivityAt: 610_000,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            sessionListOrderingModeV1: 'updated' as OrderingMode,
        })!;

        const sessions = result.filter((i) => i.type === 'session') as Array<Extract<SessionListIndexItem, { type: 'session' }>>;
        expect(sessions.map((s) => s.sessionId)).toEqual(['newer-bucket', 'older-bucket']);
    });

    it('forces inactive date groups to updated ordering in custom mode', () => {
        const groupKey = 'server:s1:inactive:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'older', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'newer', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:older': makeSessionRow('older', { createdAt: 100, updatedAt: 100, meaningfulActivityAt: 100 }),
                's1:newer': makeSessionRow('newer', { createdAt: 200, updatedAt: 200, meaningfulActivityAt: 650_000 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [groupKey]: ['s1:older', 's1:newer'] },
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const sessions = result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session');
        expect(sessions.map((session) => session.sessionId)).toEqual(['newer', 'older']);
    });

    it('uses custom order for inactive date rows when section mode is single', () => {
        const groupKey = 'server:s1:sessions:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'sessions', title: 'Sessions', serverId: 's1', groupKey: 'sessions:s1' },
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'newer', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'older', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:newer': makeSessionRow('newer', { createdAt: 200, updatedAt: 200, meaningfulActivityAt: 650_000 }),
                's1:older': makeSessionRow('older', { createdAt: 100, updatedAt: 100, meaningfulActivityAt: 100 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [groupKey]: ['s1:older', 's1:newer'] },
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            sessionListSectionModeV1: 'single',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const sessions = result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session');
        expect(sessions.map((session) => session.sessionId)).toEqual(['older', 'newer']);
    });

    it('keeps inactive date groups in source order when custom group order is stale', () => {
        const groupKey = 'server:s1:inactive:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'newest', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'middle', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'oldest', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:newest': makeSessionRow('newest', { createdAt: 10, updatedAt: 900_000, meaningfulActivityAt: 900_000 }),
                's1:middle': makeSessionRow('middle', { createdAt: 10, updatedAt: 600_000, meaningfulActivityAt: 600_000 }),
                's1:oldest': makeSessionRow('oldest', { createdAt: 10, updatedAt: 300_000, meaningfulActivityAt: 300_000 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [groupKey]: ['s1:oldest', 's1:newest', 's1:middle'] },
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const sessions = result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session');
        expect(sessions.map((session) => session.sessionId)).toEqual(['newest', 'middle', 'oldest']);
    });

    it('keeps new sessions before stale custom group order entries', () => {
        const groupKey = 'server:s1:active:project:abc123';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: 'repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'new-session', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'older-a', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'older-b', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:new-session': makeSessionRow('new-session', { createdAt: 300, updatedAt: 300, active: true }),
                's1:older-a': makeSessionRow('older-a', { createdAt: 200, updatedAt: 200, active: true }),
                's1:older-b': makeSessionRow('older-b', { createdAt: 100, updatedAt: 100, active: true }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [groupKey]: ['s1:older-b', 's1:older-a'] },
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const sessions = result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session');
        expect(sessions.map((session) => session.sessionId)).toEqual(['new-session', 'older-b', 'older-a']);
    });

    it('keeps root folders before root sessions by default when group order contains mixed child keys', () => {
        const projectGroupKey = 'server:s1:active:project:abc123';
        const rootFolderGroupKey = 'folder:s1:workspaceScope:s1:m1:/repo:root';
        const planningFolderGroupKey = 'folder:s1:workspaceScope:s1:m1:/repo:planning';
        const workspace = { t: 'workspaceScope' as const, serverId: 's1', machineId: 'm1', rootPath: '/repo' };
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: projectGroupKey },
            {
                type: 'header',
                headerKind: 'folder',
                title: 'Planning',
                serverId: 's1',
                groupKey: planningFolderGroupKey,
                folderId: 'planning',
                folderDepth: 0,
                workspace,
            },
            {
                type: 'session',
                sessionId: 'in-folder',
                serverId: 's1',
                section: 'active',
                groupKey: planningFolderGroupKey,
                groupKind: 'folder',
                folderId: 'planning',
                folderDepth: 1,
            },
            {
                type: 'session',
                sessionId: 'at-root',
                serverId: 's1',
                section: 'active',
                groupKey: rootFolderGroupKey,
                groupKind: 'folder',
                folderId: null,
                folderDepth: 0,
            },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:in-folder': makeSessionRow('in-folder', { active: true }),
                's1:at-root': makeSessionRow('at-root', { active: true }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [rootFolderGroupKey]: ['s1:at-root', 'folder:planning'] },
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}`
        ))).toEqual([
            'h:active:Active',
            'h:project:~/repo',
            'h:folder:Planning',
            's:in-folder',
            's:at-root',
        ]);
    });

    it('applies mixed folder and session ordering inside a workspace root folder group when selected', () => {
        const projectGroupKey = 'server:s1:active:project:abc123';
        const rootFolderGroupKey = 'folder:s1:workspaceScope:s1:m1:/repo:root';
        const planningFolderGroupKey = 'folder:s1:workspaceScope:s1:m1:/repo:planning';
        const workspace = { t: 'workspaceScope' as const, serverId: 's1', machineId: 'm1', rootPath: '/repo' };
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: projectGroupKey },
            {
                type: 'header',
                headerKind: 'folder',
                title: 'Planning',
                serverId: 's1',
                groupKey: planningFolderGroupKey,
                folderId: 'planning',
                folderDepth: 0,
                workspace,
            },
            {
                type: 'session',
                sessionId: 'in-folder',
                serverId: 's1',
                section: 'active',
                groupKey: planningFolderGroupKey,
                groupKind: 'folder',
                folderId: 'planning',
                folderDepth: 1,
            },
            {
                type: 'session',
                sessionId: 'at-root',
                serverId: 's1',
                section: 'active',
                groupKey: rootFolderGroupKey,
                groupKind: 'folder',
                folderId: null,
                folderDepth: 0,
            },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:in-folder': makeSessionRow('in-folder', { active: true }),
                's1:at-root': makeSessionRow('at-root', { active: true }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [rootFolderGroupKey]: ['s1:at-root', 'folder:planning'] },
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            sessionListFolderSortModeV1: 'mixed' as FolderSortMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}`
        ))).toEqual([
            'h:active:Active',
            'h:project:~/repo',
            's:at-root',
            'h:folder:Planning',
            's:in-folder',
        ]);
    });

    it('preserves workspace structural order when ordering mode is updated', () => {
        const repoAGroup = 'server:s1:project:repo-a';
        const repoBGroup = 'server:s1:project:repo-b';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1', groupKey: 'active:s1' },
            { type: 'header', headerKind: 'project', title: 'Repo A', serverId: 's1', groupKey: repoAGroup, workspaceKey: 'repo-a' },
            { type: 'session', sessionId: 'active-a', serverId: 's1', section: 'active', groupKey: repoAGroup, groupKind: 'project' },
            { type: 'header', headerKind: 'project', title: 'Repo B', serverId: 's1', groupKey: repoBGroup, workspaceKey: 'repo-b' },
            { type: 'session', sessionId: 'active-b', serverId: 's1', section: 'active', groupKey: repoBGroup, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:active-a': makeSessionRow('active-a', { active: true, meaningfulActivityAt: 650_000 }),
                's1:active-b': makeSessionRow('active-b', { active: true, meaningfulActivityAt: 640_000 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionWorkspaceOrderV1: {
                'server:s1:workspaces': ['workspace:repo-b', 'workspace:repo-a'],
            },
            sessionListOrderingModeV1: 'updated' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(describeItems(result)).toEqual([
            'h:active:Active',
            'h:project:Repo B',
            `s:active-b:project:${repoBGroup}`,
            'h:project:Repo A',
            `s:active-a:project:${repoAGroup}`,
        ]);
    });

    it('orders pinned sessions across activity sections by selected date ordering mode instead of dormant pinned order', () => {
        const activeGroupKey = 'server:s1:active:project:repo';
        const inactiveGroupKey = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 's1', groupKey: activeGroupKey },
            { type: 'session', sessionId: 'active-old-pinned', serverId: 's1', section: 'active', groupKey: activeGroupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'active-mid-pinned', serverId: 's1', section: 'active', groupKey: activeGroupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'normal', serverId: 's1', section: 'active', groupKey: activeGroupKey, groupKind: 'project' },
            { type: 'header', headerKind: 'inactive', title: 'Inactive', serverId: 's1' },
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: inactiveGroupKey },
            { type: 'session', sessionId: 'inactive-new-pinned', serverId: 's1', section: 'inactive', groupKey: inactiveGroupKey, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:active-old-pinned': makeSessionRow('active-old-pinned', { active: true, createdAt: 300, meaningfulActivityAt: 300_000 }),
                's1:active-mid-pinned': makeSessionRow('active-mid-pinned', { active: true, createdAt: 200, meaningfulActivityAt: 600_000 }),
                's1:inactive-new-pinned': makeSessionRow('inactive-new-pinned', { createdAt: 100, meaningfulActivityAt: 900_000 }),
                's1:normal': makeSessionRow('normal', { active: true, createdAt: 400, meaningfulActivityAt: 100 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['s1:active-old-pinned', 's1:active-mid-pinned', 's1:inactive-new-pinned'],
            sessionListGroupOrderV1: {
                'pinned-v1': ['s1:active-old-pinned', 's1:active-mid-pinned', 's1:inactive-new-pinned'],
            },
            sessionListOrderingModeV1: 'updated' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const pinnedSessions = result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => (
            item.type === 'session' && item.groupKind === 'pinned'
        ));
        expect(pinnedSessions.map((session) => session.sessionId)).toEqual([
            'inactive-new-pinned',
            'active-mid-pinned',
            'active-old-pinned',
        ]);
    });

    it('uses pinned-session fallback order after partial pinned structural order in custom mode', () => {
        const groupKey = 'server:s1:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'fallback-a', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'fallback-b', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'pinned-first', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:fallback-a': makeSessionRow('fallback-a', { active: true, createdAt: 300, meaningfulActivityAt: 900_000 }),
                's1:fallback-b': makeSessionRow('fallback-b', { active: true, createdAt: 200, meaningfulActivityAt: 600_000 }),
                's1:pinned-first': makeSessionRow('pinned-first', { active: true, createdAt: 100, meaningfulActivityAt: 100 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['s1:pinned-first', 's1:fallback-b', 's1:fallback-a'],
            sessionListGroupOrderV1: {
                'pinned-v1': ['s1:pinned-first'],
            },
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const pinnedSessions = result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => (
            item.type === 'session' && item.groupKind === 'pinned'
        ));
        expect(pinnedSessions.map((session) => session.sessionId)).toEqual(['pinned-first', 'fallback-b', 'fallback-a']);
    });

    it('orders pinned sessions by bucketed activity when updated ordering is active', () => {
        const groupKey = 'server:s1:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'fallback-a', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'fallback-b', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'pinned-first', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:fallback-a': makeSessionRow('fallback-a', { active: true, createdAt: 300, meaningfulActivityAt: 900_000 }),
                's1:fallback-b': makeSessionRow('fallback-b', { active: true, createdAt: 200, meaningfulActivityAt: 600_000 }),
                's1:pinned-first': makeSessionRow('pinned-first', { active: true, createdAt: 100, meaningfulActivityAt: 100 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['s1:pinned-first', 's1:fallback-b', 's1:fallback-a'],
            sessionListGroupOrderV1: {
                'pinned-v1': ['s1:pinned-first'],
            },
            sessionListOrderingModeV1: 'updated' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const pinnedSessions = result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => (
            item.type === 'session' && item.groupKind === 'pinned'
        ));
        expect(pinnedSessions.map((session) => session.sessionId)).toEqual(['fallback-a', 'fallback-b', 'pinned-first']);
    });

    it('preserves folder structural order with effective folders-first when ordering mode is updated', () => {
        const projectGroupKey = 'server:s1:active:project:abc123';
        const rootFolderGroupKey = 'folder:s1:workspaceScope:s1:m1:/repo:root';
        const planningFolderGroupKey = 'folder:s1:workspaceScope:s1:m1:/repo:planning';
        const reviewFolderGroupKey = 'folder:s1:workspaceScope:s1:m1:/repo:review';
        const workspace = { t: 'workspaceScope' as const, serverId: 's1', machineId: 'm1', rootPath: '/repo' };
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: projectGroupKey },
            {
                type: 'header',
                headerKind: 'folder',
                title: 'Planning',
                serverId: 's1',
                groupKey: planningFolderGroupKey,
                folderId: 'planning',
                folderDepth: 0,
                workspace,
            },
            {
                type: 'session',
                sessionId: 'planning-session',
                serverId: 's1',
                section: 'active',
                groupKey: planningFolderGroupKey,
                groupKind: 'folder',
                folderId: 'planning',
                folderDepth: 1,
            },
            {
                type: 'header',
                headerKind: 'folder',
                title: 'Review',
                serverId: 's1',
                groupKey: reviewFolderGroupKey,
                folderId: 'review',
                folderDepth: 0,
                workspace,
            },
            {
                type: 'session',
                sessionId: 'review-session',
                serverId: 's1',
                section: 'active',
                groupKey: reviewFolderGroupKey,
                groupKind: 'folder',
                folderId: 'review',
                folderDepth: 1,
            },
            {
                type: 'session',
                sessionId: 'root-session',
                serverId: 's1',
                section: 'active',
                groupKey: rootFolderGroupKey,
                groupKind: 'folder',
                folderId: null,
                folderDepth: 0,
            },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:planning-session': makeSessionRow('planning-session', { active: true, meaningfulActivityAt: 200 }),
                's1:review-session': makeSessionRow('review-session', { active: true, meaningfulActivityAt: 100 }),
                's1:root-session': makeSessionRow('root-session', { active: true, meaningfulActivityAt: 900_000 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [rootFolderGroupKey]: ['s1:root-session', 'folder:review', 'folder:planning'] },
            sessionListOrderingModeV1: 'updated' as OrderingMode,
            sessionListFolderSortModeV1: 'mixed' as FolderSortMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}`
        ))).toEqual([
            'h:active:Active',
            'h:project:~/repo',
            'h:folder:Review',
            's:review-session',
            'h:folder:Planning',
            's:planning-session',
            's:root-session',
        ]);
    });

    it('keeps the unified sessions section header when inactive rows are hidden', () => {
        const groupKey = 'server:s1:sessions:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'sessions', title: 'Sessions', serverId: 's1', groupKey: 'sessions:s1' },
            { type: 'header', headerKind: 'project', title: 'repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'active', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'inactive', serverId: 's1', section: 'inactive', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:active': makeSessionRow('active', { active: true }),
                's1:inactive': makeSessionRow('inactive', { active: false }),
            }),
            hideInactiveSessions: true,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.section ?? 'unknown'}`
        ))).toEqual([
            'h:sessions:Sessions',
            'h:project:repo',
            's:active:active',
        ]);
    });

    it('uses explicit single-section mode to apply custom order across active and inactive rows in actual project groups', () => {
        const groupKey = 'server:s1:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'sessions', title: 'Sessions', serverId: 's1', groupKey: 'sessions:s1' },
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 's1', groupKey, workspaceKey: 'repo' },
            { type: 'session', sessionId: 'active-a', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'inactive-b', serverId: 's1', section: 'inactive', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'active-c', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:active-a': makeSessionRow('active-a', { active: true }),
                's1:inactive-b': makeSessionRow('inactive-b'),
                's1:active-c': makeSessionRow('active-c', { active: true }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [groupKey]: ['s1:inactive-b', 's1:active-c', 's1:active-a'] },
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            sessionListSectionModeV1: 'single',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(describeItems(result)).toEqual([
            'h:sessions:Sessions',
            'h:project:Repo',
            `s:inactive-b:project:${groupKey}`,
            `s:active-c:project:${groupKey}`,
            `s:active-a:project:${groupKey}`,
        ]);
    });

    it('uses explicit single-section mode to date-order active and inactive rows together in actual project groups', () => {
        const groupKey = 'server:s1:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'sessions', title: 'Sessions', serverId: 's1', groupKey: 'sessions:s1' },
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 's1', groupKey, workspaceKey: 'repo' },
            { type: 'session', sessionId: 'active-old', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'inactive-new', serverId: 's1', section: 'inactive', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'active-middle', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:active-old': makeSessionRow('active-old', { active: true, meaningfulActivityAt: 100 }),
                's1:inactive-new': makeSessionRow('inactive-new', { meaningfulActivityAt: 900_000 }),
                's1:active-middle': makeSessionRow('active-middle', { active: true, meaningfulActivityAt: 650_000 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'updated' as OrderingMode,
            sessionListSectionModeV1: 'single',
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(describeItems(result)).toEqual([
            'h:sessions:Sessions',
            'h:project:Repo',
            `s:inactive-new:project:${groupKey}`,
            `s:active-middle:project:${groupKey}`,
            `s:active-old:project:${groupKey}`,
        ]);
    });

    it('applies one workspace order scope independently inside each visible activity section', () => {
        const repoAGroup = 'server:s1:project:repo-a';
        const repoBGroup = 'server:s1:project:repo-b';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1', groupKey: 'active:s1' },
            { type: 'header', headerKind: 'project', title: 'Repo A', serverId: 's1', groupKey: repoAGroup, workspaceKey: 'repo-a' },
            { type: 'session', sessionId: 'active-a', serverId: 's1', section: 'active', groupKey: repoAGroup, groupKind: 'project' },
            { type: 'header', headerKind: 'project', title: 'Repo B', serverId: 's1', groupKey: repoBGroup, workspaceKey: 'repo-b' },
            { type: 'session', sessionId: 'active-b', serverId: 's1', section: 'active', groupKey: repoBGroup, groupKind: 'project' },
            { type: 'header', headerKind: 'inactive', title: 'Inactive', serverId: 's1', groupKey: 'inactive:s1' },
            { type: 'header', headerKind: 'project', title: 'Repo A', serverId: 's1', groupKey: repoAGroup, workspaceKey: 'repo-a' },
            { type: 'session', sessionId: 'inactive-a', serverId: 's1', section: 'inactive', groupKey: repoAGroup, groupKind: 'project' },
            { type: 'header', headerKind: 'project', title: 'Repo B', serverId: 's1', groupKey: repoBGroup, workspaceKey: 'repo-b' },
            { type: 'session', sessionId: 'inactive-b', serverId: 's1', section: 'inactive', groupKey: repoBGroup, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:active-a': makeSessionRow('active-a', { active: true }),
                's1:active-b': makeSessionRow('active-b', { active: true }),
                's1:inactive-a': makeSessionRow('inactive-a'),
                's1:inactive-b': makeSessionRow('inactive-b'),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionWorkspaceOrderV1: {
                'server:s1:workspaces': ['workspace:repo-b', 'workspace:repo-a'],
            },
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(describeItems(result)).toEqual([
            'h:active:Active',
            'h:project:Repo B',
            `s:active-b:project:${repoBGroup}`,
            'h:project:Repo A',
            `s:active-a:project:${repoAGroup}`,
            'h:inactive:Inactive',
            'h:project:Repo B',
            `s:inactive-b:project:${repoBGroup}`,
            'h:project:Repo A',
            `s:inactive-a:project:${repoAGroup}`,
        ]);
    });

    it('applies folder structural order independently inside each repeated visible activity section', () => {
        const projectGroupKey = 'server:s1:project:repo';
        const rootFolderGroupKey = 'folder:s1:workspaceScope:s1:m1:/repo:root';
        const planningFolderGroupKey = 'folder:s1:workspaceScope:s1:m1:/repo:planning';
        const reviewFolderGroupKey = 'folder:s1:workspaceScope:s1:m1:/repo:review';
        const workspace = { t: 'workspaceScope' as const, serverId: 's1', machineId: 'm1', rootPath: '/repo' };
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1', groupKey: 'active:s1' },
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 's1', groupKey: projectGroupKey },
            {
                type: 'header',
                headerKind: 'folder',
                title: 'Planning',
                serverId: 's1',
                groupKey: planningFolderGroupKey,
                folderId: 'planning',
                folderDepth: 0,
                workspace,
            },
            { type: 'session', sessionId: 'active-planning', serverId: 's1', section: 'active', groupKey: planningFolderGroupKey, groupKind: 'folder', folderId: 'planning', folderDepth: 1 },
            {
                type: 'header',
                headerKind: 'folder',
                title: 'Review',
                serverId: 's1',
                groupKey: reviewFolderGroupKey,
                folderId: 'review',
                folderDepth: 0,
                workspace,
            },
            { type: 'session', sessionId: 'active-review', serverId: 's1', section: 'active', groupKey: reviewFolderGroupKey, groupKind: 'folder', folderId: 'review', folderDepth: 1 },
            { type: 'header', headerKind: 'inactive', title: 'Inactive', serverId: 's1', groupKey: 'inactive:s1' },
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 's1', groupKey: projectGroupKey },
            {
                type: 'header',
                headerKind: 'folder',
                title: 'Planning',
                serverId: 's1',
                groupKey: planningFolderGroupKey,
                folderId: 'planning',
                folderDepth: 0,
                workspace,
            },
            { type: 'session', sessionId: 'inactive-planning', serverId: 's1', section: 'inactive', groupKey: planningFolderGroupKey, groupKind: 'folder', folderId: 'planning', folderDepth: 1 },
            {
                type: 'header',
                headerKind: 'folder',
                title: 'Review',
                serverId: 's1',
                groupKey: reviewFolderGroupKey,
                folderId: 'review',
                folderDepth: 0,
                workspace,
            },
            { type: 'session', sessionId: 'inactive-review', serverId: 's1', section: 'inactive', groupKey: reviewFolderGroupKey, groupKind: 'folder', folderId: 'review', folderDepth: 1 },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:active-planning': makeSessionRow('active-planning', { active: true }),
                's1:active-review': makeSessionRow('active-review', { active: true }),
                's1:inactive-planning': makeSessionRow('inactive-planning'),
                's1:inactive-review': makeSessionRow('inactive-review'),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [rootFolderGroupKey]: ['folder:review', 'folder:planning'] },
            sessionListOrderingModeV1: 'updated' as OrderingMode,
            sessionListFolderSortModeV1: 'foldersFirst' as FolderSortMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : `s:${item.sessionId}:${item.section ?? 'unknown'}`
        ))).toEqual([
            'h:active:Active',
            'h:project:Repo',
            'h:folder:Review',
            's:active-review:active',
            'h:folder:Planning',
            's:active-planning:active',
            'h:inactive:Inactive',
            'h:project:Repo',
            'h:folder:Review',
            's:inactive-review:inactive',
            'h:folder:Planning',
            's:inactive-planning:inactive',
        ]);
    });

    it('sorts repeated project group keys independently inside each visible activity section', () => {
        const repoGroup = 'server:s1:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1', groupKey: 'active:s1' },
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 's1', groupKey: repoGroup, workspaceKey: 'repo' },
            { type: 'session', sessionId: 'active-older', serverId: 's1', section: 'active', groupKey: repoGroup, groupKind: 'project' },
            { type: 'session', sessionId: 'active-newer', serverId: 's1', section: 'active', groupKey: repoGroup, groupKind: 'project' },
            { type: 'header', headerKind: 'inactive', title: 'Inactive', serverId: 's1', groupKey: 'inactive:s1' },
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 's1', groupKey: repoGroup, workspaceKey: 'repo' },
            { type: 'session', sessionId: 'inactive-older', serverId: 's1', section: 'inactive', groupKey: repoGroup, groupKind: 'project' },
            { type: 'session', sessionId: 'inactive-newer', serverId: 's1', section: 'inactive', groupKey: repoGroup, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:active-older': makeSessionRow('active-older', { active: true, meaningfulActivityAt: 100 }),
                's1:active-newer': makeSessionRow('active-newer', { active: true, meaningfulActivityAt: 650_000 }),
                's1:inactive-older': makeSessionRow('inactive-older', { meaningfulActivityAt: 900_000 }),
                's1:inactive-newer': makeSessionRow('inactive-newer', { meaningfulActivityAt: 1_250_000 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'updated' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(describeItems(result)).toEqual([
            'h:active:Active',
            'h:project:Repo',
            `s:active-newer:project:${repoGroup}`,
            `s:active-older:project:${repoGroup}`,
            'h:inactive:Inactive',
            'h:project:Repo',
            `s:inactive-newer:project:${repoGroup}`,
            `s:inactive-older:project:${repoGroup}`,
        ]);
    });
});
