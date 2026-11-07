import { describe, expect, it } from 'vitest';

import type { SessionListQueryHomeState } from '@/sync/domains/session/listing/sessionListQueryController';

import {
    readSessionListSearchCorpusSessionIdsForHome,
    resolveSessionListSearchCorpus,
    reuseSessionListSearchCorpus,
} from './sessionListSearchCorpus';
import { sessionTagKey } from '../sessionTagUtils';

function homeState(
    overrides: Partial<SessionListQueryHomeState> & Pick<SessionListQueryHomeState, 'appliedQueryKey'>,
): SessionListQueryHomeState {
    return {
        requestedQueryKey: overrides.appliedQueryKey ?? '',
        addresses: [],
        nextCursor: null,
        hasNext: false,
        attentionNextCursor: null,
        attentionHasNext: false,
        phase: 'ready',
        freshnessAt: 1,
        homeObservation: { phase: overrides.phase ?? 'ready', lastSuccessAt: overrides.freshnessAt === undefined ? 1 : overrides.freshnessAt },
        failureReason: null,
        failureCode: null,
        appliedSourceKind: overrides.appliedQueryKey === null ? null : 'query',
        ...overrides,
    };
}

describe('resolveSessionListSearchCorpus', () => {
    it('admits only addresses applied under the currently requested corpus identity', () => {
        const corpus = resolveSessionListSearchCorpus({
            query: {
                homes: [{ serverId: 'home-a', queryKey: 'query-b' }],
                statesByServerId: {
                    'home-a': homeState({
                        appliedQueryKey: 'query-a',
                        addresses: [{ serverId: 'home-a', sessionId: 'stale-match' }],
                    }),
                },
            },
        });

        expect(corpus.sessionKeys.has('home-a:stale-match')).toBe(false);
        expect(corpus.homes).toEqual([]);
    });

    it('admits the applied addresses of each selected Home and keeps Homes distinct', () => {
        const corpus = resolveSessionListSearchCorpus({
            query: {
                homes: [
                    { serverId: 'home-a', queryKey: 'query-b' },
                    { serverId: 'home-b', queryKey: 'query-b' },
                ],
                statesByServerId: {
                    'home-a': homeState({
                        appliedQueryKey: 'query-b',
                        addresses: [
                            { serverId: 'home-a', sessionId: 'shared-id' },
                            // A foreign address can never be admitted under another Home.
                            { serverId: 'home-b', sessionId: 'leaked' },
                        ],
                        phase: 'offline',
                    }),
                    'home-b': homeState({
                        appliedQueryKey: 'query-b',
                        addresses: [{ serverId: 'home-b', sessionId: 'shared-id' }],
                    }),
                },
            },
        });

        expect([...corpus.sessionKeys].sort()).toEqual([
            sessionTagKey('home-a', 'shared-id'),
            sessionTagKey('home-b', 'shared-id'),
        ].sort());
        expect(readSessionListSearchCorpusSessionIdsForHome(corpus, 'home-a')).toEqual(['shared-id']);
        expect(readSessionListSearchCorpusSessionIdsForHome(corpus, 'home-b')).toEqual(['shared-id']);
    });

    it('resolves an unknown or unselected Home to an explicit empty eligibility', () => {
        const corpus = resolveSessionListSearchCorpus({
            query: {
                homes: [{ serverId: 'home-a', queryKey: 'query-a' }],
                statesByServerId: {
                    'home-a': homeState({
                        appliedQueryKey: 'query-a',
                        addresses: [{ serverId: 'home-a', sessionId: 's1' }],
                    }),
                },
            },
        });

        expect(readSessionListSearchCorpusSessionIdsForHome(corpus, 'home-z')).toEqual([]);
        expect(readSessionListSearchCorpusSessionIdsForHome(corpus, '')).toEqual([]);
    });

    it('uses the canonical ordinary membership when no paging owner is mounted', () => {
        const corpus = resolveSessionListSearchCorpus({
            ordinary: {
                serverIds: ['home-a', 'home-a', 'home-b'],
                membershipByServerId: {
                    'home-a': ['s1', 's1', 's2'],
                    'home-c': ['not-selected'],
                },
            },
        });

        expect(corpus.homes).toEqual([{ serverId: 'home-a', sessionIds: ['s1', 's2'] }]);
        expect(corpus.sessionKeys.has('home-c:not-selected')).toBe(false);
    });

    it('reuses the previous corpus when membership content is unchanged', () => {
        const build = () => resolveSessionListSearchCorpus({
            ordinary: {
                serverIds: ['home-a'],
                membershipByServerId: { 'home-a': ['s1', 's2'] },
            },
        });
        const first = build();
        expect(reuseSessionListSearchCorpus(first, build())).toBe(first);

        const changed = resolveSessionListSearchCorpus({
            ordinary: {
                serverIds: ['home-a'],
                membershipByServerId: { 'home-a': ['s1', 's3'] },
            },
        });
        expect(reuseSessionListSearchCorpus(first, changed)).toBe(changed);
    });
});
