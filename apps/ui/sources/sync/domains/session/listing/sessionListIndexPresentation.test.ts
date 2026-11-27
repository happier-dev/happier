import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { createSessionListQueryHomeController, type SessionListQueryHomeState } from './sessionListQueryController';
import { HappyError } from '@/utils/errors/errors';
import * as presentationModule from './sessionListIndexPresentation';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { primeServerFeaturesSnapshot, deleteServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import {
    applySessionListIndexPresentation,
    resolveSessionListSourceIndex,
    resolveVisibleSessionListIndexSummary,
} from './sessionListIndexPresentation';

type QueryPresentationResolver = (input: Readonly<{
    selectedServerIds: readonly string[];
    statesByServerId: Readonly<Record<string, SessionListQueryHomeState | undefined>>;
    coverageComplete: boolean;
    retainedRowCount: number;
    sessionsEnabled?: boolean;
    workflowRunWindow?: Readonly<{
        serverId?: string;
        status: 'loading' | 'loaded' | 'failed';
        hasMore: boolean;
        loadingMore: boolean;
        loadMoreFailed: boolean;
    }>;
    workflowRunUnavailableHomes?: readonly Readonly<{
        serverId: string;
        reason: 'not_selected' | 'unsupported';
    }>[];
    settlingHomeServerId?: string | null;
}>) => unknown;

function queryState(partial: Partial<SessionListQueryHomeState>): SessionListQueryHomeState {
    return {
        requestedQueryKey: 'query',
        appliedQueryKey: null,
        addresses: [],
        nextCursor: null,
        hasNext: false,
        attentionNextCursor: null,
        attentionHasNext: false,
        phase: 'idle',
        freshnessAt: null,
        homeObservation: { phase: partial.phase ?? 'idle', lastSuccessAt: partial.freshnessAt ?? null },
        failureReason: null,
        failureCode: null,
        appliedSourceKind: null,
        ...partial,
    };
}

function makeHeader(title: string, partial?: Partial<Extract<SessionListIndexItem, { type: 'header' }>>): SessionListIndexItem {
    return {
        type: 'header',
        title,
        ...(partial ?? {}),
    };
}

function makeSession(sessionId: string, serverId: string, serverName: string, partial?: Partial<Extract<SessionListIndexItem, { type: 'session' }>>): SessionListIndexItem {
    return {
        type: 'session',
        sessionId,
        serverId,
        serverName,
        ...(partial ?? {}),
    };
}

describe('resolveSessionListSourceIndex', () => {
    it('keeps resolved server index visible when some selected servers are still loading', () => {
        const activeIndex: SessionListIndexItem[] = [
            makeSession('s1', 'server-a', 'Server A'),
        ];

        const result = resolveSessionListSourceIndex({
            enabled: true,
            activeServerId: 'server-a',
            activeIndex,
            byServerId: {
                'server-a': activeIndex,
                'server-b': null,
            },
            selectedServerIds: ['server-a', 'server-b'],
        });

        expect(result).toBe(activeIndex);
    });
});

describe('resolveVisibleSessionListIndexSummary', () => {
    it('counts sessions using the renderable resolver for direct-vs-persisted storage filters', () => {
        const index: SessionListIndexItem[] = [
            makeSession('direct-1', 'server-a', 'Server A', { storageKind: 'direct' }),
            makeSession('persisted-1', 'server-a', 'Server A', { storageKind: 'persisted' }),
        ];

        expect(resolveVisibleSessionListIndexSummary({
            enabled: false,
            activeServerId: 'server-a',
            activeIndex: index,
        }, 'direct')).toEqual({
            sessionsReady: true,
            sessionCount: 1,
        });
    });

    it('treats partially resolved selected-server sources as ready (stale-while-revalidate)', () => {
        const activeIndex: SessionListIndexItem[] = [
            makeSession('s1', 'server-a', 'Server A'),
        ];

        const result = resolveVisibleSessionListIndexSummary({
            enabled: true,
            activeServerId: 'server-a',
            activeIndex,
            byServerId: {
                'server-a': activeIndex,
                'server-b': null,
            },
            selectedServerIds: ['server-a', 'server-b'],
        }, 'all');

        expect(result).toEqual({
            sessionsReady: true,
            sessionCount: 1,
        });
    });
});

describe('resolveSessionListQueryPresentation', () => {
    const resolve = (input: Parameters<QueryPresentationResolver>[0]) => {
        const resolver = (presentationModule as unknown as Readonly<{
            resolveSessionListQueryPresentation?: QueryPresentationResolver;
        }>).resolveSessionListQueryPresentation;
        expect(typeof resolver).toBe('function');
        return resolver?.(input);
    };

    it('makes an empty loaded Runs-only window ready without waiting for Sessions', () => {
        expect(resolve({
            selectedServerIds: ['home-a'],
            statesByServerId: {},
            coverageComplete: false,
            retainedRowCount: 0,
            sessionsEnabled: false,
            workflowRunWindow: { status: 'loaded', hasMore: false, loadingMore: false, loadMoreFailed: false },
        })).toEqual({ kind: 'ready', complete: true });
    });

    it('keeps a failed Run read and failed next page visible with retained work', () => {
        const input = {
            selectedServerIds: ['home-a'],
            statesByServerId: { 'home-a': queryState({ phase: 'ready' }) },
            coverageComplete: true,
            retainedRowCount: 2,
        };
        for (const window of [
            { status: 'failed' as const, hasMore: false, loadingMore: false, loadMoreFailed: false },
            { status: 'loaded' as const, hasMore: true, loadingMore: false, loadMoreFailed: true },
        ]) {
            expect(resolve({ ...input, workflowRunWindow: window })).toEqual({ kind: 'error', retainedRows: true });
        }
    });

    it('does not certify a paged Run window as complete and retains rows while Runs load', () => {
        const input = {
            selectedServerIds: ['home-a'],
            statesByServerId: { 'home-a': queryState({ phase: 'ready' }) },
            coverageComplete: true,
            retainedRowCount: 2,
        };
        expect(resolve({ ...input, workflowRunWindow: {
            status: 'loaded', hasMore: true, loadingMore: false, loadMoreFailed: false,
        } })).toEqual({ kind: 'ready', complete: false, hasMore: true });
        expect(resolve({ ...input, workflowRunWindow: {
            status: 'loading', hasMore: false, loadingMore: false, loadMoreFailed: false,
        } })).toEqual({ kind: 'refreshing', retainedRows: true });
    });

    it('retains loaded Runs while the ordinary Sessions source is unresolved', () => {
        expect(resolve({
            selectedServerIds: [],
            statesByServerId: {},
            coverageComplete: false,
            retainedRowCount: 1,
            workflowRunWindow: { status: 'loaded', hasMore: false, loadingMore: false, loadMoreFailed: false },
        })).toEqual({ kind: 'refreshing', retainedRows: true });
    });

    it('does not certify unserved Runs Homes as a complete empty result', () => {
        // The active Account/Home FIN read owner names mounted Homes it cannot
        // serve as unsupported, and selection names unmounted Homes not_selected.
        // The presenter does not guess an offline transport state for either.
        for (const reason of ['unsupported', 'not_selected'] as const) {
            const unavailableHomes = [{ serverId: 'home-b', reason }];
            expect(resolve({
                selectedServerIds: [],
                statesByServerId: {},
                coverageComplete: true,
                retainedRowCount: 0,
                sessionsEnabled: false,
                workflowRunUnavailableHomes: unavailableHomes,
            })).toEqual({ kind: 'partial', unavailableHomes });
            expect(resolve({
                selectedServerIds: [],
                statesByServerId: {},
                coverageComplete: true,
                retainedRowCount: 1,
                sessionsEnabled: false,
                workflowRunWindow: { status: 'loaded', hasMore: false, loadingMore: false, loadMoreFailed: false },
                workflowRunUnavailableHomes: unavailableHomes,
            })).toEqual({ kind: 'partial', unavailableHomes });
        }
    });

    it('keeps initial unresolved Homes in loading instead of treating zero as authoritative', () => {
        expect(resolve({
            selectedServerIds: ['home-a'],
            statesByServerId: { 'home-a': queryState({ phase: 'loading' }) },
            coverageComplete: false,
            retainedRowCount: 0,
        })).toEqual({ kind: 'initial_loading' });
    });

    it('treats no selected Homes as complete only after the filter owner proves the empty selection', () => {
        expect(resolve({
            selectedServerIds: [],
            statesByServerId: {},
            coverageComplete: false,
            retainedRowCount: 0,
        })).toEqual({ kind: 'initial_loading' });

        expect(resolve({
            selectedServerIds: [],
            statesByServerId: {},
            coverageComplete: true,
            retainedRowCount: 0,
        })).toEqual({ kind: 'ready', complete: true });
    });

    it('projects mixed ready and unavailable Homes as partial with exact reasons', () => {
        expect(resolve({
            selectedServerIds: ['home-a', 'home-b', 'home-c'],
            statesByServerId: {
                'home-a': queryState({ phase: 'ready', appliedQueryKey: 'query' }),
                'home-b': queryState({ phase: 'offline' }),
                'home-c': queryState({ phase: 'error', failureReason: 'unsupported' }),
            },
            coverageComplete: false,
            retainedRowCount: 2,
        })).toEqual({
            kind: 'partial',
            unavailableHomes: [
                { serverId: 'home-b', reason: 'offline' },
                { serverId: 'home-c', reason: 'unsupported' },
            ],
        });
    });

    it('reports retained refresh and incomplete ready coverage without hiding rows', () => {
        expect(resolve({
            selectedServerIds: ['home-a'],
            statesByServerId: {
                'home-a': queryState({ phase: 'refreshing', appliedQueryKey: 'query', addresses: [{ serverId: 'home-a', sessionId: 's1' }] }),
            },
            coverageComplete: false,
            retainedRowCount: 1,
        })).toEqual({ kind: 'refreshing', retainedRows: true });

        expect(resolve({
            selectedServerIds: ['home-a'],
            statesByServerId: {
                'home-a': queryState({ phase: 'ready', appliedQueryKey: 'query', hasNext: true }),
            },
            coverageComplete: false,
            retainedRowCount: 1,
        })).toEqual({ kind: 'ready', complete: false });
    });

    it('distinguishes complete zero from a terminal query error', () => {
        expect(resolve({
            selectedServerIds: ['home-a'],
            statesByServerId: { 'home-a': queryState({ phase: 'ready', appliedQueryKey: 'query' }) },
            coverageComplete: true,
            retainedRowCount: 0,
        })).toEqual({ kind: 'ready', complete: true });

        expect(resolve({
            selectedServerIds: ['home-a'],
            statesByServerId: { 'home-a': queryState({ phase: 'error', failureReason: 'network' }) },
            coverageComplete: false,
            retainedRowCount: 0,
        })).toEqual({ kind: 'error', retainedRows: false });
    });

    it('reads a transport failure as loading while the Home is still being reached', () => {
        const failed = { selectedServerIds: ['home-a'], coverageComplete: false,
            statesByServerId: { 'home-a': queryState({ phase: 'error', failureReason: 'network' }) } } as const;
        expect(resolve({ ...failed, retainedRowCount: 0, settlingHomeServerId: 'home-a' })).toEqual({ kind: 'initial_loading' });
        expect(resolve({ ...failed, retainedRowCount: 3, settlingHomeServerId: 'home-a' })).toEqual({ kind: 'refreshing', retainedRows: true });
        expect(resolve({ ...failed, retainedRowCount: 0, settlingHomeServerId: 'home-b' })).toEqual({ kind: 'error', retainedRows: false });
        expect(resolve({ ...failed, selectedServerIds: ['home-a', 'home-b'], retainedRowCount: 0, settlingHomeServerId: 'home-a',
            statesByServerId: { ...failed.statesByServerId, 'home-b': queryState({ phase: 'error', failureReason: 'network' }) },
        })).toEqual({ kind: 'error', retainedRows: false });
        // Settling hides only an error; a ready query keeps its answer.
        expect(resolve({ selectedServerIds: ['home-a'], coverageComplete: true, retainedRowCount: 0, settlingHomeServerId: 'home-a',
            statesByServerId: { 'home-a': queryState({ phase: 'ready', appliedQueryKey: 'query' }) } })).toEqual({ kind: 'ready', complete: true });
    });

    it.each([
        { error: new HappyError('Invalid response', false, { code: 'invalid_response' }), terminal: true },
        { error: new HappyError('List failed', true, { status: 503, code: 'list_failed' }), terminal: true },
        { error: new TypeError('Failed to fetch'), terminal: false },
    ])('projects the real query failure during Home settling ($error)', async ({ error, terminal }) => {
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a', fetchPage: async () => { throw error; },
        });
        try {
            await controller.update({ query: { v: 1, storage: 'active', includeInactive: true,
                scope: 'all_accessible', attention: 'any', audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] } },
                selected: true, online: true, supported: true });
            const input = { selectedServerIds: ['home-a'], coverageComplete: false,
                settlingHomeServerId: 'home-a', statesByServerId: { 'home-a': controller.getSnapshot() } };
            expect(resolve({ ...input, retainedRowCount: 0 })).toEqual(terminal
                ? { kind: 'error', retainedRows: false } : { kind: 'initial_loading' });
            expect(resolve({ ...input, retainedRowCount: 2 })).toEqual(terminal
                ? { kind: 'error', retainedRows: true } : { kind: 'refreshing', retainedRows: true });
        } finally { controller.dispose(); }
    });

    it.each(['invalid_query', 'access_denied', 'cursor_not_advancing'] as const)(
        'keeps terminal %s visible while its Home is settling', failureReason => {
            const input = { selectedServerIds: ['home-a'], coverageComplete: false,
                settlingHomeServerId: 'home-a', statesByServerId: {
                    'home-a': queryState({ phase: 'error', failureReason, failedOperation: 'replace' }),
                } };
            expect(resolve({ ...input, retainedRowCount: 0 })).toEqual({ kind: 'error', retainedRows: false });
            expect(resolve({ ...input, retainedRowCount: 2 })).toEqual({ kind: 'error', retainedRows: true });
        },
    );

    it('scopes failed Run windows to their producing Home, including pagination failures', () => {
        for (const failure of [{ status: 'failed' as const, loadMoreFailed: false }, { status: 'loaded' as const, loadMoreFailed: true }]) {
            const input = { selectedServerIds: ['home-a', 'home-b'], statesByServerId: {}, sessionsEnabled: false,
                coverageComplete: false, retainedRowCount: 0,
                workflowRunWindow: { ...failure, serverId: 'home-b', hasMore: false, loadingMore: false } };
            expect(resolve({ ...input, settlingHomeServerId: 'home-a' })).toEqual({ kind: 'error', retainedRows: false });
            expect(resolve({ ...input, settlingHomeServerId: 'home-b' })).toEqual({ kind: 'initial_loading' });
            expect(resolve({ ...input, retainedRowCount: 2, settlingHomeServerId: 'home-b' })).toEqual({ kind: 'refreshing', retainedRows: true });
        }
    });

    it('keeps another Home query failure visible while the failed Run Home settles', () => {
        expect(resolve({ selectedServerIds: ['home-a', 'home-b'], coverageComplete: false, retainedRowCount: 0,
            settlingHomeServerId: 'home-a', statesByServerId: {
                'home-a': queryState({ phase: 'ready', appliedQueryKey: 'query' }),
                'home-b': queryState({ phase: 'error', failureReason: 'network' }),
            }, workflowRunWindow: { serverId: 'home-a', status: 'failed', hasMore: false, loadingMore: false, loadMoreFailed: false },
        })).toEqual({ kind: 'error', retainedRows: false });
    });
});

describe('applySessionListIndexPresentation', () => {
    it('replaces a retained raw Home host with the currently published name', async () => {
        const profile = await upsertServerProfile({ serverUrl: 'http://localhost:52753', name: 'localhost:52753' });
        primeServerFeaturesSnapshot({ serverId: profile.id, snapshot: {
            status: 'ready', features: { ...createRootLayoutFeaturesResponse(), homePresentation: { v: 1, displayName: 'Studio Home' } },
        } });
        try {
            const result = applySessionListIndexPresentation([
                makeSession('s1', profile.id, 'localhost:52753'), makeSession('s2', 'other-home', 'Work Home'),
            ], {
                enabled: true, presentation: 'grouped',
            });
            expect(result[0]).toMatchObject({ type: 'header', title: 'Studio Home', serverName: 'Studio Home' });
        } finally {
            deleteServerFeaturesSnapshot({ serverId: profile.id });
        }
    });
    it('groups by server when concurrent grouped presentation is enabled', () => {
        const data: SessionListIndexItem[] = [
            makeHeader('Today', { headerKind: 'date' }),
            makeSession('s1', 'server-a', 'Server A'),
            makeSession('s2', 'server-b', 'Server B'),
            makeSession('s3', 'server-a', 'Server A'),
        ];

        const result = applySessionListIndexPresentation(data, {
            enabled: true,
            presentation: 'grouped',
        });

        expect(result.map((item) => {
            if (item.type === 'header') {
                return `header:${item.headerKind ?? 'date'}:${item.title}`;
            }
            return item.type === 'session'
                ? `session:${item.sessionId}:${item.serverId}`
                : `run:${item.runId}:${item.serverId}`;
        })).toEqual([
            'header:server:Server A',
            'header:date:Today',
            'session:s1:server-a',
            'session:s3:server-a',
            'header:server:Server B',
            'session:s2:server-b',
        ]);
    });
});
