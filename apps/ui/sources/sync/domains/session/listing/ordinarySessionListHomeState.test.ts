import { describe, expect, it } from 'vitest';

import { buildOrdinarySessionListHomeState, type OrdinarySessionListLifecycle } from './ordinarySessionListHomeState';
import { resolveSessionListQueryPresentation } from './sessionListIndexPresentation';

function lifecycle(overrides?: Partial<OrdinarySessionListLifecycle>): OrdinarySessionListLifecycle {
    return {
        serverId: 'home-a',
        hasFetchedSnapshot: true,
        fetchInFlight: false,
        fetchMoreInFlight: false,
        frontier: {
            nextCursor: 'cursor-2',
            hasNext: true,
            attentionNextCursor: null,
            attentionHasNext: false,
        },
        ...overrides,
    };
}

describe('buildOrdinarySessionListHomeState', () => {
    it.each(['response', 'invalid_query', 'access_denied'] as const)('preserves an admitted %s failure during Home settlement', failureReason => {
        const observation = { phase: 'error' as const, lastSuccessAt: 1_700,
            failure: { reason: failureReason, code: 'ordinary_list_failed' } };
        const state = buildOrdinarySessionListHomeState({ serverId: 'home-a', requestedQueryKey: 'ordinary',
            sessionIds: ['s1'], observation, lifecycle: lifecycle(), online: true });
        expect(state.failureReason).toBe(failureReason);
        expect(state.failureCode).toBe('ordinary_list_failed');
        expect(resolveSessionListQueryPresentation({ selectedServerIds: ['home-a'], statesByServerId: { 'home-a': state },
            coverageComplete: false, retainedRowCount: 1, settlingHomeServerId: 'home-a',
        })).toEqual({ kind: 'error', retainedRows: true });
    });

    it('does not let socket recovery or promise cleanup mask an admitted response failure', () => {
        const observation = { phase: 'error' as const, lastSuccessAt: 1_700,
            failure: { reason: 'response' as const, code: 'invalid_response' } };
        const state = buildOrdinarySessionListHomeState({ serverId: 'home-a', requestedQueryKey: 'ordinary',
            sessionIds: ['s1'], observation, lifecycle: lifecycle({ fetchInFlight: true }), online: false });
        expect(state.phase).toBe('error');
        expect(resolveSessionListQueryPresentation({ selectedServerIds: ['home-a'], statesByServerId: { 'home-a': state },
            coverageComplete: false, retainedRowCount: 1, settlingHomeServerId: 'home-a',
        })).toEqual({ kind: 'error', retainedRows: true });
    });

    it('publishes Sync membership and Sync cursors as the applied ordinary corpus', () => {
        const state = buildOrdinarySessionListHomeState({
            serverId: 'home-a',
            requestedQueryKey: 'query:home-a',
            sessionIds: ['s1', 's2', 's3'],
            observation: { phase: 'ready', lastSuccessAt: 1_700 },
            lifecycle: lifecycle(),
            online: true,
        });

        expect(state.addresses).toEqual([
            { serverId: 'home-a', sessionId: 's1' },
            { serverId: 'home-a', sessionId: 's2' },
            { serverId: 'home-a', sessionId: 's3' },
        ]);
        expect(state.appliedQueryKey).toBe('query:home-a');
        expect(state.nextCursor).toBe('cursor-2');
        expect(state.hasNext).toBe(true);
        expect(state.phase).toBe('ready');
        expect(state.freshnessAt).toBe(1_700);
        // A released GET cannot answer the strict query's structural selection.
        expect(state.appliedSourceKind).toBe('ordinary');
        expect(state.failureReason).toBeNull();
    });

    it('stays refreshing with its retained rows while Sync replaces the corpus', () => {
        const state = buildOrdinarySessionListHomeState({
            serverId: 'home-a',
            requestedQueryKey: 'query:home-a',
            sessionIds: ['s1', 's2'],
            observation: { phase: 'refreshing', lastSuccessAt: 1_700 },
            lifecycle: lifecycle({ fetchInFlight: true }),
            online: true,
        });

        expect(state.phase).toBe('refreshing');
        expect(state.addresses.map((address) => address.sessionId)).toEqual(['s1', 's2']);
    });

    it('loads rather than refreshes before this Home has produced a list', () => {
        const state = buildOrdinarySessionListHomeState({
            serverId: 'home-a',
            requestedQueryKey: 'query:home-a',
            sessionIds: [],
            observation: { phase: 'loading', lastSuccessAt: null },
            lifecycle: lifecycle({ hasFetchedSnapshot: false, fetchInFlight: true }),
            online: true,
        });

        expect(state.phase).toBe('loading');
        expect(state.appliedQueryKey).toBeNull();
    });

    it('reports the Home offline only from its own transport, never from an aborted page', () => {
        const offline = buildOrdinarySessionListHomeState({
            serverId: 'home-a',
            requestedQueryKey: 'query:home-a',
            sessionIds: ['s1'],
            observation: { phase: 'ready', lastSuccessAt: 1_700 },
            lifecycle: lifecycle(),
            online: false,
        });
        expect(offline.phase).toBe('offline');

        const failed = buildOrdinarySessionListHomeState({
            serverId: 'home-a',
            requestedQueryKey: 'query:home-a',
            sessionIds: ['s1'],
            observation: { phase: 'error', lastSuccessAt: 1_700, failure: { reason: 'network', code: null } },
            lifecycle: lifecycle(),
            online: true,
        });
        expect(failed.phase).toBe('error');
        expect(failed.failureReason).toBe('network');

        // An "offline" observation published when the socket last dropped is stale once the transport is back:
        // the Home is answering, so the roster must not call it unreachable while pages are still arriving.
        const reconnected = buildOrdinarySessionListHomeState({
            serverId: 'home-a',
            requestedQueryKey: 'query:home-a',
            sessionIds: ['s1'],
            observation: { phase: 'offline', lastSuccessAt: null },
            lifecycle: lifecycle(),
            online: true,
        });
        expect(reconnected.phase).toBe('ready');
    });
});
