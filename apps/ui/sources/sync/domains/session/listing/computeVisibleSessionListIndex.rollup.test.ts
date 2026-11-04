import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { filterCollapsedSessionListItems } from '@/components/sessions/shell/filterCollapsedSessionListItems';
import { computeVisibleSessionListProjection, type ComputeVisibleSessionListIndexParams } from './computeVisibleSessionListIndex';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

describe('visible Session group rollup wiring', () => {
    const nowMs = 1_000_000;
    const source: SessionListIndexItem[] = [
        { type: 'header', title: 'One', groupKey: 'one', workspaceKey: 'one', serverId: 'home', headerKind: 'project' },
        { type: 'session', sessionId: 'permission', serverId: 'home', groupKey: 'one', groupKind: 'project' },
        { type: 'header', title: 'Two', groupKey: 'two', workspaceKey: 'two', serverId: 'home', headerKind: 'project' },
        { type: 'session', sessionId: 'working', serverId: 'home', groupKey: 'two', groupKind: 'project' },
    ];
    const permission = createSessionListRenderableSessionFixture({ id: 'permission', active: true, activeAt: nowMs,
        hasPendingPermissionRequests: true, pendingRequestObservedAt: nowMs });
    const working = createSessionListRenderableSessionFixture({ id: 'working', active: true, activeAt: nowMs,
        thinking: true, thinkingAt: nowMs, latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: nowMs });
    const input: ComputeVisibleSessionListIndexParams = { source, nowMs, hideInactiveSessions: false,
        pinnedSessionKeysV1: [], sessionListGroupOrderV1: {}, sessionListAttentionPlacementV1: 'inPlace',
        presentation: { enabled: false, presentation: 'grouped' },
        resolveSessionRow: (_serverId, id) => id === 'permission' ? permission : working };

    it.each(['one', 'two'])('reconciles equal-count archive/create source churn into group %s with retained held rows', (groupKey) => {
        const retained = { ...working, id: 'retained' };
        const added = { ...working, id: 'added', thinking: false, latestTurnStatus: 'failed' as const };
        const removed = { ...working, id: 'removed' };
        const rows = new Map([retained, added, removed].map(row => [row.id, row]));
        const member = (sessionId: string, group: string): SessionListIndexItem => ({ type: 'session',
            serverId: 'home', sessionId, groupKey: group, groupKind: 'project' });
        const heldSource = [member('retained', 'one'), member('removed', 'two'), member('added', groupKey)];
        const params = { ...input, includeNeedsYouEverywhere: true, attentionSource: heldSource,
            resolveSessionRow: (_home: string | null | undefined, id: string) => rows.get(id) ?? null,
            source: [source[0]!, heldSource[0]!, source[2]!, heldSource[1]!] };
        const first = computeVisibleSessionListProjection(params);
        const nextSource = groupKey === 'one'
            ? [source[0]!, heldSource[0]!, heldSource[2]!]
            : [source[0]!, heldSource[0]!, source[2]!, heldSource[2]!];
        const next = computeVisibleSessionListProjection({ ...params, source: nextSource,
            previousMembership: first.membership, previousPresentedIndex: first.items });
        const fresh = computeVisibleSessionListProjection({ ...params, source: nextSource, previousPresentedIndex: first.items });
        expect(next.membership.sessions.size).toBe(first.membership.sessions.size);
        expect(next.items).toEqual(fresh.items);
        expect(next.membership.groupSubjects?.has('session:["home","removed"]')).toBe(false);
        expect(next.membership.groupSubjects?.has('session:["home","added"]')).toBe(true);
        expect(next.membership.groupRollups?.memberKeysByHeaderId).toEqual(fresh.membership.groupRollups?.memberKeysByHeaderId);
    });

    it('proves header positions against the actual previous presentation when project order changes', () => {
        const third: SessionListIndexItem = { type: 'session', sessionId: 'third', serverId: 'home', groupKey: 'one', groupKind: 'project' };
        const params = { ...input, source: [source[0]!, source[1]!, third, source[2]!, source[3]!] };
        const first = computeVisibleSessionListProjection(params);
        const previousPresentedIndex = [source[2]!, source[3]!, source[0]!, source[1]!, third];
        const fresh = computeVisibleSessionListProjection({ ...params, previousPresentedIndex });
        expect(fresh.items?.[0]).toMatchObject({ type: 'header', groupKey: 'two' });
        const next = computeVisibleSessionListProjection({ ...params, previousMembership: first.membership, previousPresentedIndex });
        expect(next.items).toEqual(fresh.items);
        expect(next.membership.groupRollups?.memberKeysByHeaderId).toEqual(fresh.membership.groupRollups?.memberKeysByHeaderId);
    });

    it('rebuilds date group membership when a Run activity update moves it into another day', () => {
        const today = new Date(2026, 9, 24, 12).toISOString();
        const yesterday = new Date(2026, 9, 23, 12).toISOString();
        const runs = [createWorkflowRunSummaryFixture({ id: 'newer', startedBy: 'user', updatedAt: today }),
            createWorkflowRunSummaryFixture({ id: 'older', startedBy: 'user', updatedAt: yesterday })];
        const params = { ...input, source: [], sessionListLayoutChoice: 'recent_activity' as const,
            workFilter: normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['home'], show: 'runs' }),
            viewerAccountIdByServerId: new Map([['home', 'account-1']]),
            workflowRuns: runs.map(summary => ({ serverId: 'home', summary })) };
        const first = computeVisibleSessionListProjection(params);
        expect(first.items?.filter(item => item.type === 'header')).toHaveLength(2);
        const nextParams = { ...params, workflowRuns: [{ serverId: 'home', summary: runs[0]! },
            { serverId: 'home', summary: { ...runs[1]!, updatedAt: today } }] };
        const fresh = computeVisibleSessionListProjection(nextParams);
        expect(fresh.items?.filter(item => item.type === 'header')).toHaveLength(1);
        const next = computeVisibleSessionListProjection({ ...nextParams, previousMembership: first.membership,
            previousPresentedIndex: first.items });
        expect(next.items).toEqual(fresh.items);
        expect(next.membership.groupRollups?.memberKeysByHeaderId).toEqual(fresh.membership.groupRollups?.memberKeysByHeaderId);
    });

    it('carries unavailable filter facts into the admitted group coverage', () => {
        const projection = computeVisibleSessionListProjection({ ...input,
            source: [source[0]!, { type: 'session', sessionId: 'working', serverId: 'home', groupKey: 'one', groupKind: 'project' },
                { type: 'session', sessionId: 'missing', serverId: 'home', groupKey: 'one', groupKind: 'project' }],
            workFilter: normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['home'],
                startedBy: ['you', 'triggers', 'agents'], statuses: ['thinking'] }),
            resolveSessionRow: (_serverId, id) => id === 'working' ? working : null,
        });
        expect(projection.filterResult.coverage).toBe('partial');
        expect(projection.items?.find(item => item.type === 'header')).toMatchObject({ rollup: { coverage: 'partial' } });
    });

    it('projects the real admitted status before collapse and retains unrelated group identity on a child change', () => {
        const first = computeVisibleSessionListProjection(input);
        const firstHeaders = first.items!.filter(item => item.type === 'header');
        expect(firstHeaders[0]).toMatchObject({ rollup: { status: { state: 'permission_required' }, needsYouCount: 1, coverage: 'complete' } });
        const collapsed = filterCollapsedSessionListItems(first.items!, { one: true });
        expect(collapsed[0]).toBe(firstHeaders[0]);
        expect(collapsed.some(item => item.type === 'session' && item.sessionId === 'permission')).toBe(false);

        const answered = { ...permission, hasPendingPermissionRequests: false, pendingRequestObservedAt: null };
        const next = computeVisibleSessionListProjection({ ...input, previousMembership: first.membership,
            previousPresentedIndex: first.items, resolveSessionRow: (_serverId, id) => id === 'permission' ? answered : working });
        const nextHeaders = next.items!.filter(item => item.type === 'header');
        expect(nextHeaders[0]).toMatchObject({ rollup: { needsYouCount: 0 } });
        expect(nextHeaders[1]).toBe(firstHeaders[1]);
        expect(next.membership.groupRollups?.memberKeysByHeaderId).toBe(first.membership.groupRollups?.memberKeysByHeaderId);
        expect(next.membership.groupSubjects?.get('session:["home","working"]'))
            .toBe(first.membership.groupSubjects?.get('session:["home","working"]'));
    });
});
