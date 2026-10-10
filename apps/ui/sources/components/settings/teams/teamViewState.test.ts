import { describe, expect, it } from 'vitest';
import { NO_TEAM_CAPABILITIES_V1, type TeamSummaryV1 } from '@happier-dev/protocol/teams';

import type { TeamSnapshot } from '@/sync/store/teams/teamsSnapshots';

import { resolveTeamViewState } from './teamViewState';

function team(overrides?: Partial<TeamSummaryV1>): TeamSummaryV1 {
    return {
        id: 't1',
        name: 'Acme',
        description: null,
        logo: null,
        archivedAt: null,
        recovery: null,
        policy: {
            v: 1,
            sessionCreationPolicy: 'team_default',
            externalSharingPolicy: 'allowed',
            defaultSessionHistoryAccess: 'from_membership',
            admissionMode: 'invite_only',
            authenticationPolicy: null,
        },
        viewerRole: 'owner',
        capabilities: { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true, manageSettings: true },
        admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
        counts: null,
        ...overrides,
    };
}

function snapshot(overrides?: Partial<TeamSnapshot>): TeamSnapshot {
    return {
        scope: { serverId: 'home', accountId: 'account' },
        address: { serverId: 'home', teamId: 't1' },
        status: 'ready',
        data: team(),
        lastObservedAt: 10,
        stale: false,
        reachability: 'reachable',
        error: null,
        ...overrides,
    };
}

describe('resolveTeamViewState', () => {
    it('distinguishes never observed from a first observation in flight', () => {
        expect(resolveTeamViewState(null).kind).toBe('unobserved');
        expect(resolveTeamViewState(snapshot({ status: 'loading', data: null, lastObservedAt: null })).kind)
            .toBe('loading');
    });

    it('keeps a retained Team on screen when a refresh fails and marks it stale', () => {
        const state = resolveTeamViewState(snapshot({
            status: 'error',
            stale: true,
            reachability: 'unreachable',
            error: { kind: 'unreachable', retryable: true },
        }));

        expect(state.kind).toBe('ready');
        if (state.kind !== 'ready') return;
        expect(state.team.name).toBe('Acme');
        expect(state.stale).toBe(true);
        // Reading a Home that has moved on is useful; deciding against it is not.
        expect(state.mutationsAvailable).toBe(false);
    });

    it('closes mutations on a stale projection even while the Home is reachable', () => {
        const state = resolveTeamViewState(snapshot({ stale: true }));
        expect(state.kind === 'ready' && state.mutationsAvailable).toBe(false);
    });

    it('reports an unavailable Team without a retry for a settled refusal', () => {
        const denied = resolveTeamViewState(snapshot({
            status: 'error',
            data: null,
            lastObservedAt: null,
            reachability: 'reachable',
            error: { kind: 'forbidden', retryable: false },
        }));

        expect(denied.kind).toBe('unavailable');
        expect(denied.kind === 'unavailable' && denied.retryable).toBe(false);
    });

    it('reports archived state from the Team itself rather than from a capability', () => {
        const state = resolveTeamViewState(snapshot({ data: team({ archivedAt: 42 }) }));
        expect(state.kind === 'ready' && state.archived).toBe(true);

        const active = resolveTeamViewState(snapshot());
        expect(active.kind === 'ready' && active.archived).toBe(false);
    });
});
