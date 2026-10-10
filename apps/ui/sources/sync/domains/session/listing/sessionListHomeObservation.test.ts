import { describe, expect, it } from 'vitest';

import type { SessionListQueryHomeState } from './sessionListQueryController';
import {
    buildSessionListHomeObservations,
    isSessionListQueryHomeCoverageComplete,
    resolveOrdinarySessionListCoverage,
} from './sessionListHomeObservation';

function queryState(
    phase: SessionListQueryHomeState['phase'],
    freshnessAt: number | null,
): SessionListQueryHomeState {
    return {
        requestedQueryKey: 'query',
        appliedQueryKey: 'query',
        addresses: [],
        nextCursor: null,
        hasNext: false,
        attentionNextCursor: null,
        attentionHasNext: false,
        phase,
        freshnessAt,
        failureReason: null,
        failureCode: null,
        appliedSourceKind: 'query',
    };
}

describe('buildSessionListHomeObservations', () => {
    it('merges active query and concurrent runtime observations by exact Home without retargeting on focus change', () => {
        const concurrent = {
            'home-b': {
                serverName: 'Home B',
                listObservation: { phase: 'offline' as const, lastSuccessAt: 2_000 },
            },
        };

        const activeA = buildSessionListHomeObservations({
            concurrentSessionListCacheByServerId: concurrent,
            queryStatesByServerId: { 'home-a': queryState('ready', 1_000) },
        });
        expect(activeA).toEqual({
            'home-a': { phase: 'ready', lastSuccessAt: 1_000 },
            'home-b': { phase: 'offline', lastSuccessAt: 2_000 },
        });

        const activeB = buildSessionListHomeObservations({
            concurrentSessionListCacheByServerId: concurrent,
            queryStatesByServerId: { 'home-a': queryState('offline', 1_000) },
        });
        expect(activeB).toEqual({
            'home-a': { phase: 'offline', lastSuccessAt: 1_000 },
            'home-b': { phase: 'offline', lastSuccessAt: 2_000 },
        });
        expect(activeB['home-a']).not.toBe(activeB['home-b']);
    });

    it.each([
        ['network', 'network'],
        ['access denial', 'access_denied'],
        ['non-advancing cursor', 'cursor_not_advancing'],
    ] as const)('keeps an applied query %s failure authoritative over an ordinary ready observation', (_label, failureReason) => {
        const concurrent = {
            'home-a': {
                serverName: 'Home A',
                listObservation: { phase: 'ready' as const, lastSuccessAt: 1_000 },
            },
        };

        const failedQuery = {
            ...queryState('error', null),
            failureReason,
            failureCode: failureReason,
        };

        const observations = buildSessionListHomeObservations({
            concurrentSessionListCacheByServerId: concurrent,
            queryStatesByServerId: { 'home-a': failedQuery },
        });

        expect(observations['home-a']).toEqual({ phase: 'error', lastSuccessAt: 1_000 });
    });
});

describe('resolveOrdinarySessionListCoverage', () => {
    const completeInput = {
        serverId: 'home-a',
        hasFetchedSnapshot: true,
        phase: 'ready' as const,
        fetchInFlight: false,
        fetchMoreInFlight: false,
        hasNext: false,
        attentionHasNext: false,
    };

    it('requires both ordinary and attention continuation families to be exhausted', () => {
        expect(resolveOrdinarySessionListCoverage(completeInput)).toBe('complete');
        expect(resolveOrdinarySessionListCoverage({ ...completeInput, hasNext: true })).toBe('incomplete');
        expect(resolveOrdinarySessionListCoverage({ ...completeInput, attentionHasNext: true })).toBe('incomplete');
    });

    it('keeps exhausted historical metadata omissions incomplete', () => {
        const observed = { ...completeInput, metadataUpgradeRequiredCount: 1 };
        expect(resolveOrdinarySessionListCoverage(observed)).toBe('incomplete');
        expect(resolveOrdinarySessionListCoverage({ ...observed, metadataUpgradeRequiredCount: 0 })).toBe('complete');
    });

    it('does not promote a stale, refreshing, or never-fetched membership to complete', () => {
        expect(resolveOrdinarySessionListCoverage({ ...completeInput, phase: 'error' })).toBe('incomplete');
        expect(resolveOrdinarySessionListCoverage({ ...completeInput, fetchInFlight: true })).toBe('incomplete');
        expect(resolveOrdinarySessionListCoverage({ ...completeInput, hasFetchedSnapshot: false })).toBe('incomplete');
    });
});

describe('Bot metadata coverage', () => {
    it('does not certify an exhausted candidate corpus while authorized marker metadata remains unavailable', () => {
        const state = { ...queryState('ready', 1), addresses: [
            { serverId: 'home-a', sessionId: 'marked' }, { serverId: 'home-a', sessionId: 'locked' },
        ] };
        const input = { state, requestedQueryKey: 'query', bot: 'bot' as const,
            rowsBySessionId: { marked: { metadata: { bot: { kind: 'bot' } } }, locked: { metadata: null } } };
        expect(isSessionListQueryHomeCoverageComplete(input)).toBe(false);
        expect(isSessionListQueryHomeCoverageComplete({ ...input,
            rowsBySessionId: { ...input.rowsBySessionId, locked: { metadata: {} } },
        })).toBe(true);
        expect(isSessionListQueryHomeCoverageComplete({ state, requestedQueryKey: 'query' })).toBe(true);
    });
});

describe('isSessionListQueryHomeCoverageComplete', () => {
    it('keeps exhausted historical metadata omissions incomplete until a clean refresh', () => {
        const state = { ...queryState('ready', 1_000), metadataUpgradeRequiredCount: 1 };
        expect(isSessionListQueryHomeCoverageComplete({ state, requestedQueryKey: 'query' })).toBe(false);
        expect(isSessionListQueryHomeCoverageComplete({
            state: { ...state, metadataUpgradeRequiredCount: 0 }, requestedQueryKey: 'query',
        })).toBe(true);
    });

    it('requires the applied membership to come from the strict query', () => {
        const state = queryState('ready', 1_000);
        expect(isSessionListQueryHomeCoverageComplete({ state, requestedQueryKey: 'query' })).toBe(true);
        expect(isSessionListQueryHomeCoverageComplete({
            state: { ...state, appliedSourceKind: 'ordinary' },
            requestedQueryKey: 'query',
        })).toBe(false);
    });
});
