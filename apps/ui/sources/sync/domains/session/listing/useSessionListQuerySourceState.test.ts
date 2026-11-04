import { describe, expect, it } from 'vitest';
import { FeaturesResponseSchema} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { type SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';

import type { ServerFeaturesMainSelectionSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import type { FeatureLocalPolicySettings } from '@/sync/domains/features/featureLocalPolicy';

import type { SessionListQueryHomeState } from './sessionListQueryController';
import {
    buildSessionListQueryHomeIndex,
    resolveEmptySessionListQueryCoverage,
    resolveSessionListFeatureHomeSupport,
    resolveSessionListQueryHomeAdmissionSupport,
    resolveSessionListQueryHomeSupport,
} from './useSessionListQuerySourceState';
import { isSessionListQueryHomeCoverageComplete } from './sessionListHomeObservation';
import { buildSessionListQueryKey } from './sessionListQueryKey';
import { projectSessionListIndexForLayout } from './sessionListLayout';

function readyFilteredListingSnapshot(enabled: boolean) {
    return {
        status: 'ready' as const,
        features: FeaturesResponseSchema.parse({
            features: { sessions: { enabled: true, filteredListing: { enabled } } },
            capabilities: {},
        }),
    };
}

function readyFoldersSnapshot(enabled: boolean) {
    return {
        status: 'ready' as const,
        features: FeaturesResponseSchema.parse({
            features: { sessions: { enabled: true, folders: { enabled } } },
            capabilities: {},
        }),
    };
}

const DEFAULT_LOCAL_POLICY: FeatureLocalPolicySettings = { experiments: false, featureToggles: {} };

describe('resolveSessionListQueryHomeSupport', () => {
    it('settles older strict Homes unavailable for membership queries', () => {
        const aggregate: ServerFeaturesMainSelectionSnapshot = { status: 'ready', serverIds: ['home-a'], snapshotsByServerId: {
            'home-a': readyFilteredListingSnapshot(true),
        } };
        const query = { membership: { mode: 'manual_only' as const, tagIds: ['member'] } };
        expect(resolveSessionListQueryHomeSupport(aggregate, 'home-a', true, DEFAULT_LOCAL_POLICY, query)).toBe(false);
        const ready = { ...aggregate, snapshotsByServerId: { 'home-a': { status: 'ready' as const, features: FeaturesResponseSchema.parse({
            features: { sessions: { enabled: true, filteredListing: { enabled: true, membershipSelectorVersion: 1 } } }, capabilities: {},
        }) } } };
        expect(resolveSessionListQueryHomeSupport(ready, 'home-a', true, DEFAULT_LOCAL_POLICY, query)).toBe(true);
    });
    it('keeps opposite folder bits qualified to each exact Home', () => {
        const aggregate: ServerFeaturesMainSelectionSnapshot = {
            status: 'ready',
            serverIds: ['home-a', 'home-b'],
            snapshotsByServerId: {
                'home-a': readyFoldersSnapshot(false),
                'home-b': readyFoldersSnapshot(true),
            },
        };

        expect(resolveSessionListFeatureHomeSupport('sessions.folders', aggregate, 'home-a', true, DEFAULT_LOCAL_POLICY)).toBe(false);
        expect(resolveSessionListFeatureHomeSupport('sessions.folders', aggregate, 'home-b', true, DEFAULT_LOCAL_POLICY)).toBe(true);
    });

    it('lets a ready Home proceed while another Home keeps the aggregate snapshot loading', () => {
        const aggregate: ServerFeaturesMainSelectionSnapshot = {
            status: 'loading',
            serverIds: ['home-a', 'home-b'],
            snapshotsByServerId: {
                'home-a': readyFilteredListingSnapshot(true),
            },
        };

        expect(resolveSessionListQueryHomeSupport(aggregate, 'home-a', true, DEFAULT_LOCAL_POLICY)).toBe(true);
        expect(resolveSessionListQueryHomeSupport(aggregate, 'home-b', true, DEFAULT_LOCAL_POLICY)).toBeNull();
    });

    it('fails a settled unsupported or disabled Home closed', () => {
        const aggregate: ServerFeaturesMainSelectionSnapshot = {
            status: 'ready',
            serverIds: ['home-a', 'home-b'],
            snapshotsByServerId: {
                'home-a': { status: 'unsupported', reason: 'endpoint_missing' },
                'home-b': readyFilteredListingSnapshot(false),
            },
        };

        expect(resolveSessionListQueryHomeSupport(aggregate, 'home-a', true, DEFAULT_LOCAL_POLICY)).toBe(false);
        expect(resolveSessionListQueryHomeSupport(aggregate, 'home-b', true, DEFAULT_LOCAL_POLICY)).toBe(false);
    });
});

describe('resolveSessionListQueryHomeAdmissionSupport', () => {
    it('admits Following only when both exact-Home feature decisions are enabled', () => {
        expect(resolveSessionListQueryHomeAdmissionSupport(true, false)).toBe(false);
        expect(resolveSessionListQueryHomeAdmissionSupport(true, true)).toBe(true);
        expect(resolveSessionListQueryHomeAdmissionSupport(true, null)).toBeNull();
    });

    it('preserves the filtered-listing decision when the scope has no additional requirement', () => {
        expect(resolveSessionListQueryHomeAdmissionSupport(true, undefined)).toBe(true);
        expect(resolveSessionListQueryHomeAdmissionSupport(false, undefined)).toBe(false);
        expect(resolveSessionListQueryHomeAdmissionSupport(null, undefined)).toBeNull();
    });
});

const FILTERED_QUERY: SessionListQueryV1 = {
    v: 1,
    storage: 'active',
    includeInactive: false,
    scope: 'all_accessible',
    attention: 'any',
    audiences: [{ kind: 'team', teamId: 'team-a' }],
    tagIds: [],
    includeAttention: true,
};

const FILTERED_QUERY_KEY = buildSessionListQueryKey('home-a', FILTERED_QUERY);

function homeState(overrides: Partial<SessionListQueryHomeState> = {}): SessionListQueryHomeState {
    return {
        requestedQueryKey: FILTERED_QUERY_KEY,
        appliedQueryKey: FILTERED_QUERY_KEY,
        addresses: [],
        nextCursor: null,
        hasNext: false,
        attentionNextCursor: null,
        attentionHasNext: false,
        phase: 'ready',
        freshnessAt: 1,
        failureReason: null,
        failureCode: null,
        appliedSourceKind: 'query',
        ...overrides,
    };
}

describe('isSessionListQueryHomeCoverageComplete', () => {
    it('is complete only for a ready Home whose applied query and both page families are exhausted', () => {
        expect(isSessionListQueryHomeCoverageComplete({
            state: homeState(),
            requestedQueryKey: FILTERED_QUERY_KEY,
        })).toBe(true);
    });

    it.each([
        ['missing state', undefined],
        ['a stale applied query', homeState({ appliedQueryKey: 'other' })],
        ['an outstanding ordinary continuation', homeState({ hasNext: true, nextCursor: 'c' })],
        ['an outstanding attention continuation', homeState({ attentionHasNext: true, attentionNextCursor: 'c' })],
        ['a retained offline Home', homeState({ phase: 'offline' })],
        ['a refreshing Home', homeState({ phase: 'refreshing' })],
        ['an errored Home', homeState({ phase: 'error', failureReason: 'network' })],
        ['an unsupported Home', homeState({ phase: 'error', failureReason: 'unsupported' })],
    ])('is incomplete for %s', (_label, state) => {
        expect(isSessionListQueryHomeCoverageComplete({
            state,
            requestedQueryKey: FILTERED_QUERY_KEY,
        })).toBe(false);
    });

    it('never claims a released GET adapter answered the strict query corpus', () => {
        const state = homeState({ appliedSourceKind: 'ordinary' });
        expect(isSessionListQueryHomeCoverageComplete({
            state,
            requestedQueryKey: FILTERED_QUERY_KEY,
        })).toBe(false);

        const unfiltered: SessionListQueryV1 = {
            ...FILTERED_QUERY,
            storage: 'archived',
            audiences: [],
            tagIds: [],
            attention: 'any',
            scope: 'my_work',
        };
        const unfilteredKey = buildSessionListQueryKey('home-a', unfiltered);
        expect(isSessionListQueryHomeCoverageComplete({
            state: homeState({
                appliedSourceKind: 'ordinary',
                appliedQueryKey: unfilteredKey,
                requestedQueryKey: unfilteredKey,
            }),
            requestedQueryKey: unfilteredKey,
        })).toBe(false);
    });

    it('never treats released owner/direct GET as complete for all-accessible scope', () => {
        const allAccessible: SessionListQueryV1 = {
            ...FILTERED_QUERY,
            audiences: [],
            tagIds: [],
            attention: 'any',
            scope: 'all_accessible',
        };
        const allAccessibleKey = buildSessionListQueryKey('home-a', allAccessible);

        expect(isSessionListQueryHomeCoverageComplete({
            state: homeState({
                appliedSourceKind: 'ordinary',
                appliedQueryKey: allAccessibleKey,
                requestedQueryKey: allAccessibleKey,
            }),
            requestedQueryKey: allAccessibleKey,
        })).toBe(false);
    });
});

describe('buildSessionListQueryHomeIndex', () => {
    it('preserves an unresolved qualified address for the Recent loading projection', () => {
        const index = buildSessionListQueryHomeIndex({
            addresses: [{ serverId: 'home-a', sessionId: 'pending-session' }],
            rowsBySessionId: {},
            machines: {},
            layoutV1: 'projects',
            serverId: 'home-a',
            serverName: 'Home A',
        });

        expect(projectSessionListIndexForLayout({
            source: index,
            choice: 'recent_activity',
            resolveSessionRow: () => null,
        })).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'loading' }),
            expect.objectContaining({
                type: 'session',
                serverId: 'home-a',
                sessionId: 'pending-session',
                groupKind: 'loading',
            }),
        ]);
    });
});

describe('empty query selection coverage', () => {
    it('distinguishes an intentional zero-Home filter result from initial Home discovery', () => {
        expect(resolveEmptySessionListQueryCoverage({
            enabled: true,
            homeCount: 0,
            emptySelectionComplete: false,
        })).toBe(false);
        expect(resolveEmptySessionListQueryCoverage({
            enabled: true,
            homeCount: 0,
            emptySelectionComplete: true,
        })).toBe(true);
        expect(resolveEmptySessionListQueryCoverage({
            enabled: false,
            homeCount: 0,
            emptySelectionComplete: true,
        })).toBe(false);
    });
});
