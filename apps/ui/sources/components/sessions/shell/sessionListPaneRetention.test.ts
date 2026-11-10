import { afterEach, describe, expect, it } from 'vitest';

import {
    readRetainedSessionListPaneState,
    readActiveRetainedSessionListReferenceCorpus,
    releaseRetainedSessionListPaneState,
    resetSessionListPaneRetentionForTests,
    retainSessionListPaneState,
    useActiveRetainedSessionListQueryStates,
    projectSessionListNeedsYou,
    useActiveRetainedSessionListNeedsYou,
    readActiveRetainedSessionListNeedsYou,
    setRetainedSessionListPaneReferenceCorpusActive,
} from './sessionListPaneRetention';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionListGlobalPlacements } from '@/sync/domains/session/listing/sessionListAttentionPlacement';
import { createSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';

function paneState(sessionCount: number) {
    return {
        summary: { sessionsReady: true, sessionCount },
        visibleSessionListIndex: [],
        hasHiddenInactiveSessions: false,
        
        folderFeatureEnabledServerIds: [],
        showLoading: false,
        showEmptyState: false,
    } as const;
}

afterEach(() => resetSessionListPaneRetentionForTests());

describe('session list pane retention identity', () => {
    it('excludes a held shelf slot after the canonical placement owner removes its current request', () => {
        const source: SessionListIndexItem[] = [{ type: 'session', serverId: 'home-a', sessionId: 'held' }];
        let session = createSessionFixture({ id: 'held', serverId: 'home-a', pendingBlockedCount: 1,
            viewer: createSessionViewerFixture({ attention: {
                needsAttention: true, reasons: ['pending_blocked'], primary: 'pending_blocked', presentation: 'full',
            } }),
        });
        const project = (previousPresentedIndex?: readonly SessionListIndexItem[], holdMembership = false) => buildSessionListGlobalPlacements({
            source, placement: 'both', previousPresentedIndex, holdMembership,
            attentionOptions: { mode: 'global' }, workingOptions: { mode: 'global' }, nowMs: 1_000,
            resolveSessionRow: () => buildSessionListRenderableFromSession(session),
        })!;
        const initial = project();
        session = { ...session, pendingBlockedCount: 0, viewer: createSessionViewerFixture({ attention: {
            needsAttention: false, reasons: [], primary: null, presentation: 'full',
        } }) };
        const held = project(initial.attentionItems, true);
        expect(held.attentionItems).toEqual([
            expect.objectContaining({ type: 'header', eligibleCount: 0 }),
            expect.objectContaining({ type: 'session', occurrenceRole: 'needsYou' }),
        ]);
        expect(held.attentionItems[1]).not.toHaveProperty('attentionPlacementReason');
        expect(projectSessionListNeedsYou({ visibleSessionListIndex: held.attentionItems, showLoading: false,
            filterResult: { matchedCount: 1, coverage: 'complete' } })).toEqual({ count: 0, items: [], incomplete: false });
    });
    it('keeps the sidebar header total honest when its navigable rows are collapsed or unavailable', () => {
        const index: SessionListIndexItem[] = [{ type: 'header', headerKind: 'attention', title: 'Needs you', eligibleCount: 10 }];
        expect(projectSessionListNeedsYou({ visibleSessionListIndex: index, showLoading: false,
            filterResult: { matchedCount: 10, coverage: 'complete' } })).toEqual({ count: 10, items: [], incomplete: true });
        expect(projectSessionListNeedsYou({ visibleSessionListIndex: null, showLoading: false })).toBeNull();
    });

    it('pushes changed shelf membership to Brief without waking query-retention consumers or unrelated row writes', async () => {
        const identity = { storageKind: 'all' as const, pathname: '/', sourceScopeKey: 'sidebar-account' };
        const retain = (id: string, title = id) => retainSessionListPaneState({ ...identity,
            queryMembershipActive: true, referenceCorpusActive: true,
            paneState: { ...paneState(1), filterResult: { matchedCount: 1, coverage: 'complete' }, visibleSessionListIndex: [
                { type: 'header', headerKind: 'attention', title, eligibleCount: 1 },
                { type: 'session', serverId: 'home-a', sessionId: id, occurrenceRole: 'needsYou', attentionPlacementReason: 'action_required' },
            ] },
        });
        retain('first');
        let queryRenders = 0;
        let shelfRenders = 0;
        const query = await renderHook(() => { queryRenders += 1; return useActiveRetainedSessionListQueryStates(); });
        const shelf = await renderHook(() => { shelfRenders += 1; return useActiveRetainedSessionListNeedsYou(); });
        try {
            const initialQueryRenders = queryRenders;
            const initialShelfRenders = shelfRenders;
            await act(async () => { retain('first', 'Updated display only'); });
            expect(shelfRenders).toBe(initialShelfRenders);
            await act(async () => { retain('replacement'); });
            expect(shelf.getCurrent()).toMatchObject({ count: 1, items: [{ sessionId: 'replacement' }], incomplete: false });
            expect(shelfRenders - initialShelfRenders).toBe(1);
            expect(queryRenders).toBe(initialQueryRenders);
            const other = { ...identity, sourceScopeKey: 'other-sidebar-account' };
            await act(async () => { retainSessionListPaneState({ ...other, paneState: paneState(0), queryMembershipActive: true,
                referenceCorpusActive: true }); });
            expect(readActiveRetainedSessionListNeedsYou()).toBeNull();
            await act(async () => { setRetainedSessionListPaneReferenceCorpusActive(other, false); });
            expect(shelf.getCurrent()?.items).toMatchObject([{ sessionId: 'replacement' }]);
        } finally { await shelf.unmount(); await query.unmount(); }
    });
    it('keeps ordinary rows visible without promoting released GET exhaustion to strict corpus completeness', () => {
        const identity = { storageKind: 'all' as const, pathname: '/', sourceScopeKey: 'account-a' };
        retainSessionListPaneState({
            ...identity,
            paneState: paneState(1),
            queryMembershipActive: true,
            referenceCorpusActive: true,
            selectedServerIds: ['home-a'],
        });

        expect(readActiveRetainedSessionListReferenceCorpus({
            ordinaryMembershipByServerId: { 'home-a': ['ordinary-row'] },
        })).toEqual({
            addresses: [{ serverId: 'home-a', sessionId: 'ordinary-row' }],
            selectedServerIds: ['home-a'],
            coverage: 'incomplete',
        });
    });

    it('keeps control-character-bearing path and scope tuples distinct', () => {
        const first = { storageKind: 'all' as const, pathname: '/team\u0000alpha', sourceScopeKey: 'beta\u0001gamma' };
        const second = { storageKind: 'all' as const, pathname: '/team', sourceScopeKey: 'alpha\u0000beta\u0001gamma' };

        retainSessionListPaneState({ ...first, paneState: paneState(1), queryMembershipActive: false });
        retainSessionListPaneState({ ...second, paneState: paneState(2), queryMembershipActive: false });

        expect(readRetainedSessionListPaneState(first)?.paneState.summary.sessionCount).toBe(1);
        expect(readRetainedSessionListPaneState(second)?.paneState.summary.sessionCount).toBe(2);
    });

    it('releases exactly one removed navigation entry without clearing its neighbor', () => {
        const removed = { storageKind: 'all' as const, pathname: '/recent', sourceScopeKey: 'account-a' };
        const retained = { storageKind: 'all' as const, pathname: '/team', sourceScopeKey: 'account-a' };
        retainSessionListPaneState({ ...removed, paneState: paneState(1), queryMembershipActive: false });
        retainSessionListPaneState({ ...retained, paneState: paneState(2), queryMembershipActive: false });

        expect(releaseRetainedSessionListPaneState(removed)).toBe(true);

        expect(readRetainedSessionListPaneState(removed)).toBeNull();
        expect(readRetainedSessionListPaneState(retained)).not.toBeNull();
    });

    it('re-renders a Session route only when retained query membership changes, not when a row in that query changes', async () => {
        // P03-ARRIVAL-STORM: live, every row write rebuilt the pane's query object (it carries the row
        // index), so the open Session's route layout re-rendered 17 times in a 35 s arrival window.
        const identity = { storageKind: 'all' as const, pathname: '/', sourceScopeKey: 'account-a' };
        const homeState = (sessionId: string, freshnessAt: number) => ({ requestedQueryKey: 'q', appliedQueryKey: 'q', phase: 'ready',
            freshnessAt, homeObservation: { observedAt: freshnessAt }, addresses: [{ serverId: 'home-a', sessionId }] });
        const statesByServerId = { 'home-a': homeState('s1', 1) };
        const retainQuery = (states: object, rowRevision: number) => retainSessionListPaneState({
            ...identity,
            paneState: { ...paneState(1), query: { active: true, coverageComplete: true, statesByServerId: states,
                source: [{ id: 's1', rowRevision }], byServerId: { 'home-a': [{ id: 's1', rowRevision }] } } } as never,
            queryMembershipActive: true,
            referenceCorpusActive: true,
            selectedServerIds: ['home-a'],
        });
        retainQuery(statesByServerId, 0);
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useActiveRetainedSessionListQueryStates(); });
        try {
            const initial = renders;
            for (let revision = 1; revision <= 5; revision += 1) await act(async () => { retainQuery(statesByServerId, revision); });
            expect(renders - initial, 'row writes inside an unchanged query membership').toBe(0);
            for (let stamp = 2; stamp <= 4; stamp += 1) await act(async () => { retainQuery({ 'home-a': homeState('s1', stamp) }, 5 + stamp); });
            expect(renders - initial, 'revalidation stamps on the same admitted membership').toBe(0);
            const moved = { 'home-a': homeState('s2', 5) };
            await act(async () => { retainQuery(moved, 6); });
            expect(renders - initial, 'a membership change still reaches the route').toBe(1);
            expect(hook.getCurrent()).toEqual([moved['home-a']]);
        } finally { await hook.unmount(); }
    });
});
