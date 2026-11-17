import { homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    NO_HOME_CAPABILITIES_V1,
    type HomeGovernanceProjectionV1,
} from '@happier-dev/protocol/home/governance';

import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import {
    applyHomeGovernanceFailure,
    applyHomeGovernanceProjection,
    beginHomeGovernanceLoad,
    clearHomeGovernanceSnapshotsForServer,
    getHomeGovernanceSnapshot,
    invalidateHomeGovernanceSnapshotsForServer,
    resetHomeGovernanceSnapshotsForTests,
    subscribeHomeGovernanceSnapshots,
} from './homeGovernanceSnapshots';

const scopeA = createServerAccountScope('home_a', 'acc_1')!;
const scopeAOther = createServerAccountScope('home_a', 'acc_2')!;
const scopeB = createServerAccountScope('home_b', 'acc_1')!;

function projection(overrides: Partial<HomeGovernanceProjectionV1> = {}): HomeGovernanceProjectionV1 {
    return homeGovernanceProjectionFixture({
        viewer: { accountId: 'acc_1', homeRole: 'owner', status: 'active' },
        capabilities: { ...NO_HOME_CAPABILITIES_V1, viewAdministration: true },
        activeOwnerCount: 1,
        ...overrides,
    });
}

afterEach(() => {
    resetHomeGovernanceSnapshotsForTests();
});

describe('home governance snapshots', () => {
    it('has no observation until one is applied, so an unloaded Home cannot read as granted', () => {
        expect(getHomeGovernanceSnapshot(scopeA)).toBeNull();
        expect(getHomeGovernanceSnapshot(null)).toBeNull();
    });

    it('keeps two Accounts on one Home in separate rows', () => {
        applyHomeGovernanceProjection({ scope: scopeA, projection: projection(), observedAt: 10 });
        applyHomeGovernanceProjection({
            scope: scopeAOther,
            projection: projection({
                viewer: { accountId: 'acc_2', homeRole: 'member', status: 'active' },
                capabilities: NO_HOME_CAPABILITIES_V1,
            }),
            observedAt: 11,
        });

        expect(getHomeGovernanceSnapshot(scopeA)?.data?.viewer.accountId).toBe('acc_1');
        expect(getHomeGovernanceSnapshot(scopeA)?.data?.capabilities.viewAdministration).toBe(true);
        expect(getHomeGovernanceSnapshot(scopeAOther)?.data?.capabilities.viewAdministration).toBe(false);
    });

    it('shows loading only before the first observation and refreshing afterwards', () => {
        beginHomeGovernanceLoad(scopeA);
        expect(getHomeGovernanceSnapshot(scopeA)).toMatchObject({ status: 'loading', data: null });

        applyHomeGovernanceProjection({ scope: scopeA, projection: projection(), observedAt: 20 });
        beginHomeGovernanceLoad(scopeA);

        const refreshing = getHomeGovernanceSnapshot(scopeA);
        expect(refreshing?.status).toBe('refreshing');
        expect(refreshing?.data?.viewer.accountId).toBe('acc_1');
        expect(refreshing?.lastObservedAt).toBe(20);
    });

    it('retains the last successful projection through a failure and marks it stale', () => {
        applyHomeGovernanceProjection({ scope: scopeA, projection: projection(), observedAt: 30 });
        applyHomeGovernanceFailure({ scope: scopeA, error: { kind: 'unreachable', retryable: true } });

        const snapshot = getHomeGovernanceSnapshot(scopeA);
        expect(snapshot?.status).toBe('error');
        expect(snapshot?.data?.viewer.accountId).toBe('acc_1');
        expect(snapshot?.stale).toBe(true);
        expect(snapshot?.lastObservedAt).toBe(30);
        expect(snapshot?.reachability).toBe('unreachable');
        expect(snapshot?.error).toEqual({ kind: 'unreachable', retryable: true });
    });

    it('reports an unauthorized Home without inventing a stale observation', () => {
        applyHomeGovernanceFailure({ scope: scopeA, error: { kind: 'unauthorized', retryable: false } });

        const snapshot = getHomeGovernanceSnapshot(scopeA);
        expect(snapshot?.data).toBeNull();
        expect(snapshot?.stale).toBe(false);
        expect(snapshot?.reachability).toBe('unauthorized');
    });

    it('withdraws retained authority when the Home authoritatively refuses the projection', () => {
        applyHomeGovernanceProjection({ scope: scopeA, projection: projection(), observedAt: 35 });

        applyHomeGovernanceFailure({ scope: scopeA, error: { kind: 'unsupported', retryable: false } });

        const snapshot = getHomeGovernanceSnapshot(scopeA);
        // The Home answered, so reachability remains truthful, but a retained
        // capability projection may no longer authorize UI after that answer.
        expect(snapshot?.reachability).toBe('reachable');
        expect(snapshot?.data).toBeNull();
        expect(snapshot?.lastObservedAt).toBeNull();
        expect(snapshot?.stale).toBe(false);
        expect(snapshot?.error).toEqual({ kind: 'unsupported', retryable: false });
    });

    it('clears the error when the next load starts but keeps the stale marking', () => {
        applyHomeGovernanceProjection({ scope: scopeA, projection: projection(), observedAt: 40 });
        applyHomeGovernanceFailure({ scope: scopeA, error: { kind: 'unknown', retryable: true } });
        beginHomeGovernanceLoad(scopeA);

        const snapshot = getHomeGovernanceSnapshot(scopeA);
        expect(snapshot?.status).toBe('refreshing');
        expect(snapshot?.error).toBeNull();
        expect(snapshot?.stale).toBe(true);
    });

    it('keeps an ownerless Home ownerless while it is read again, so its claim page never flashes loading', async () => {
        const { resolveHomeGovernanceViewState } = await import('@/components/settings/home/governance/homeGovernanceViewState');
        applyHomeGovernanceFailure({
            scope: scopeA,
            error: { kind: 'forbidden', retryable: false, code: 'home_governance_setup_required' },
        });
        beginHomeGovernanceLoad(scopeA);

        const snapshot = getHomeGovernanceSnapshot(scopeA);
        expect(snapshot?.status).toBe('refreshing');
        expect(resolveHomeGovernanceViewState(snapshot)).toEqual({ kind: 'setup_required' });
    });

    it('invalidates only the wakened Home and leaves other Homes untouched', () => {
        applyHomeGovernanceProjection({ scope: scopeA, projection: projection(), observedAt: 50 });
        applyHomeGovernanceProjection({ scope: scopeB, projection: projection(), observedAt: 51 });
        const untouched = getHomeGovernanceSnapshot(scopeB);

        expect(invalidateHomeGovernanceSnapshotsForServer('home_a')).toBe(true);

        expect(getHomeGovernanceSnapshot(scopeA)?.stale).toBe(true);
        expect(getHomeGovernanceSnapshot(scopeA)?.data?.viewer.accountId).toBe('acc_1');
        expect(getHomeGovernanceSnapshot(scopeB)).toBe(untouched);
    });

    it('does not notify subscribers when an invalidation changes nothing', () => {
        applyHomeGovernanceProjection({ scope: scopeA, projection: projection(), observedAt: 60 });
        const listener = vi.fn();
        subscribeHomeGovernanceSnapshots(listener);

        expect(invalidateHomeGovernanceSnapshotsForServer('home_a')).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);

        // Already stale, and an unknown Home, must both be silent.
        expect(invalidateHomeGovernanceSnapshotsForServer('home_a')).toBe(false);
        expect(invalidateHomeGovernanceSnapshotsForServer('home_zzz')).toBe(false);
        expect(invalidateHomeGovernanceSnapshotsForServer('  ')).toBe(false);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('preserves referential identity for rows an invalidation did not touch', () => {
        applyHomeGovernanceProjection({ scope: scopeA, projection: projection(), observedAt: 70 });
        const before = getHomeGovernanceSnapshot(scopeA);
        invalidateHomeGovernanceSnapshotsForServer('home_b');
        expect(getHomeGovernanceSnapshot(scopeA)).toBe(before);
    });

    it('drops every Account row for one Home when its credentials go away', () => {
        applyHomeGovernanceProjection({ scope: scopeA, projection: projection(), observedAt: 80 });
        applyHomeGovernanceProjection({ scope: scopeAOther, projection: projection(), observedAt: 81 });
        applyHomeGovernanceProjection({ scope: scopeB, projection: projection(), observedAt: 82 });

        clearHomeGovernanceSnapshotsForServer('home_a');

        expect(getHomeGovernanceSnapshot(scopeA)).toBeNull();
        expect(getHomeGovernanceSnapshot(scopeAOther)).toBeNull();
        expect(getHomeGovernanceSnapshot(scopeB)).not.toBeNull();
    });

    it('stops notifying a disposed subscriber', () => {
        const listener = vi.fn();
        const dispose = subscribeHomeGovernanceSnapshots(listener);
        applyHomeGovernanceProjection({ scope: scopeA, projection: projection(), observedAt: 90 });
        expect(listener).toHaveBeenCalledTimes(1);

        dispose();
        applyHomeGovernanceProjection({ scope: scopeA, projection: projection(), observedAt: 91 });
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
