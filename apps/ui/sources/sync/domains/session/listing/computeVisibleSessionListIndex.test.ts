import { afterEach, describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import type { SessionListRenderableSession } from './sessionListRenderable';
import { computeVisibleSessionListIndex } from './computeVisibleSessionListIndex';

type OrderingMode = 'custom' | 'created' | 'updated';

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
        const g = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: g },
            { type: 'session', sessionId: 'a', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
            { type: 'session', sessionId: 'b', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
        ];

        const resolveSessionRow = makeResolver({
            's1:a': makeSessionRow('a', { createdAt: 10, updatedAt: 20 }),
            's1:b': makeSessionRow('b', { createdAt: 20, updatedAt: 30 }),
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
        const g = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: g },
            { type: 'session', sessionId: 'a', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
            { type: 'session', sessionId: 'b', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
        ];

        const resolveSessionRow = makeResolver({
            's1:a': makeSessionRow('a', { createdAt: 10, updatedAt: 20 }),
            's1:b': makeSessionRow('b', { createdAt: 20, updatedAt: 30 }),
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

    it('promotes attention sessions into a global section below pinned sessions', () => {
        const activeGroup = 'server:s1:active:project:repo';
        const inactiveGroup = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: activeGroup },
            { type: 'session', sessionId: 'action', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
            { type: 'header', headerKind: 'inactive', title: 'Inactive', serverId: 's1' },
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: inactiveGroup },
            { type: 'session', sessionId: 'ready', serverId: 's1', section: 'inactive', groupKey: inactiveGroup, groupKind: 'date' },
            { type: 'session', sessionId: 'quiet', serverId: 's1', section: 'inactive', groupKey: inactiveGroup, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:action': makeSessionRow('action', {
                    active: true,
                    presence: 'online',
                    hasPendingUserActionRequests: true,
                    updatedAt: 300,
                }),
                's1:working': makeSessionRow('working', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    hasPendingUserActionRequests: true,
                    updatedAt: 400,
                }),
                's1:ready': makeSessionRow('ready', {
                    seq: 10,
                    latestTurnStatus: 'completed',
                    lastTurnCompletedAt: 200,
                    lastViewedSessionSeq: 9,
                    updatedAt: 200,
                }),
                's1:quiet': makeSessionRow('quiet', { updatedAt: 100 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['s1:quiet'],
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'custom' as OrderingMode,
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(describeItems(result)).toEqual([
            'h:pinned:Pinned',
            's:quiet:pinned:pinned-v1',
            'h:attention',
            's:action:attention:attention-promotion-v1',
            's:ready:attention:attention-promotion-v1',
            'h:active:Active',
            'h:project:~/repo',
            's:working:project:server:s1:active:project:repo',
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

    it('keeps attention sessions inside current groups when within-groups mode is selected', () => {
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
                    hasPendingUserActionRequests: true,
                    updatedAt: 200,
                }),
                's1:date-quiet': makeSessionRow('date-quiet', { updatedAt: 100 }),
                's1:date-ready': makeSessionRow('date-ready', {
                    seq: 10,
                    latestTurnStatus: 'completed',
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

    it('orders sessions by updatedAt descending (with stable tie-breaks) when ordering mode is updated', () => {
        const g = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: g },
            { type: 'session', sessionId: 'b', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
            { type: 'session', sessionId: 'd', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
            { type: 'session', sessionId: 'c', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
            { type: 'session', sessionId: 'a', serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
        ];

        const resolveSessionRow = makeResolver({
            's1:a': makeSessionRow('a', { createdAt: 10, updatedAt: 200 }),
            's1:b': makeSessionRow('b', { createdAt: 30, updatedAt: 100 }),
            's1:c': makeSessionRow('c', { createdAt: 20, updatedAt: 100 }),
            's1:d': makeSessionRow('d', { createdAt: 20, updatedAt: 100 }),
        });

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [g]: ['s1:c', 's1:b'] },
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            sessionListOrderingModeV1: 'updated' as OrderingMode,
        })!;

        const sessions = result.filter((i) => i.type === 'session') as Array<Extract<SessionListIndexItem, { type: 'session' }>>;
        expect(sessions.map((s) => s.sessionId)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('applies mixed folder and session ordering inside a workspace root folder group', () => {
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
            's:at-root',
            'h:folder:Planning',
            's:in-folder',
        ]);
    });
});
