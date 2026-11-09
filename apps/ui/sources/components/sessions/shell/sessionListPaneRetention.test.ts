import { afterEach, describe, expect, it } from 'vitest';

import {
    readRetainedSessionListPaneState,
    readActiveRetainedSessionListReferenceCorpus,
    releaseRetainedSessionListPaneState,
    resetSessionListPaneRetentionForTests,
    retainSessionListPaneState,
    useActiveRetainedSessionListQueryStates,
} from './sessionListPaneRetention';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';

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
