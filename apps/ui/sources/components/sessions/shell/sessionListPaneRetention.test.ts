import { afterEach, describe, expect, it } from 'vitest';

import {
    readRetainedSessionListPaneState,
    readActiveRetainedSessionListReferenceCorpus,
    releaseRetainedSessionListPaneState,
    resetSessionListPaneRetentionForTests,
    retainSessionListPaneState,
} from './sessionListPaneRetention';

function paneState(sessionCount: number) {
    return {
        summary: { sessionsReady: true, sessionCount },
        visibleSessionListIndex: [],
        hasHiddenInactiveSessions: false,
        folderFocus: null,
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
});
