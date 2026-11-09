import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConcurrentCacheNetworkHarness } from '@/dev/testkit/harness/concurrentCacheNetworkHarness';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { subscribeHomeAccountChange } from './homeAccountChange';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const h = await createConcurrentCacheNetworkHarness('stationary-changes');
beforeEach(() => h.reset());
afterEach(async () => { await h.cleanup(); vi.restoreAllMocks(); });
afterAll(() => h.dispose());

describe('stationary Account-change transport cost', () => {
    it('keeps a usable cursor after long downtime and reads Account content only for a changed fact', async () => {
        const { sync } = await import('@/sync/sync');
        let revision = 0;
        let unavailable = false;
        const machineId = 'reconnect-machine';
        const machine = () => ({ ...h.machine(h.homeA, machineId), seq: revision + 1, daemonStateVersion: revision + 1 });
        h.setMachines(h.homeA, [machine()]);
        h.setResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v2/cursor') return Response.json({ cursor: revision, changesFloor: 0 });
            if (path === '/v2/changes' && unavailable) return Response.json({ error: 'unavailable' }, { status: 503 });
            if (path === '/v2/changes') return Response.json({ changes: revision === 0 ? []
                : [{ cursor: revision, kind: 'machine', entityId: machineId, changedAt: revision }], nextCursor: revision });
            if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(
                JSON.parse(String(init?.body)), id => id === machineId ? machine() : null);
            return null;
        });
        await h.startFocused();
        await sync.resumeSync('socket-reconnect');
        const socket = h.network.socketBoundaries.find(boundary => boundary.serverUrl === h.homeA.serverUrl
            && boundary.socket.onAny.mock.calls.length > 0);
        expect(socket).toBeDefined();
        let now = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        socket!.trigger('disconnect', 'transport close');
        now += (sync as unknown as { syncTuning: { messageForceSnapshotOfflineMs: number } }).syncTuning.messageForceSnapshotOfflineMs;
        h.httpRequests.length = 0;
        await sync.resumeSync('socket-reconnect');
        expect(h.requests('/v2/changes')).toHaveLength(1);
        // Session/Machine presence has no durable replay and keeps its own
        // lost-ephemeral recovery. Unchanged Account content needs no census.
        const accountInventories = ['/v1/artifacts', '/v2/account/settings', '/v1/account/profile',
            '/v1/friends', '/v1/feed', '/v1/automations', '/v1/kv'];
        expect(h.httpRequests.filter(({ url }) => accountInventories.includes(url.pathname))).toEqual([]);
        h.httpRequests.length = 0;
        revision = 1;
        await sync.resumeSync('changes-catch-up');
        expect(h.storage.getState().machineRecordsByServerId[h.homeA.id]?.[machineId]?.seq).toBe(2);
        const cursorBeforeFailure = (sync as unknown as { changesCursor: string | null }).changesCursor;
        expect(cursorBeforeFailure).toBe('1');
        expect(h.requests('/v1/machines/read-batch')).toHaveLength(1);
        expect(h.requests('/v1/artifacts')).toEqual([]);
        h.httpRequests.length = 0;
        unavailable = true;
        await expect(sync.resumeSync('changes-catch-up')).rejects.toMatchObject({ name: 'HappyError', canTryAgain: true });
        expect(h.storage.getState().syncError).toMatchObject({ retryable: true });
        expect((sync as unknown as { changesCursor: string | null }).changesCursor).toBe(cursorBeforeFailure);
        expect(h.httpRequests.filter(({ url }) => accountInventories.includes(url.pathname))).toEqual([]);
        h.httpRequests.length = 0;
        unavailable = false;
        revision = 2;
        await sync.resumeSync('changes-catch-up');
        expect(h.storage.getState().machineRecordsByServerId[h.homeA.id]?.[machineId]?.seq).toBe(3);
        expect((sync as unknown as { changesCursor: string | null }).changesCursor).toBe('2');
        expect(h.requests('/v2/changes').filter(({ url }) => url.origin === h.homeA.serverUrl)
            .map(({ url }) => url.searchParams.get('after'))).toContain(cursorBeforeFailure);
        expect(h.requests('/v1/machines/read-batch')).toHaveLength(1);
        expect(h.requests('/v1/artifacts')).toEqual([]);
    });

    it('routes settings versions without inventory reads and retains exact Machine and unknown recovery reads', async () => {
        const sessions = Array.from({ length: 1_000 }, (_, index) => h.session({ id: `session-${index}` }));
        let machines = Array.from({ length: 137 }, (_, index) => h.machine(h.homeB, `machine-${index}`));
        h.setSessions(h.homeB, sessions);
        h.setMachines(h.homeB, machines);
        h.setResponder(async (input, init) => new URL(String(input)).pathname === '/v1/machines/read-batch'
            ? createMachineReadBatchResponseFixture(JSON.parse(String(init?.body)), id => machines.find(row => row.id === id) ?? null)
            : null);
        await h.start();
        // Join the real snapshot owner before measuring this scale-shaped corpus.
        await h.refresh();
        await h.ready();
        const inventories = () => h.httpRequests.filter(({ url }) => [
            '/v2/sessions', '/v2/sessions/active', '/v2/sessions/query', '/v2/sessions/read-batch',
            '/v1/machines', '/v1/machines/read-batch',
        ].includes(url.pathname));
        const before = inventories().length;
        const initialSessionReads = h.requests('/v2/sessions').length;
        const versions: boolean[] = [];
        const release = subscribeHomeAccountChange(event => {
            if (event.serverId === h.homeB.id) versions.push(event.accountSettingsAffects === true);
        });
        vi.useFakeTimers();
        try {
            for (let version = 2; version <= 21; version++) {
                h.socket().trigger('update', { id: `settings-${version}`, seq: version, createdAt: version,
                    body: { t: 'account-settings-changed', settingsVersion: version } });
            }
            await vi.advanceTimersByTimeAsync(601);
            expect.soft(inventories().length - before, 'Settings writes cannot demand Session or Machine rows').toBe(0);
            expect.soft(versions, 'The Settings consumer must still receive every committed settings fact').toEqual(Array(20).fill(true));

            machines = [{ ...machines[0]!, seq: 2, daemonStateVersion: 2 }, ...machines.slice(1)];
            h.setMachines(h.homeB, machines);
            const machineReads = h.requests('/v1/machines/read-batch').length;
            h.socket().trigger('update', { id: 'machine-change', seq: 22, createdAt: 22,
                body: { t: 'account-change', changeKinds: ['machine'], entityIds: ['machine-0'] } });
            await vi.advanceTimersByTimeAsync(601);
            await vi.waitFor(() => expect(h.storage.getState().machineRecordsByServerId[h.homeB.id]?.['machine-0']?.seq).toBe(2));
            expect(h.requests('/v1/machines/read-batch').slice(machineReads)
                .map(request => JSON.parse(String(request.init?.body)).machineIds)).toEqual([['machine-0']]);
            expect(h.requests('/v2/sessions')).toHaveLength(initialSessionReads);

            const sessionReads = h.requests('/v2/sessions').length;
            const machineCensuses = h.requests('/v1/machines').length;
            h.setSessions(h.homeB, [...sessions, h.session({ id: 'recovered-session' })]);
            h.socket().trigger('update', { id: 'unknown-change', seq: 23, createdAt: 23,
                body: { t: 'account-change' } });
            await vi.advanceTimersByTimeAsync(601);
            await vi.waitFor(() => expect(h.storage.getState().sessionListRowsByServerId[h.homeB.id]?.['recovered-session']).toBeDefined());
            expect(h.requests('/v2/sessions').length - sessionReads).toBe(1);
            expect(h.requests('/v1/machines').length - machineCensuses).toBe(1);
        } finally {
            release();
            vi.useRealTimers();
        }
    });
});
