import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import type { SessionListRenderableSession } from './sessionListRenderable';
import { computeVisibleSessionListIndex, computeVisibleSessionListProjection } from './computeVisibleSessionListIndex';
import { buildSessionListFolderOrderItemKey } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { buildSessionWorkspaceOrderScopeKey } from '@/sync/domains/session/listing/sessionWorkspaceOrderStateV1';
import { filterCollapsedSessionListItems } from '@/components/sessions/shell/filterCollapsedSessionListItems';
import { buildVisibleSessionNavigationEntries } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { buildSessionListIndexNodeId } from '@/sync/domains/sessionList/sessionListIndex';
import { resolveVisibleSessionListIndexSummary } from './sessionListIndexPresentation';
import { buildSessionOrganizationProjection } from '@/sync/domains/session/organization/projection';
import { buildSessionOrganizationListViewStateForServers } from '@/sync/domains/session/organization/viewState';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';

function folderOrderKey(folderId: string): string {
    return buildSessionListFolderOrderItemKey({ serverId: 's1', folderId })!;
}


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
        encryptionMode: 'plain',
        metadata: { path: '/repo' },
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

describe('attention occurrence composition', () => {
    const nowMs = 1_000_000;
    const source: SessionListIndexItem[] = [
        { type: 'header', headerKind: 'project', title: 'Project', groupKey: 'project-a' },
        { type: 'session', serverId: 's1', sessionId: 'lead', groupKey: 'project-a', groupKind: 'project' },
        { type: 'session', serverId: 's1', sessionId: 'child', groupKey: 'project-a', groupKind: 'project' },
    ];
    function project(placement: 'both' | 'top' | 'inPlace', childVisible = true) {
        return computeVisibleSessionListIndex({ source, sessionListAttentionPlacementV1: placement,
            nowMs, hideInactiveSessions: !childVisible, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped' }, resolveSessionRow: makeResolver({
                's1:lead': makeSessionRow('lead', { active: true, presence: 'online',
                    viewer: createSessionViewerFixture({ attention: {
                        needsAttention: true, reasons: ['permission_required'], primary: 'permission_required', presentation: 'full',
                    } }),
                }),
                's1:child': makeSessionRow('child', { active: childVisible, presence: 'online', manager: { sessionId: 'lead' } }),
            }) })!;
    }

    it('nests the filed base child before expanding flat shelf copies', () => {
        const both = project('both');
        const lead = both.filter(item => item.type === 'session' && item.sessionId === 'lead');
        expect(lead).toHaveLength(2);
        expect(lead.find(item => item.type === 'session' && item.occurrenceRole === 'needsYou')).toMatchObject({ reportsDepth: undefined });
        expect(both.find(item => item.type === 'session' && item.sessionId === 'child')).toMatchObject({ reportsDepth: 1 });
        expect(project('top').filter(item => item.type === 'session' && item.sessionId === 'lead')).toHaveLength(2);
        expect(project('inPlace').filter(item => item.type === 'session' && item.sessionId === 'lead')).toHaveLength(1);
    });

    it('suppresses a Top base after its only child is filtered from the visible tree', () => {
        const top = project('top', false);
        expect(top.filter(item => item.type === 'session' && item.sessionId === 'lead')).toHaveLength(1);
    });
});

function describeItems(items: ReadonlyArray<SessionListIndexItem>): string[] {
    return items.map((item) => {
        if (item.type === 'header') {
            return item.headerKind === 'attention'
                ? 'h:attention'
                : item.headerKind === 'working'
                    ? 'h:working'
                : `h:${item.headerKind ?? 'unknown'}:${item.title}`;
        }
        return item.type === 'session'
            ? `s:${item.sessionId}:${item.groupKind ?? 'none'}:${item.groupKey ?? 'none'}`
            : `r:${item.runId}:${item.groupKind ?? 'none'}:${item.groupKey ?? 'none'}`;
    });
}

describe('computeVisibleSessionListIndex', () => {
    it('does not rebuild the admitted Project census on an unchanged Session-only workflow pass', () => {
        let censusIdReads = 0;
        const workspaceRefs = [{
            get id() { censusIdReads += 1; return 'workspace'; },
            serverId: 's1', machineId: 'machine', rootPath: '/repo', projectKey: 'project',
            createdAtMs: 0, label: null, lastOpenedAtMs: null,
        }];
        const rows = Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => {
            const id = `session-${index}`;
            return [`s1:${id}`, makeSessionRow(id)];
        }));
        const source: SessionListIndexItem[] = Object.values(rows).map(row => ({
            type: 'session', serverId: 's1', sessionId: row.id,
        }));
        const params = { source, resolveSessionRow: makeResolver(rows), workflowRuns: [], workspaceRefs,
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped' as const }, nowMs: 1_000 };
        const first = computeVisibleSessionListProjection(params);
        censusIdReads = 0;
        const second = computeVisibleSessionListProjection({ ...params, previousMembership: first.membership });
        expect(second.items?.filter(item => item.type === 'session')).toHaveLength(1_001);
        // A resolver construction reads every census id. This observes the real input,
        // without substituting the resolver or any of its domain decisions.
        expect(censusIdReads).toBe(0);
    });
    it('keeps Section record order while applying only Session sibling order', () => {
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'folder', title: 'First', groupKey: 'section-a', folderId: 'a', serverId: 's1', folderDepth: 0, workspace: { t: 'workspaceRef', serverId: 's1', workspaceRefId: 'w' } },
            { type: 'session', sessionId: 'old', serverId: 's1', groupKey: 'section-a', groupKind: 'folder', folderDepth: 1 },
            { type: 'session', sessionId: 'new', serverId: 's1', groupKey: 'section-a', groupKind: 'folder', folderDepth: 1 },
            { type: 'header', headerKind: 'folder', title: 'Second', groupKey: 'section-b', folderId: 'b', serverId: 's1', folderDepth: 0, workspace: { t: 'workspaceRef', serverId: 's1', workspaceRefId: 'w' } },
            { type: 'session', sessionId: 'other', serverId: 's1', groupKey: 'section-b', groupKind: 'folder', folderDepth: 1 },
        ];
        const result = computeVisibleSessionListIndex({ source, sessionListLayoutChoice: 'projects',
            sessionListAttentionPlacementV1: 'inPlace', hideInactiveSessions: false,
            pinnedSessionKeysV1: [], sessionListGroupOrderV1: { 'section-a': ['s1:new', 's1:old'],
                'folder:s1:workspaceRef:s1:w:root': [folderOrderKey('b'), folderOrderKey('a')] },
            presentation: { enabled: false, presentation: 'grouped' }, resolveSessionRow: makeResolver({
                's1:old': makeSessionRow('old', { active: true, createdAt: 1 }),
                's1:new': makeSessionRow('new', { active: true, createdAt: 2 }),
                's1:other': makeSessionRow('other', { active: true, createdAt: 3 }),
            }) });
        expect(result?.filter(item => item.type === 'header').map(item => item.folderId)).toEqual(['a', 'b']);
        expect(result?.filter(item => item.type === 'session').map(item => item.sessionId)).toEqual(['new', 'old', 'other']);
    });
    it.each([false, true])('nests cross-date reports with correct headers and collapse/navigation order (workflow branch: %s)', (workflowBranch) => {
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', groupKey: 'today' },
            { type: 'session', sessionId: 'lead', serverId: 's1', groupKey: 'today', groupKind: 'date' },
            { type: 'header', headerKind: 'date', title: 'Yesterday', groupKey: 'yesterday' },
            { type: 'session', sessionId: 'worker', serverId: 's1', groupKey: 'yesterday', groupKind: 'date' },
            { type: 'header', headerKind: 'date', title: 'Older', groupKey: 'older' },
            { type: 'session', sessionId: 'grandchild', serverId: 's1', groupKey: 'older', groupKind: 'date' },
        ];
        const visible = computeVisibleSessionListIndex({
            sessionListAttentionPlacementV1: 'inPlace', source,
            resolveSessionRow: makeResolver({ 's1:lead': makeSessionRow('lead'),
                's1:worker': makeSessionRow('worker', { manager: { sessionId: 'lead' } }),
                's1:grandchild': makeSessionRow('grandchild', { manager: { sessionId: 'worker' } }) }),
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped' },
            ...(workflowBranch ? { workflowRuns: [] } : {}),
        })!;
        expect(visible.filter(item => item.type === 'header').map(item => item.title)).toEqual(['Today']);
        expect(visible.filter(item => item.type === 'session').map(item => [item.sessionId, item.groupKey, item.reportsDepth ?? 0]))
            .toEqual([['lead', 'today', 0], ['worker', 'today', 1], ['grandchild', 'today', 2]]);
        expect(resolveVisibleSessionListIndexSummary({ enabled: false, activeServerId: 's1', activeIndex: visible })).toMatchObject({ sessionCount: 3 });
        expect(buildVisibleSessionNavigationEntries(visible).map(item => item.sessionId)).toEqual(['lead', 'worker', 'grandchild']);
        const lead = visible.find(item => item.type === 'session' && item.sessionId === 'lead')!;
        const collapsed = filterCollapsedSessionListItems(visible, { [buildSessionListIndexNodeId(lead)]: true });
        expect(collapsed.filter(item => item.type === 'session').map(item => item.sessionId)).toEqual(['lead']);
        expect(filterCollapsedSessionListItems(visible, { yesterday: true })).toBe(visible);
    });
    afterEach(() => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('uses the canonical Projects section default when the section mode is absent', () => {
        const groupKey = 'server:s1:sessions:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'sessions', title: 'Sessions', serverId: 's1', groupKey: 'sessions:s1' },
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'active', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'inactive', serverId: 's1', section: 'inactive', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            sessionListAttentionPlacementV1: 'inPlace',
            source,
            resolveSessionRow: makeResolver({
                's1:active': makeSessionRow('active', { active: true }),
                's1:inactive': makeSessionRow('inactive'),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [groupKey]: ['s1:inactive', 's1:active'] },
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result.filter((item) => item.type === 'session').map((item) => item.sessionId)).toEqual([
            'inactive',
            'active',
        ]);
    });

    it('keeps inactive rows for Homes whose strict query already applied the inactive rule', () => {
        const groupA = 'server:s1:sessions:project:repo';
        const groupB = 'server:s2:sessions:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'sessions', title: 'Sessions', serverId: 's1', groupKey: 'sessions:s1' },
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 's1', groupKey: groupA },
            { type: 'session', sessionId: 'served-inactive', serverId: 's1', section: 'inactive', groupKey: groupA, groupKind: 'project' },
            { type: 'header', headerKind: 'sessions', title: 'Sessions', serverId: 's2', groupKey: 'sessions:s2' },
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 's2', groupKey: groupB },
            { type: 'session', sessionId: 'local-inactive', serverId: 's2', section: 'inactive', groupKey: groupB, groupKind: 'project' },
        ];
        const resolveSessionRow = makeResolver({
            's1:served-inactive': makeSessionRow('served-inactive'),
            's2:local-inactive': makeSessionRow('local-inactive'),
        });
        const compute = (serverFilteredInactiveServerIds?: ReadonlySet<string>) => computeVisibleSessionListIndex({
            sessionListAttentionPlacementV1: 'inPlace',
            source,
            resolveSessionRow,
            hideInactiveSessions: true,
            ...(serverFilteredInactiveServerIds ? { serverFilteredInactiveServerIds } : {}),
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        // The Home that answered the strict query already decided which inactive
        // rows its corpus keeps; the released GET corpus still needs the local rule.
        expect(compute(new Set(['s1'])).filter((item) => item.type === 'session').map((item) => item.sessionId))
            .toEqual(['served-inactive']);
        expect(compute().filter((item) => item.type === 'session')).toEqual([]);
    });

    it('preserves Session row identities when custom ordering inputs are no-ops', () => {
        const g = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 's1', groupKey: g },
            { type: 'session', sessionId: 'a', serverId: 's1', section: 'active', groupKey: g, groupKind: 'project' },
            { type: 'session', sessionId: 'b', serverId: 's1', section: 'active', groupKey: g, groupKind: 'project' },
        ];

        const resolveSessionRow = makeResolver({
            's1:a': makeSessionRow('a', { active: true, createdAt: 10, updatedAt: 20, metadata: null }),
            's1:b': makeSessionRow('b', { active: true, createdAt: 20, updatedAt: 30, metadata: null }),
        });

        const result = computeVisibleSessionListIndex({
            sessionListAttentionPlacementV1: 'inPlace',
            source,
            resolveSessionRow,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [g]: [] },
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        // The current shared presenter adds a header rollup; ordering must still
        // preserve the unchanged entity row objects beneath that projection.
        expect(result[1]).toBe(source[1]);
        expect(result[2]).toBe(source[2]);
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
            's1:a': makeSessionRow('a', { active: true, createdAt: 10, updatedAt: 20, metadata: null }),
            's1:b': makeSessionRow('b', { active: true, createdAt: 20, updatedAt: 30, metadata: null }),
        });

        const result = computeVisibleSessionListIndex({
            sessionListAttentionPlacementV1: 'inPlace',
            source,
            resolveSessionRow,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        expect(result?.[1]).toBe(source[1]);
        expect(result?.[2]).toBe(source[2]);
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
            sessionListAttentionPlacementV1: 'inPlace',
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

    it('records visible placeholder rows on the no-op ordering path', () => {
        syncPerformanceTelemetry.configure({ enabled: true });
        const g = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 's1', groupKey: g },
            { type: 'session', sessionId: 'visible-placeholder', serverId: 's1', section: 'active', groupKey: g, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            sessionListAttentionPlacementV1: 'inPlace',
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
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        });

        expect(result?.[1]).toBe(source[1]);
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
            sessionListAttentionPlacementV1: 'inPlace',
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
            sessionListAttentionPlacementV1: 'inPlace',
            source,
            resolveSessionRow: makeResolver({}),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
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
            sessionListAttentionPlacementV1: 'top',
            source,
            resolveSessionRow: makeResolver({
                's1:action': makeSessionRow('action', {
                    viewer: createSessionViewerFixture({ attention: {
                        needsAttention: true, reasons: ['user_action_required'], primary: 'user_action_required', presentation: 'full',
                    } }),
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
                    viewer: createSessionViewerFixture({ attention: {
                        needsAttention: true, reasons: ['permission_required'], primary: 'permission_required', presentation: 'full',
                    } }),
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
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(describeItems(result.filter(item => item.type === 'session'))).toEqual([
            's:action:attention:attention-promotion-v1',
            's:pinned-ready:attention:attention-promotion-v1',
            's:working:working:working-placement-v1',
            's:quiet:pinned:pinned-v1',
            's:ready:date:server:s1:day:2026-02-17',
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
        expect(pinnedReady?.attentionPlacementReason).toBe('permission_required');
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
            sessionListAttentionPlacementV1: 'top',
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
            sessionListAttentionPlacementV1: 'top',
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
            sessionListAttentionPlacementV1: 'top',
            source,
            previousPresentedIndex: [
                { type: 'session', sessionId: 'first-retained', serverId: 's1', section: 'active', groupKey: 'working-placement-v1', groupKind: 'working', occurrenceRole: 'working' },
                { type: 'session', sessionId: 'second-retained', serverId: 's1', section: 'active', groupKey: 'working-placement-v1', groupKind: 'working', occurrenceRole: 'working' },
            ],
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

    it('classifies global attention and working placement in one row-resolution pass', () => {
        const now = 1_000_000;
        const groupKey = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'ready', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'retained-working', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
            { type: 'session', sessionId: 'idle', serverId: 's1', section: 'active', groupKey, groupKind: 'project' },
        ];
        const rows = {
            's1:ready': makeSessionRow('ready', {
                viewer: createSessionViewerFixture({ attention: {
                    needsAttention: true, reasons: ['permission_required'], primary: 'permission_required', presentation: 'full',
                } }),
                seq: 4,
                latestTurnStatus: 'completed' as const,
                latestTurnStatusObservedAt: now - 2_000,
                lastTurnCompletedAt: now - 2_000,
                lastViewedSessionSeq: 1,
            }),
            's1:working': makeSessionRow('working', {
                active: true,
                presence: 'online' as const,
                thinking: true,
                latestTurnStatus: 'in_progress' as const,
                latestTurnStatusObservedAt: now - 1_000,
            }),
            's1:retained-working': makeSessionRow('retained-working', {
                active: true,
                activeAt: now - 130_000,
                presence: 'online' as const,
                thinking: true,
                latestTurnStatus: 'in_progress' as const,
                latestTurnStatusObservedAt: now - 130_000,
            }),
            's1:idle': makeSessionRow('idle'),
        };
        const common = {
            source,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped' as const, selectedServerIds: [] },
            attentionPlacement: { mode: 'global' as const },
            nowMs: now,
        };
        const resolveRow = makeResolver(rows);

        let attentionOnlyRowResolutions = 0;
        computeVisibleSessionListIndex({
            sessionListAttentionPlacementV1: 'inPlace',
            ...common,
            resolveSessionRow: (serverId, sessionId) => {
                attentionOnlyRowResolutions += 1;
                return resolveRow(serverId, sessionId);
            },
        });

        let combinedRowResolutions = 0;
        const combined = computeVisibleSessionListIndex({
            sessionListAttentionPlacementV1: 'top',
            ...common,
            resolveSessionRow: (serverId, sessionId) => {
                combinedRowResolutions += 1;
                return resolveRow(serverId, sessionId);
            },
            workingPlacement: {
                mode: 'global',
                retainSessionKeys: ['s1:retained-working'],
            },
        })!;

        expect(combined.map((item) => item.type === 'header'
            ? `h:${item.headerKind}`
            : item.type === 'session'
                ? `s:${item.sessionId}:${item.groupKind ?? 'none'}:${item.attentionPlacementReason ?? item.workingPlacementReason ?? 'none'}`
                : `r:${item.runId}`
        )).toEqual([
            'h:attention',
            's:ready:attention:permission_required',
            'h:working',
            's:working:working:working',
            's:retained-working:working:working-retained',
            'h:active',
            'h:project',
            's:idle:project:none',
        ]);
        expect(combinedRowResolutions).toBe(attentionOnlyRowResolutions);
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
            sessionListAttentionPlacementV1: 'top',
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
            'retained-working:working-retained',
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
            sessionListAttentionPlacementV1: 'top',
            source,
            resolveSessionRow: makeResolver({
                's1:stale-working': staleWorkingRow,
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
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
            sessionListAttentionPlacementV1: 'top',
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
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
            workingPlacement: { mode: 'global', retainSessionKeys: ['s1:stale-working'] },
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
            workingPlacement: { mode: 'global'; retainSessionKeys: string[] };
        })!;

        expect(completed.filter(item => item.type === 'session').map(item => [
            item.sessionId, item.groupKind, item.attentionPlacementReason, item.workingPlacementReason,
        ])).toEqual([['stale-working', 'project', undefined, undefined]]);
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
            sessionListAttentionPlacementV1: 'top',
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

    it('does not extend expired Working eligibility from an old projected turn alone', () => {
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
            sessionListAttentionPlacementV1: 'top',
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
                presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
                workingPlacement: { mode: 'global', retainSessionKeys: ['s1:stale-working'] },
            } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
                workingPlacement: { mode: 'global'; retainSessionKeys: string[] };
            })!;

            expect(describeItems(result)).toEqual([
                'h:active:Active',
                'h:project:~/repo',
                's:stale-working:project:server:s1:active:project:repo',
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not refresh expired Working eligibility from generic row updates', () => {
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
            sessionListAttentionPlacementV1: 'top',
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
                presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
                workingPlacement: { mode: 'global', retainSessionKeys: ['s1:stale-working'] },
            } as Parameters<typeof computeVisibleSessionListIndex>[0] & {
                workingPlacement: { mode: 'global'; retainSessionKeys: string[] };
            })!;

            expect(describeItems(result)).toEqual([
                'h:active:Active',
                'h:project:~/repo',
                's:stale-working:project:server:s1:active:project:repo',
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
            sessionListAttentionPlacementV1: 'top',
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

    it('returns a completed unread Session to its base without inventing Needs-you', () => {
        const activeGroup = 'server:s1:active:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: activeGroup },
            { type: 'session', sessionId: 'completed', serverId: 's1', section: 'active', groupKey: activeGroup, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            sessionListAttentionPlacementV1: 'top',
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
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
            workingPlacement: { mode: 'global' },
        } as Parameters<typeof computeVisibleSessionListIndex>[0] & { workingPlacement: { mode: 'global' } })!;

        expect(result.filter(item => item.type === 'session').map(item => [
            item.sessionId, item.groupKind, item.attentionPlacementReason, item.workingPlacementReason,
        ])).toEqual([['completed', 'project', undefined, undefined]]);
    });

    it('keeps pending attention in admitted traversal order regardless of request time', () => {
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
            sessionListAttentionPlacementV1: 'top',
            source,
            resolveSessionRow: makeResolver({
                's1:older-request': makeSessionRow('older-request', {
                    viewer: createSessionViewerFixture({ attention: {
                        needsAttention: true, reasons: ['permission_required'], primary: 'permission_required', presentation: 'full',
                    } }),
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    hasPendingPermissionRequests: true,
                    pendingRequestObservedAt: now - 10_000,
                    updatedAt: now,
                }),
                's1:newer-request': makeSessionRow('newer-request', {
                    viewer: createSessionViewerFixture({ attention: {
                        needsAttention: true, reasons: ['permission_required'], primary: 'permission_required', presentation: 'full',
                    } }),
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    hasPendingPermissionRequests: true,
                    pendingRequestObservedAt: now - 1_000,
                    updatedAt: now - 20_000,
                }),
                's1:blocked-pending': makeSessionRow('blocked-pending', {
                    viewer: createSessionViewerFixture({ attention: {
                        needsAttention: true, reasons: ['pending_blocked'], primary: 'pending_blocked', presentation: 'full',
                    } }),
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
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(result.flatMap(item => item.type === 'session' && item.groupKind === 'attention' ? [item.sessionId] : []))
            .toEqual(['older-request', 'newer-request', 'blocked-pending']);
        expect(result.find(item => item.type === 'session' && item.sessionId === 'blocked-pending'))
            .toMatchObject({ groupKind: 'attention', attentionPlacementReason: 'action_required' });
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
            sessionListAttentionPlacementV1: 'top',
            source,
            resolveSessionRow: makeResolver({
                's1:first-request': makeSessionRow('first-request', {
                    viewer: createSessionViewerFixture({ attention: {
                        needsAttention: true, reasons: ['permission_required'], primary: 'permission_required', presentation: 'full',
                    } }),
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    hasPendingPermissionRequests: true,
                    pendingRequestObservedAt: now - 1_000,
                    updatedAt: 100,
                }),
                's1:second-request': makeSessionRow('second-request', {
                    viewer: createSessionViewerFixture({ attention: {
                        needsAttention: true, reasons: ['permission_required'], primary: 'permission_required', presentation: 'full',
                    } }),
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
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(describeItems(result)).toEqual([
            'h:attention',
            's:first-request:attention:attention-promotion-v1',
            's:second-request:attention:attention-promotion-v1',
        ]);
    });

    it('does not invent Needs-you from unread ready or failed facts or their transition time', () => {
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
            sessionListAttentionPlacementV1: 'top',
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
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(result.some(item => item.type === 'header' && item.headerKind === 'attention')).toBe(false);
        expect(result.filter(item => item.type === 'session').map(item => item.sessionId).sort())
            .toEqual(['newer-failed', 'newer-ready', 'older-failed', 'older-ready']);
        expect(result.filter(item => item.type === 'session').every(item => item.groupKind === 'date')).toBe(true);
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
            sessionListAttentionPlacementV1: 'top',
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
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(describeItems(result)).toEqual([
            'h:date:Today',
            's:read-failed:date:server:s1:day:2026-02-17',
        ]);
    });

    it('does not invent Needs-you from active failure after diagnostic activity', () => {
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
            sessionListAttentionPlacementV1: 'top',
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
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(describeItems(result)).toEqual([
            'h:date:Today',
            's:active-failed:date:server:s1:day:2026-02-17',
        ]);
    });

    it('does not invent Needs-you from inactive unread failure after diagnostic activity', () => {
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
            sessionListAttentionPlacementV1: 'top',
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
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(describeItems(result)).toEqual([
            'h:date:Today',
            's:unread-failed:date:server:s1:day:2026-02-17',
        ]);
    });

    it('does not re-promote an acknowledged completed turn after a later non-terminal update', () => {
        const dateGroup = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: dateGroup },
            { type: 'session', sessionId: 'done', serverId: 's1', section: 'inactive', groupKey: dateGroup, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            sessionListAttentionPlacementV1: 'top',
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
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(describeItems(result)).toEqual([
            'h:date:Today',
            's:done:date:server:s1:day:2026-02-17',
        ]);
    });

    it('does not invent Needs-you or Working from unread completion with stale thinking', () => {
        const dateGroup = 'server:s1:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: dateGroup },
            { type: 'session', sessionId: 'done', serverId: 's1', section: 'inactive', groupKey: dateGroup, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            sessionListAttentionPlacementV1: 'top',
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
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(describeItems(result)).toEqual([
            'h:date:Today',
            's:done:date:server:s1:day:2026-02-17',
        ]);
    });

    it('forces inactive date groups to updated ordering in custom mode', () => {
        const groupKey = 'server:s1:inactive:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'older', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'newer', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            sessionListAttentionPlacementV1: 'inPlace',
            source,
            resolveSessionRow: makeResolver({
                's1:older': makeSessionRow('older', { createdAt: 100, updatedAt: 100, meaningfulActivityAt: 100 }),
                's1:newer': makeSessionRow('newer', { createdAt: 200, updatedAt: 200, meaningfulActivityAt: 650_000 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [groupKey]: ['s1:older', 's1:newer'] },
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const sessions = result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session');
        expect(sessions.map((session) => session.sessionId)).toEqual(['newer', 'older']);
    });

    it('uses meaningful activity order for date rows when section mode is single', () => {
        const groupKey = 'server:s1:sessions:day:2026-02-17';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'sessions', title: 'Sessions', serverId: 's1', groupKey: 'sessions:s1' },
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'newer', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'older', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListIndex({
            sessionListAttentionPlacementV1: 'inPlace',
            source,
            resolveSessionRow: makeResolver({
                's1:newer': makeSessionRow('newer', { createdAt: 200, updatedAt: 200, meaningfulActivityAt: 650_000 }),
                's1:older': makeSessionRow('older', { createdAt: 100, updatedAt: 100, meaningfulActivityAt: 100 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [groupKey]: ['s1:older', 's1:newer'] },
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const sessions = result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session');
        expect(sessions.map((session) => session.sessionId)).toEqual(['newer', 'older']);
    });

    it('builds one cross-Home Recent activity timeline after attention and working precedence', () => {
        const nowMs = 1_000_000;
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'server', title: 'Home A', serverId: 'home-a' },
            { type: 'header', headerKind: 'sessions', title: 'Sessions', serverId: 'home-a' },
            { type: 'header', headerKind: 'project', title: 'Project A', serverId: 'home-a', groupKey: 'project-a' },
            { type: 'session', sessionId: 'same', serverId: 'home-a', serverName: 'Home A', section: 'active', groupKey: 'project-a', groupKind: 'project' },
            { type: 'header', headerKind: 'server', title: 'Home B', serverId: 'home-b' },
            { type: 'header', headerKind: 'project', title: 'Project B', serverId: 'home-b', groupKey: 'project-b' },
            { type: 'session', sessionId: 'same', serverId: 'home-b', serverName: 'Home B', section: 'inactive', groupKey: 'project-b', groupKind: 'project' },
            { type: 'header', headerKind: 'project', title: 'Team work', serverId: 'home-c', groupKey: 'folder-c' },
            { type: 'session', sessionId: 'working', serverId: 'home-c', serverName: 'Home C', section: 'active', groupKey: 'folder-c', groupKind: 'project' },
            { type: 'header', headerKind: 'project', title: 'Group work', serverId: 'home-d', groupKey: 'project-d' },
            { type: 'session', sessionId: 'ready', serverId: 'home-d', serverName: 'Home D', section: 'inactive', groupKey: 'project-d', groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            sessionListAttentionPlacementV1: 'top',
            source,
            resolveSessionRow: makeResolver({
                'home-a:same': makeSessionRow('same', {
                    active: true,
                    createdAt: 10,
                    meaningfulActivityAt: 610_000,
                    updatedAt: 999_000,
                }),
                'home-b:same': makeSessionRow('same', {
                    createdAt: 20,
                    meaningfulActivityAt: 910_000,
                    updatedAt: 100,
                }),
                'home-c:working': makeSessionRow('working', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: nowMs - 1_000,
                    meaningfulActivityAt: 710_000,
                    updatedAt: 710_000,
                }),
                'home-d:ready': makeSessionRow('ready', {
                    viewer: createSessionViewerFixture({ attention: {
                        needsAttention: true, reasons: ['permission_required'], primary: 'permission_required', presentation: 'full',
                    } }),
                    seq: 2,
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 810_000,
                    latestReadyEventSeq: 2,
                    latestReadyEventAt: 810_000,
                    lastViewedSessionSeq: 1,
                    meaningfulActivityAt: 810_000,
                    updatedAt: 810_000,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['home-d:ready'],
            sessionListGroupOrderV1: {
                'project-a': ['home-a:same'],
                'project-b': ['home-b:same'],
            },
            sessionListLayoutChoice: 'recent_activity',
            attentionPlacement: { mode: 'global' },
            workingPlacement: { mode: 'global' },
            presentation: {
                enabled: true,
                presentation: 'grouped',
                selectedServerIds: ['home-a', 'home-b', 'home-c', 'home-d'],
            },
            nowMs,
        })!;

        expect(describeItems(result)).toEqual([
            'h:attention',
            's:ready:attention:attention-promotion-v1',
            'h:working',
            's:working:working:working-placement-v1',
            'h:date:Today',
            's:same:date:recent:day:1970-01-01',
            's:same:date:recent:day:1970-01-01',
        ]);
        expect(result.filter((item) => item.type === 'header').every((item) => (
            item.headerKind === 'attention'
            || item.headerKind === 'working'
            || item.headerKind === 'date'
        ))).toBe(true);
        expect(result.filter((item) => item.type === 'session' && item.sessionId === 'ready')).toEqual([
            expect.objectContaining({
                serverId: 'home-d',
                groupKind: 'attention',
                pinned: true,
            }),
        ]);
        expect(result.filter((item) => item.type === 'session' && item.sessionId === 'same').map((item) => item.serverId)).toEqual([
            'home-b',
            'home-a',
        ]);
    });

    it('keeps unresolved qualified Recent activity members in one Loading group', () => {
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'project', title: 'Project A', serverId: 'home-a', groupKey: 'project-a' },
            { type: 'session', sessionId: 'hydrated', serverId: 'home-a', section: 'active', groupKey: 'project-a', groupKind: 'project' },
            { type: 'header', headerKind: 'project', title: 'Project B', serverId: 'home-b', groupKey: 'project-b' },
            { type: 'session', sessionId: 'pending', serverId: 'home-b', section: 'active', groupKey: 'project-b', groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            sessionListAttentionPlacementV1: 'inPlace',
            source,
            resolveSessionRow: makeResolver({
                'home-a:hydrated': makeSessionRow('hydrated', {
                    active: true,
                    createdAt: 100,
                    meaningfulActivityAt: 900_000,
                    updatedAt: 900_000,
                }),
            }),
            hideInactiveSessions: true,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            sessionListLayoutChoice: 'recent_activity',
            presentation: {
                enabled: true,
                presentation: 'grouped',
                selectedServerIds: ['home-a', 'home-b'],
            },
            nowMs: 1_000_000,
        })!;

        expect(describeItems(result)).toEqual([
            'h:date:Today',
            's:hydrated:date:recent:day:1970-01-01',
            'h:loading:Loading',
            's:pending:loading:recent:loading',
        ]);
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
            sessionListAttentionPlacementV1: 'inPlace',
            source,
            resolveSessionRow: makeResolver({
                's1:newest': makeSessionRow('newest', { createdAt: 10, updatedAt: 900_000, meaningfulActivityAt: 900_000 }),
                's1:middle': makeSessionRow('middle', { createdAt: 10, updatedAt: 600_000, meaningfulActivityAt: 600_000 }),
                's1:oldest': makeSessionRow('oldest', { createdAt: 10, updatedAt: 300_000, meaningfulActivityAt: 300_000 }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [groupKey]: ['s1:oldest', 's1:newest', 's1:middle'] },
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
            sessionListAttentionPlacementV1: 'inPlace',
            source,
            resolveSessionRow: makeResolver({
                's1:new-session': makeSessionRow('new-session', { createdAt: 300, updatedAt: 300, active: true }),
                's1:older-a': makeSessionRow('older-a', { createdAt: 200, updatedAt: 200, active: true }),
                's1:older-b': makeSessionRow('older-b', { createdAt: 100, updatedAt: 100, active: true }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [groupKey]: ['s1:older-b', 's1:older-a'] },
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
            sessionListAttentionPlacementV1: 'inPlace',
            source,
            resolveSessionRow: makeResolver({
                's1:in-folder': makeSessionRow('in-folder', { active: true }),
                's1:at-root': makeSessionRow('at-root', { active: true }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [rootFolderGroupKey]: ['s1:at-root', folderOrderKey('planning')] },
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : item.type === 'session' ? `s:${item.sessionId}` : `r:${item.runId}`
        ))).toEqual([
            'h:active:Active',
            'h:project:~/repo',
            'h:folder:Planning',
            's:in-folder',
            's:at-root',
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
            sessionListAttentionPlacementV1: 'inPlace',
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
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const pinnedSessions = result.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => (
            item.type === 'session' && item.groupKind === 'pinned'
        ));
        expect(pinnedSessions.map((session) => session.sessionId)).toEqual(['pinned-first', 'fallback-b', 'fallback-a']);
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
            sessionListAttentionPlacementV1: 'inPlace',
            source,
            resolveSessionRow: makeResolver({
                's1:active': makeSessionRow('active', { active: true }),
                's1:inactive': makeSessionRow('inactive', { active: false }),
            }),
            hideInactiveSessions: true,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind}:${item.title}`
            : item.type === 'session' ? `s:${item.sessionId}:${item.section ?? 'unknown'}` : `r:${item.runId}`
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
            sessionListAttentionPlacementV1: 'inPlace',
            source,
            resolveSessionRow: makeResolver({
                's1:active-a': makeSessionRow('active-a', { active: true }),
                's1:inactive-b': makeSessionRow('inactive-b'),
                's1:active-c': makeSessionRow('active-c', { active: true }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [groupKey]: ['s1:inactive-b', 's1:active-c', 's1:active-a'] },
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

    it('keeps archived inactive rows without inventing attention from unread completion', () => {
        const groupKey = 'server:s1:inactive:project:repo';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'inactive', title: 'Inactive', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: 'Repo', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'archived-action', serverId: 's1', section: 'inactive', groupKey, groupKind: 'project' },
        ];

        const result = computeVisibleSessionListIndex({
            sessionListAttentionPlacementV1: 'top',
            source,
            corpusStorage: 'archived',
            resolveSessionRow: makeResolver({
                's1:archived-action': makeSessionRow('archived-action', {
                    archivedAt: 1,
                    seq: 2,
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 50,
                    meaningfulActivityAt: 50,
                    lastTurnCompletedAt: 50,
                    lastViewedSessionSeq: 1,
                    updatedAt: 100,
                }),
            }),
            hideInactiveSessions: true,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPlacement: { mode: 'global' },
        })!;

        expect(describeItems(result)).toEqual([
            'h:inactive:Inactive',
            'h:project:Repo',
            's:archived-action:project:server:s1:inactive:project:repo',
        ]);
    });
});
