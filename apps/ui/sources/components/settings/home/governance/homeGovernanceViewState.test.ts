import { describe, expect, it } from 'vitest';
import { homeGovernanceProjectionFixture, homeGovernancePolicyProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';

import type { HomeGovernanceSnapshot } from '@/sync/store/home/governance/homeGovernanceSnapshots';

import { resolveHomeGovernanceViewState } from './homeGovernanceViewState';

const SCOPE = { serverId: 'srv_1', accountId: 'acc_1' } as const;

const PROJECTION = homeGovernanceProjectionFixture({
    viewer: { accountId: 'acc_1', homeRole: 'owner', status: 'active' },
    policy: homeGovernancePolicyProjectionFixture({ revision: 3 }),
});

function snapshot(overrides: Partial<HomeGovernanceSnapshot> = {}): HomeGovernanceSnapshot {
    return {
        scope: SCOPE,
        status: 'ready',
        data: PROJECTION,
        lastObservedAt: 1_000,
        stale: false,
        reachability: 'reachable',
        error: null,
        ...overrides,
    };
}

describe('resolveHomeGovernanceViewState', () => {
    it('claims nothing for a Home that has never answered', () => {
        expect(resolveHomeGovernanceViewState(null).kind).toBe('unobserved');
    });

    it('shows a first load rather than an empty Home', () => {
        const state = resolveHomeGovernanceViewState(snapshot({
            status: 'loading',
            data: null,
            lastObservedAt: null,
        }));
        expect(state.kind).toBe('loading');
    });

    it('reports an unreachable Home that has no retained projection as unavailable', () => {
        const state = resolveHomeGovernanceViewState(snapshot({
            status: 'error',
            data: null,
            lastObservedAt: null,
            reachability: 'unreachable',
            error: { kind: 'unreachable', retryable: true },
        }));
        expect(state.kind).toBe('unavailable');
        if (state.kind !== 'unavailable') throw new Error('unreachable');
        expect(state.retryable).toBe(true);
    });

    it('does not offer a retry for a settled refusal', () => {
        const state = resolveHomeGovernanceViewState(snapshot({
            status: 'error',
            data: null,
            lastObservedAt: null,
            reachability: 'reachable',
            error: { kind: 'forbidden', retryable: false },
        }));
        expect(state.kind).toBe('unavailable');
        if (state.kind !== 'unavailable') throw new Error('unreachable');
        expect(state.retryable).toBe(false);
    });

    it('maps the typed ownerless-Home refusal to setup instructions without a projection', () => {
        const state = resolveHomeGovernanceViewState(snapshot({
            status: 'error',
            data: null,
            lastObservedAt: null,
            reachability: 'reachable',
            error: {
                kind: 'forbidden',
                retryable: false,
                code: 'home_governance_setup_required',
            },
        }));

        expect(state).toEqual({ kind: 'setup_required' });
    });

    it('keeps rendering a retained projection while a refresh is in flight', () => {
        const state = resolveHomeGovernanceViewState(snapshot({ status: 'refreshing' }));
        expect(state.kind).toBe('ready');
        if (state.kind !== 'ready') throw new Error('unreachable');
        expect(state.projection).toBe(PROJECTION);
        expect(state.refreshing).toBe(true);
        expect(state.mutationsAvailable).toBe(true);
    });

    it('never blanks a retained projection when the Home stops answering', () => {
        const state = resolveHomeGovernanceViewState(snapshot({
            status: 'error',
            stale: true,
            reachability: 'unreachable',
            error: { kind: 'unreachable', retryable: true },
        }));
        expect(state.kind).toBe('ready');
        if (state.kind !== 'ready') throw new Error('unreachable');
        expect(state.projection).toBe(PROJECTION);
        expect(state.stale).toBe(true);
    });

    it('withdraws a retained projection once the Home refuses this account', () => {
        // Offline retention keeps an administrator working; a 403 is the Home
        // stating this account has no authority, and continuing to render the
        // retained projection would show authority it just took away.
        const state = resolveHomeGovernanceViewState(snapshot({
            status: 'error',
            stale: true,
            reachability: 'reachable',
            error: { kind: 'forbidden', retryable: false },
        }));
        expect(state.kind).toBe('unavailable');
        if (state.kind !== 'unavailable') throw new Error('unreachable');
        expect(state.error.kind).toBe('forbidden');
        expect(state.retryable).toBe(false);
    });

    it('withdraws a retained projection once the credential no longer authenticates', () => {
        const state = resolveHomeGovernanceViewState(snapshot({
            status: 'error',
            stale: true,
            reachability: 'unauthorized',
            error: { kind: 'unauthorized', retryable: false },
        }));
        expect(state.kind).toBe('unavailable');
    });

    it('withdraws a retained projection once the Home reports no such operation', () => {
        const state = resolveHomeGovernanceViewState(snapshot({
            status: 'error',
            stale: true,
            reachability: 'reachable',
            error: { kind: 'unsupported', retryable: false },
        }));
        expect(state.kind).toBe('unavailable');
    });

    it('keeps a retained projection through a malformed or unclassified answer', () => {
        // Neither is a statement about this account's authority, so the last
        // successful observation still stands.
        for (const kind of ['invalid', 'unknown'] as const) {
            const state = resolveHomeGovernanceViewState(snapshot({
                status: 'error',
                stale: true,
                error: { kind, retryable: false },
            }));
            expect(state.kind).toBe('ready');
        }
    });

    it('withholds mutations while the shown projection is known to be behind', () => {
        const state = resolveHomeGovernanceViewState(snapshot({
            status: 'error',
            stale: true,
            reachability: 'unreachable',
            error: { kind: 'unreachable', retryable: true },
        }));
        if (state.kind !== 'ready') throw new Error('unreachable');
        expect(state.mutationsAvailable).toBe(false);
    });

    it('treats a refresh over a good answer as quiet updating, not a warning, and keeps writes open', () => {
        // An Account-change wake or a refetch after a success is routine: every write is still decided
        // by the Home (revision CAS, capability and target guards), so nothing is unsafe to offer.
        for (const refreshing of [
            snapshot({ stale: true }),
            snapshot({ status: 'refreshing' }),
            snapshot({ status: 'refreshing', stale: true }),
        ]) {
            const state = resolveHomeGovernanceViewState(refreshing);
            if (state.kind !== 'ready') throw new Error('unreachable');
            expect(state.readFailed).toBe(false);
            expect(state.updating).toBe(true);
            expect(state.mutationsAvailable).toBe(true);
        }
    });

    it('warns only once a read has failed or the Home is unreachable, and closes writes then', () => {
        for (const failed of [
            snapshot({ status: 'error', stale: true, reachability: 'unreachable', error: { kind: 'unreachable', retryable: true } }),
            snapshot({ status: 'error', stale: true, error: { kind: 'invalid', retryable: false } }),
        ]) {
            const state = resolveHomeGovernanceViewState(failed);
            if (state.kind !== 'ready') throw new Error('unreachable');
            expect(state.readFailed).toBe(true);
            expect(state.updating).toBe(false);
            expect(state.mutationsAvailable).toBe(false);
        }
    });

    it('is neither updating nor failed on a settled, current answer', () => {
        const state = resolveHomeGovernanceViewState(snapshot());
        if (state.kind !== 'ready') throw new Error('unreachable');
        expect(state.readFailed).toBe(false);
        expect(state.updating).toBe(false);
    });

    it('reports the exact Home the projection belongs to so a focus change cannot retarget it', () => {
        const state = resolveHomeGovernanceViewState(snapshot());
        if (state.kind !== 'ready') throw new Error('unreachable');
        expect(state.scope).toEqual(SCOPE);
    });
});
