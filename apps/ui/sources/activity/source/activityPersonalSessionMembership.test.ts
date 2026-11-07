import { describe, expect, it } from 'vitest';

import type { SessionListQueryHomeState } from '@/sync/domains/session/listing/sessionListQueryController';
import { buildSessionListQueryKey } from '@/sync/domains/session/listing/sessionListQueryKey';

import {
    ACTIVITY_PERSONAL_SESSION_QUERY,
    buildActivityPersonalQueryHomeServerIds,
    buildActivityPersonalQueryHomes,
    projectActivityPersonalSessionMembership,
} from './activityPersonalSessionMembership';

function queryState(overrides: Partial<SessionListQueryHomeState>): SessionListQueryHomeState {
    return {
        requestedQueryKey: '',
        appliedQueryKey: null,
        addresses: [],
        nextCursor: null,
        hasNext: false,
        attentionNextCursor: null,
        attentionHasNext: false,
        phase: 'idle',
        freshnessAt: null,
        homeObservation: { phase: overrides.phase ?? 'idle', lastSuccessAt: overrides.freshnessAt ?? null },
        failureReason: null,
        failureCode: null,
        appliedSourceKind: null,
        ...overrides,
    };
}

describe('Activity personal session membership', () => {
    it('queries the active Home even before it has a persisted profile and retains saved Homes', () => {
        expect(buildActivityPersonalQueryHomeServerIds(['saved-home', 'active-home'], 'active-home'))
            .toEqual(['active-home', 'saved-home']);
    });
    it('retains membership by exact Home when Session ids collide', () => {
        const homes = buildActivityPersonalQueryHomes(['home-a', 'home-b']);
        const statesByServerId = Object.fromEntries(homes.map((home) => [home.serverId, queryState({
            requestedQueryKey: home.queryKey,
            appliedQueryKey: home.queryKey,
            appliedSourceKind: 'query',
            phase: 'ready',
            freshnessAt: 10,
            addresses: [{ serverId: home.serverId, sessionId: 'same-id' }],
        })]));

        expect(projectActivityPersonalSessionMembership({
            enabled: true,
            homes,
            statesByServerId,
            membershipByServerId: Object.fromEntries(homes.map((home) => [
                home.serverId,
                [{ serverId: home.serverId, sessionId: 'same-id' }],
            ])),
            coverageComplete: true,
        }).membershipByServerId).toEqual({
            'home-a': ['same-id'],
            'home-b': ['same-id'],
        });
    });

    it('preserves unsupported and offline truth without treating fallback rows as query membership', () => {
        const homes = buildActivityPersonalQueryHomes(['unsupported-home', 'offline-home']);
        const unsupportedKey = buildSessionListQueryKey('unsupported-home', ACTIVITY_PERSONAL_SESSION_QUERY);
        const offlineKey = buildSessionListQueryKey('offline-home', ACTIVITY_PERSONAL_SESSION_QUERY);
        const statesByServerId = {
            'unsupported-home': queryState({
                requestedQueryKey: unsupportedKey,
                // A Home may become unsupported after a previously successful
                // strict query. Its retained rows remain in the shared row cache,
                // but released ordinary membership is now the only truthful
                // Activity fallback and must not be relabelled as query membership.
                appliedQueryKey: unsupportedKey,
                appliedSourceKind: 'query',
                addresses: [{ serverId: 'unsupported-home', sessionId: 'stale-query-row' }],
                phase: 'error',
                failureReason: 'unsupported',
                failureCode: 'filtered_session_listing_unavailable',
            }),
            'offline-home': queryState({
                requestedQueryKey: offlineKey,
                appliedQueryKey: offlineKey,
                appliedSourceKind: 'query',
                phase: 'offline',
                addresses: [{ serverId: 'offline-home', sessionId: 'retained-personal' }],
                freshnessAt: 10,
            }),
        } satisfies Readonly<Record<string, SessionListQueryHomeState>>;

        const projected = projectActivityPersonalSessionMembership({
            enabled: true,
            homes,
            statesByServerId,
            // The store still holds the unsupported Home's former query membership.
            membershipByServerId: {
                'unsupported-home': [{ serverId: 'unsupported-home', sessionId: 'stale-query-row' }],
                'offline-home': [{ serverId: 'offline-home', sessionId: 'retained-personal' }],
            },
            coverageComplete: false,
        });

        expect(projected.coverageComplete).toBe(false);
        expect(projected.statesByServerId['unsupported-home']).toMatchObject({
            phase: 'error',
            failureReason: 'unsupported',
        });
        expect(projected.statesByServerId['offline-home']).toMatchObject({ phase: 'offline' });
        expect(projected.membershipByServerId).toEqual({
            'unsupported-home': [],
            'offline-home': ['retained-personal'],
        });
    });

    it('reads the store-owned last-known membership while no page has applied, without claiming coverage', () => {
        const homes = buildActivityPersonalQueryHomes(['home-a']);
        const home = homes[0]!;
        const projected = projectActivityPersonalSessionMembership({
            enabled: true,
            homes,
            // A cold controller (reload, unreachable Home): nothing applied yet.
            statesByServerId: {
                'home-a': queryState({ requestedQueryKey: home.queryKey, phase: 'offline' }),
            },
            membershipByServerId: { 'home-a': [{ serverId: 'home-a', sessionId: 'last-known-personal' }] },
            coverageComplete: false,
        });

        expect(projected.membershipByServerId).toEqual({ 'home-a': ['last-known-personal'] });
        expect(projected.coverageComplete).toBe(false);
    });

    it('never relabels a released-listing fallback page as personal query membership', () => {
        const homes = buildActivityPersonalQueryHomes(['home-a']);
        const home = homes[0]!;
        const projected = projectActivityPersonalSessionMembership({
            enabled: true,
            homes,
            statesByServerId: {
                'home-a': queryState({
                    requestedQueryKey: home.queryKey,
                    appliedQueryKey: home.queryKey,
                    appliedSourceKind: 'ordinary',
                    phase: 'ready',
                }),
            },
            membershipByServerId: { 'home-a': [{ serverId: 'home-a', sessionId: 'ordinary-row' }] },
            coverageComplete: false,
        });

        expect(projected.membershipByServerId).toEqual({ 'home-a': [] });
    });

    it('rejects addresses from a stale query or the wrong Home', () => {
        const homes = buildActivityPersonalQueryHomes(['home-a']);
        const home = homes[0]!;
        const projected = projectActivityPersonalSessionMembership({
            enabled: true,
            homes,
            statesByServerId: {
                'home-a': queryState({
                    requestedQueryKey: home.queryKey,
                    appliedQueryKey: home.queryKey,
                    appliedSourceKind: 'query',
                    phase: 'ready',
                    addresses: [{ serverId: 'home-b', sessionId: 'wrong-home' }],
                }),
            },
            membershipByServerId: { 'home-a': [{ serverId: 'home-b', sessionId: 'wrong-home' }] },
            coverageComplete: true,
        });

        expect(projected.membershipByServerId).toEqual({ 'home-a': [] });
    });

    it('withdraws retained strict-query membership when authentication is no longer active', () => {
        const homes = buildActivityPersonalQueryHomes(['home-a']);
        const home = homes[0]!;

        const projected = projectActivityPersonalSessionMembership({
            enabled: false,
            homes,
            statesByServerId: {
                'home-a': queryState({
                    requestedQueryKey: home.queryKey,
                    appliedQueryKey: home.queryKey,
                    appliedSourceKind: 'query',
                    phase: 'not_selected',
                    addresses: [{ serverId: 'home-a', sessionId: 'retained-after-sign-out' }],
                }),
            },
            membershipByServerId: { 'home-a': [{ serverId: 'home-a', sessionId: 'retained-after-sign-out' }] },
            coverageComplete: false,
        });
        expect(projected.membershipByServerId).toEqual({});
        expect(projected.statesByServerId).toEqual({});
        expect(projected.coverageComplete).toBe(false);
    });
});
