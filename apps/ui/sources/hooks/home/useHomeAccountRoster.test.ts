import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { act, createDeferred, homeAccountRowFixture, renderHook, standardCleanup } from '@/dev/testkit';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { useHomeAccountRoster } = await import('./useHomeAccountRoster');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { loadMoreHomeAccountRoster, refreshHomeAccountRoster, resetHomeAccountRosterEngineForTests } = await import('@/sync/engine/home/governance/homeAccountRosterEngine');
const { resetHomeAccountRosterSnapshotsForTests } = await import('@/sync/store/home/governance/homeAccountRosterSnapshots');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const PATH = '/v1/home/accounts/list';

// Keep cold module preparation outside the roster request's progress wait.
await loadSyncSingletonForTests();

beforeEach(async () => {
    resetHomeAccountRosterEngineForTests();
    resetHomeAccountRosterSnapshotsForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
});
afterEach(() => { standardCleanup(); });

describe('useHomeAccountRoster shared resource', () => {
    it('preserves all 400 unchanged row identities across a fresh HTTP read and changes only one material row', async () => {
        const serverId = await harness.addHome({ name: 'Roster identities', serverUrl: 'https://roster-identities.example', accountId: 'actor' });
        const scope = { serverId, accountId: 'actor' };
        // Scale-shaped admitted response: the result schema deliberately has no client row cap.
        const makeRows = () => Array.from({ length: 400 }, (_, index) => homeAccountRowFixture(`person-${index}`));
        harness.answer(serverId, PATH, { body: { items: makeRows(), nextCursor: null, total: 400 } });
        const hook = await renderHook(() => useHomeAccountRoster(scope, true));
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        const admitted = hook.getCurrent().rows;

        const heldRead = createDeferred<void>();
        harness.answer(serverId, PATH, { body: { items: makeRows(), nextCursor: null, total: 401 }, respondAfter: heldRead.promise });
        let refresh!: Promise<void>;
        await act(async () => { refresh = refreshHomeAccountRoster(scope); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('loading'));
        expect(hook.getCurrent().rows).toBe(admitted);
        await act(async () => { heldRead.resolve(); await refresh; });
        expect(hook.getCurrent().status).toBe('ready');
        expect(hook.getCurrent().total).toBe(401);
        expect(hook.getCurrent().rows.filter((row, index) => row !== admitted[index])).toHaveLength(0);
        expect(hook.getCurrent().rows).toBe(admitted);

        const changed = makeRows();
        changed[213] = homeAccountRowFixture('person-213', { mutationCapabilities: {
            ...changed[213].mutationCapabilities,
            setRole: { ...changed[213].mutationCapabilities.setRole, owner: { status: 'unavailable', reason: 'last_active_owner' } },
        } });
        harness.answer(serverId, PATH, { body: { items: changed, nextCursor: null, total: 400 } });
        await act(async () => { await refreshHomeAccountRoster(scope); });
        const edited = hook.getCurrent().rows;
        expect(edited).not.toBe(admitted);
        expect(edited.filter((row, index) => row !== admitted[index])).toHaveLength(1);
        expect(edited[213]).toEqual(changed[213]);

        harness.answer(serverId, PATH, { body: { items: [...changed].reverse().slice(1), nextCursor: 'next', total: 400 } });
        await act(async () => { await refreshHomeAccountRoster(scope); });
        const reordered = hook.getCurrent().rows;
        const byAccount = new Map(edited.map(row => [row.accountId, row]));
        expect(reordered.map(row => row.accountId)).toEqual([...changed].reverse().slice(1).map(row => row.accountId));
        expect(reordered.every(row => row === byAccount.get(row.accountId))).toBe(true);
        expect(hook.getCurrent().hasMore).toBe(true);
        expect(reordered).toHaveLength(399);

        harness.answer(serverId, PATH, { body: { items: [homeAccountRowFixture('added')], nextCursor: null, total: 401 } });
        await act(async () => { await loadMoreHomeAccountRoster(scope); });
        expect(hook.getCurrent().rows.slice(0, 399)).toEqual(reordered);
        expect(hook.getCurrent().rows.slice(0, 399).every((row, index) => row === reordered[index])).toBe(true);
        expect(hook.getCurrent().rows.at(-1)?.accountId).toBe('added');
        expect(hook.getCurrent().hasMore).toBe(false);
        expect(hook.getCurrent().total).toBe(401);
        expect(harness.requestsFor(PATH)).toHaveLength(5);
    });

    it('shares initial and wake reads with concurrent and later mounted consumers', async () => {
        const serverId = await harness.addHome({ name: 'Shared roster', serverUrl: 'https://roster-shared.example', accountId: 'actor' });
        const scope = { serverId, accountId: 'actor' };
        const row = homeAccountRowFixture('first');
        harness.answer(serverId, PATH, { body: { items: [row], nextCursor: null, total: 1 } });
        const pair = await renderHook(() => [useHomeAccountRoster(scope, true), useHomeAccountRoster(scope, true)]);
        await waitForHomeGovernance(() => expect(pair.getCurrent()[0].status).toBe('ready'));
        expect(pair.getCurrent().map(roster => roster.rows)).toEqual([[row], [row]]);
        expect(harness.requestsFor(PATH)).toHaveLength(1);
        const later = await renderHook(() => useHomeAccountRoster(scope, true));
        expect(later.getCurrent().rows).toBe(pair.getCurrent()[0].rows);
        expect(harness.requestsFor(PATH)).toHaveLength(1);

        const updated = homeAccountRowFixture('updated');
        harness.answer(serverId, PATH, { body: { items: [updated], nextCursor: null, total: 1 } });
        await act(async () => { publishHomeAccountChange(serverId); });
        await waitForHomeGovernance(() => expect(pair.getCurrent()[0].rows).toEqual([updated]));
        expect(harness.requestsFor(PATH)).toHaveLength(2);
        expect(pair.getCurrent().map(roster => roster.rows)).toEqual([[updated], [updated]]);
        expect(later.getCurrent().rows).toBe(pair.getCurrent()[0].rows);
    });

    it('shares continuation pages and explicit refresh while retaining data after a failed page', async () => {
        const serverId = await harness.addHome({ name: 'Paged roster', serverUrl: 'https://roster-pages.example', accountId: 'actor' });
        const scope = { serverId, accountId: 'actor' };
        const first = homeAccountRowFixture('first');
        const second = homeAccountRowFixture('second');
        harness.answer(serverId, PATH, { body: { items: [first], nextCursor: 'page-2' } });
        const pair = await renderHook(() => [useHomeAccountRoster(scope, true), useHomeAccountRoster(scope, true)]);
        await waitForHomeGovernance(() => expect(pair.getCurrent()[0].status).toBe('ready'));
        expect(pair.getCurrent()[0].total).toBeNull();
        harness.answer(serverId, PATH, { dispatchThenFail: true });
        const initialRequests = harness.requestsFor(PATH).length;
        await act(async () => { pair.getCurrent()[0].loadMore(); pair.getCurrent()[1].loadMore(); });
        await waitForHomeGovernance(() => expect(pair.getCurrent()[0].status).toBe('error'));
        expect(harness.requestsFor(PATH)).toHaveLength(initialRequests + 1);
        expect(pair.getCurrent()[1].rows).toEqual([first]);
        expect(pair.getCurrent()[1].hasMore).toBe(true);
        const continuation = createDeferred<void>();
        harness.answer(serverId, PATH, { select: input => typeof input === 'object' && input !== null && 'cursor' in input && input.cursor === 'page-2'
            ? { body: { items: [second], nextCursor: null }, respondAfter: continuation.promise }
            : { body: { items: [first], nextCursor: 'page-2' } } });
        await act(async () => { pair.getCurrent()[0].loadMore(); pair.getCurrent()[1].loadMore(); });
        await waitForHomeGovernance(() => { expect(harness.requestsFor(PATH).length).toBeGreaterThan(initialRequests + 1); });
        expect(harness.requestsFor(PATH)).toHaveLength(initialRequests + 2);
        expect(pair.getCurrent()[0].rows).toEqual([first]);
        await act(async () => { continuation.resolve(); });
        await waitForHomeGovernance(() => expect(pair.getCurrent()[0].status).toBe('ready'));
        expect(pair.getCurrent().map(roster => roster.rows)).toEqual([[first, second], [first, second]]);
        expect(pair.getCurrent()[0].hasMore).toBe(false);
        expect(pair.getCurrent()[0].total).toBe(2);

        harness.answer(serverId, PATH, { dispatchThenFail: true });
        await act(async () => { pair.getCurrent()[0].reload(); pair.getCurrent()[1].reload(); });
        await waitForHomeGovernance(() => expect(pair.getCurrent()[0].status).toBe('error'));
        expect(harness.requestsFor(PATH)).toHaveLength(initialRequests + 3);
        expect(pair.getCurrent().map(roster => roster.status)).toEqual(['error', 'error']);
        expect(pair.getCurrent()[1].rows).toEqual([first, second]);
        expect(pair.getCurrent()[1].total).toBe(2);
    });

    it('isolates Homes and Accounts and revalidates after the last observer leaves', async () => {
        const homeA = await harness.addHome({ name: 'Roster A', serverUrl: 'https://roster-a.example', accountId: 'actor-a' });
        const homeB = await harness.addHome({ name: 'Roster B', serverUrl: 'https://roster-b.example', accountId: 'actor-a' });
        const a = homeAccountRowFixture('person-a');
        const b = homeAccountRowFixture('person-b');
        const c = homeAccountRowFixture('person-c');
        harness.answer(homeA, PATH, { body: { items: [a], nextCursor: null } });
        harness.answer(homeB, PATH, { body: { items: [b], nextCursor: null } });
        const hook = await renderHook(({ scope }) => useHomeAccountRoster(scope, true), {
            initialProps: { scope: { serverId: homeA, accountId: 'actor-a' } },
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().rows).toEqual([a]);
        await hook.rerender({ scope: { serverId: homeB, accountId: 'actor-a' } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows).toEqual([b]));
        expect(hook.getCurrent().rows).toEqual([b]);
        await act(async () => { await harness.switchAccount(homeB, 'actor-b'); });
        expect(hook.getCurrent().rows).toEqual([]);
        harness.answer(homeB, PATH, { body: { items: [c], nextCursor: null } });
        await hook.rerender({ scope: { serverId: homeB, accountId: 'actor-b' } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows).toEqual([c]));
        expect(hook.getCurrent().rows).toEqual([c]);
        await hook.unmount();
        const reads = harness.requestsFor(PATH).length;
        const remount = await renderHook(() => useHomeAccountRoster({ serverId: homeB, accountId: 'actor-b' }, true));
        expect(remount.getCurrent().rows).toEqual([c]);
        expect(remount.getCurrent().status).toBe('ready');
        expect(harness.requestsFor(PATH)).toHaveLength(reads);

        harness.answer(homeB, PATH, { body: { items: [b], nextCursor: null } });
        await act(async () => { publishHomeAccountChange(homeB); });
        await waitForHomeGovernance(() => expect(remount.getCurrent().status).toBe('ready'));
        expect(remount.getCurrent().rows).toEqual([b]);
    });

    it.each(['wake', 'reload'] as const)('refreshes page one after a %s during a pending continuation', async trigger => {
        const serverId = await harness.addHome({ name: 'Interrupted paging', serverUrl: `https://roster-pending-${trigger}.example`, accountId: 'actor' });
        const scope = { serverId, accountId: 'actor' };
        const first = homeAccountRowFixture('first');
        const oldSecond = homeAccountRowFixture('old-second');
        const newest = homeAccountRowFixture('newest');
        harness.answer(serverId, PATH, { body: { items: [first], nextCursor: 'page-2' } });
        const pair = await renderHook(() => [useHomeAccountRoster(scope, true), useHomeAccountRoster(scope, true)]);
        await waitForHomeGovernance(() => expect(pair.getCurrent()[0].status).toBe('ready'));
        const page = createDeferred<void>();
        harness.answer(serverId, PATH, { body: { items: [oldSecond], nextCursor: null }, respondAfter: page.promise });
        await act(async () => { pair.getCurrent()[0].loadMore(); pair.getCurrent()[1].loadMore(); });
        await waitForHomeGovernance(() => expect(harness.requestsFor(PATH)).toHaveLength(2));
        harness.answer(serverId, PATH, { body: { items: [newest], nextCursor: null } });
        await act(async () => {
            if (trigger === 'wake') publishHomeAccountChange(serverId);
            else { pair.getCurrent()[0].reload(); pair.getCurrent()[1].reload(); }
        });
        expect(harness.requestsFor(PATH)).toHaveLength(2);
        expect(pair.getCurrent()[0].rows).toEqual([first]);
        await act(async () => { page.resolve(); });
        await waitForHomeGovernance(() => expect(pair.getCurrent()[0].rows).toEqual([newest]));
        expect(pair.getCurrent()[1].rows).toBe(pair.getCurrent()[0].rows);
        expect(harness.requestsFor(PATH)).toHaveLength(3);
        expect(harness.requestsFor(PATH).map(request => request.input)).toEqual([{}, { cursor: 'page-2' }, {}]);
    });

    it.each(['initial', 'refresh'] as const)('requires one newer first-page answer when reload interrupts a pending %s read', async phase => {
        const serverId = await harness.addHome({ name: 'Pending first page', serverUrl: `https://roster-first-page-${phase}.example`, accountId: 'actor' });
        const scope = { serverId, accountId: 'actor' };
        const older = homeAccountRowFixture('older');
        const newest = homeAccountRowFixture('newest');
        const pending = createDeferred<void>();
        const heldAnswer = { body: { items: [older], nextCursor: null }, respondAfter: pending.promise };
        harness.answer(serverId, PATH, phase === 'initial' ? heldAnswer : { body: { items: [older], nextCursor: null } });
        const pair = await renderHook(() => [useHomeAccountRoster(scope, true), useHomeAccountRoster(scope, true)]);
        if (phase === 'refresh') {
            await waitForHomeGovernance(() => expect(pair.getCurrent()[0].status).toBe('ready'));
            harness.answer(serverId, PATH, heldAnswer);
            await act(async () => { pair.getCurrent()[0].reload(); pair.getCurrent()[1].reload(); });
        }
        const startedReads = phase === 'initial' ? 1 : 2;
        await waitForHomeGovernance(() => expect(harness.requestsFor(PATH)).toHaveLength(startedReads));
        harness.answer(serverId, PATH, { body: { items: [newest], nextCursor: null } });
        let refreshes!: Promise<void>[];
        await act(async () => { refreshes = [refreshHomeAccountRoster(scope), refreshHomeAccountRoster(scope)]; });
        expect(harness.requestsFor(PATH)).toHaveLength(startedReads);
        await act(async () => { pending.resolve(); await Promise.all(refreshes); });
        expect(harness.requestsFor(PATH)).toHaveLength(startedReads + 1);
        expect(pair.getCurrent().map(roster => roster.rows)).toEqual([[newest], [newest]]);
        expect(pair.getCurrent().map(roster => roster.status)).toEqual(['ready', 'ready']);
    });

    it.each([401, 403, 404])('withdraws a %s-refused roster and does not resurrect it after credential retirement during a read', async status => {
        const serverId = await harness.addHome({ name: 'Retired roster', serverUrl: `https://roster-retired-${status}.example`, accountId: 'actor' });
        const row = homeAccountRowFixture('private-person');
        harness.answer(serverId, PATH, { body: { items: [row], nextCursor: null } });
        const hook = await renderHook(() => useHomeAccountRoster({ serverId, accountId: 'actor' }, true));
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        harness.answer(serverId, PATH, { status, body: {} });
        await act(async () => { hook.getCurrent().reload(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('error'));
        expect(hook.getCurrent().status).toBe('error');
        expect(hook.getCurrent().rows).toEqual([]);

        const oldRead = createDeferred<void>();
        harness.answer(serverId, PATH, { body: { items: [row], nextCursor: null }, respondAfter: oldRead.promise });
        const before = harness.requestsFor(PATH).length;
        await act(async () => { hook.getCurrent().reload(); });
        await waitForHomeGovernance(() => { expect(harness.requestsFor(PATH).length).toBeGreaterThan(before); });
        await act(async () => {
            if (status === 401) await TokenStorage.removeCredentialsForServerUrl(`https://roster-retired-${status}.example`, { serverId });
            else await harness.switchAccount(serverId, 'replacement');
        });
        expect(hook.getCurrent().rows).toEqual([]);
        await act(async () => { oldRead.resolve(); await refreshHomeAccountRoster({ serverId, accountId: 'actor' }); });
        expect(hook.getCurrent().rows).toEqual([]);
    });
});
