import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConcurrentCacheNetworkHarness } from '@/dev/testkit/harness/concurrentCacheNetworkHarness';
import { subscribeHomeCredentialMutations } from '@/auth/storage/tokenStorage';
import { subscribeHomeAccountChange } from './homeAccountChange';
import * as routes from '@/sync/domains/transfers/runtime/transferRouteCache';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const h = await createConcurrentCacheNetworkHarness('cache-supervised');
const observation = () => h.storage.getState().concurrentSessionListCacheByServerId[h.homeB.id]?.listObservation;
const status = () => h.storage.getState().machineListStatusByServerId[h.homeB.id];
const rows = () => h.storage.getState().sessionListRowsByServerId[h.homeB.id];
const machines = () => h.storage.getState().machineListByServerId[h.homeB.id];
const disposers: Array<() => void> = [];
beforeEach(() => h.reset());
afterEach(async () => { for (const dispose of disposers.splice(0)) dispose(); await h.cleanup(); });
afterAll(() => h.dispose());

function observeAccountChanges() {
    const observer = vi.fn();
    disposers.push(subscribeHomeAccountChange(observer));
    return observer;
}
function sessionUpdate() { h.socket().trigger('update', { body: { t: 'update-session' } }); }
function machineUpdate() { h.socket().trigger('update', { body: { t: 'update-machine' } }); }
function offline() { h.pool.reportServerUnreachable(h.homeB.serverUrl, new Error('Home unreachable'), h.homeB.token); }

const refreshPeriodMs = 5 * 60_000;
function observePeriodicClock() {
    const schedule = globalThis.setTimeout;
    const fires = vi.fn();
    // The clock is the external boundary; preserve every callback and its arguments.
    const scheduled = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
        schedule(() => {
            if (delay === refreshPeriodMs) fires();
            callback(...args);
        }, delay));
    return { fires, scheduled };
}

describe('concurrent session cache supervised sockets', () => {
    it('owns no periodic refresh timer or network when no secondary Home is selected', async () => {
        await h.select([h.homeA.id]);
        vi.useFakeTimers();
        const clock = observePeriodicClock();
        try {
            h.startConcurrentSessionCacheSync();
            await vi.advanceTimersByTimeAsync(2 * refreshPeriodMs + 1_000);
            expect(h.network.socketBoundaries).toHaveLength(0);
            expect(h.requests('/v2/sessions')).toHaveLength(0);
            expect(h.requests('/v1/machines')).toHaveLength(0);
            expect([clock.fires.mock.calls.length,
                clock.scheduled.mock.calls.filter(([, delay]) => delay === refreshPeriodMs).length]).toEqual([0, 0]);
        } finally {
            h.stopConcurrentSessionCacheSync();
            clock.scheduled.mockRestore();
            vi.useRealTimers();
        }
    });

    it('refreshes a selected background Home and retires its last timer before a late read can rearm it', async () => {
        vi.useFakeTimers();
        const clock = observePeriodicClock();
        let releaseLate: (() => void) | undefined;
        try {
            h.setSessions(h.homeB, [h.session({ id: 'initial' })]);
            await h.start(); await h.ready();
            const initialReads = h.requests('/v2/sessions').length;
            h.setSessions(h.homeB, [h.session({ id: 'periodic-current' })]);
            await vi.advanceTimersByTimeAsync(refreshPeriodMs + 1_000);
            await h.ready();
            expect(h.requests('/v2/sessions')).toHaveLength(initialReads + 1);
            expect(rows()?.['periodic-current']).toBeDefined();

            let signal: AbortSignal | null | undefined;
            h.setResponder(async (input, init) => {
                if (new URL(String(input)).pathname !== '/v2/sessions') return null;
                signal = init?.signal;
                await new Promise<void>(resolve => { releaseLate = resolve; });
                return Response.json({ sessions: [h.session({ id: 'late-retired' })], nextCursor: null, hasNext: false });
            });
            await vi.advanceTimersByTimeAsync(refreshPeriodMs);
            expect(releaseLate).toBeTypeOf('function');
            await h.select([h.homeA.id]);
            await vi.advanceTimersByTimeAsync(1);
            expect(signal?.aborted).toBe(true);
            expect(h.isConcurrentOrdinarySessionListHome(h.homeB.id)).toBe(false);
            const closedReads = h.requests('/v2/sessions').length;
            const closedFires = clock.fires.mock.calls.length;
            releaseLate?.();
            h.setResponder(null);
            await vi.advanceTimersByTimeAsync(2 * refreshPeriodMs + 1_000);
            expect(h.requests('/v2/sessions')).toHaveLength(closedReads);
            expect(rows()?.['late-retired']).toBeUndefined();
            const idleFires = clock.fires.mock.calls.length - closedFires;

            h.setSessions(h.homeB, [h.session({ id: 'reopened-current' })]);
            await h.select();
            await vi.advanceTimersByTimeAsync(1_000);
            await h.ready();
            expect(h.requests('/v2/sessions')).toHaveLength(closedReads + 1);
            expect(rows()?.['reopened-current']).toBeDefined();
            expect(idleFires).toBe(0);
        } finally {
            releaseLate?.();
            h.stopConcurrentSessionCacheSync();
            clock.scheduled.mockRestore();
            vi.useRealTimers();
        }
    });

    it('withdraws secondary-Home presence until fresh ingress for that exact Account and Machine', async () => {
        h.setMachines(h.homeB, [{ ...h.machine(h.homeB, 'presence-machine'), active: true, activeAt: Date.now() }]);
        await h.start(); await h.ready();
        const reachability = await import('@/sync/domains/machines/reachability/machineReachability');
        disposers.push(() => reachability.clearMachineRequestReachabilityForTest());
        const scope = { serverId: h.homeB.id, accountId: 'account-b' };
        const machine = { id: 'presence-machine', active: true, activeAt: Date.now() };
        expect(reachability.resolveMachineReachability(scope, machine)).toBe('reachable');
        const socket = h.socket();
        socket.trigger('disconnect', 'transport close');
        expect(reachability.resolveMachineReachability(scope, machine)).toBe('unknown');
        expect(reachability.isMachineReachable(scope, machine)).toBe(false);
        socket.trigger('ephemeral', { type: 'machine-activity', id: 'another-machine', active: true, activeAt: Date.now() });
        expect(reachability.resolveMachineReachability(scope, machine)).toBe('unknown');
        const machineReads = h.requests('/v1/machines').length;
        socket.trigger('ephemeral', { type: 'machine-activity', id: machine.id, active: true, activeAt: Date.now() });
        expect(reachability.resolveMachineReachability(scope, machine)).toBe('reachable');
        expect(reachability.resolveMachineReachability(scope, { ...machine, id: 'not-observed' })).toBe('unknown');
        const offlineAt = Date.now() + 1;
        socket.trigger('ephemeral', { type: 'machine-activity', id: machine.id, active: false, activeAt: offlineAt });
        const { readMachineActivity } = await import('@/sync/domains/machines/machineActivity');
        expect(readMachineActivity(machines()!.find(row => row.id === machine.id)!)).toMatchObject({ active: false, activeAt: offlineAt });
        expect(h.requests('/v1/machines')).toHaveLength(machineReads);
        reachability.recordMachineRequestFailed({ ...scope, machineId: machine.id });
        reachability.recordMachineRequestFailed({ ...scope, accountId: 'another-account', machineId: machine.id });
        const offline = { ...h.machine(h.homeB, machine.id), active: false, activeAt: 1 };
        h.setMachines(h.homeB, [offline]);
        socket.trigger('connect');
        await h.refresh();
        expect(reachability.readMachineRequestReachabilityObservation(scope, machine.id)).toBeNull();
        expect(reachability.resolveMachineReachability(scope, { ...machine, active: false, activeAt: 1 })).toBe('unreachable');
        expect(reachability.readMachineRequestReachabilityObservation({ ...scope, accountId: 'another-account' }, machine.id)?.outcome).toBe('failed');
    });
    it('recovers a retired Service watch when a daemon reconnects without reconnecting its Home', async () => {
        await h.start(); await h.ready();
        const inventory = await import('@/sync/domains/local/services/inventory/sharedStore');
        const reachability = await import('@/sync/domains/machines/reachability/machineReachability');
        const key = { serverId: h.homeB.id, machineId: 'service-machine' };
        const snapshot = { v: 1 as const, machineId: key.machineId, generatedAt: 1,
            refreshState: 'idle' as const, entries: [], diagnostics: [] };
        let watches = 0;
        disposers.push(() => inventory.resetLocalServiceInventoryStoreForTests());
        disposers.push(() => reachability.clearMachineRequestReachabilityForTest());
        disposers.push(inventory.subscribeLocalServiceInventoryStore(key, () => {}, {
            snapshotClient: async () => ({ ok: true, snapshot }),
            watchClient: async () => {
                if (++watches === 1) return { ok: false, reason: 'request_failed' };
                if (watches === 2) return { ok: true, changed: true, snapshot: { ...snapshot, generatedAt: 2 } };
                return new Promise(() => {});
            },
        }));
        await vi.waitFor(() => expect(inventory.getLocalServiceInventoryState(key).refreshState).toBe('error'));
        const scope = { serverId: key.serverId, accountId: 'account-b' };
        reachability.recordMachineRequestFailed({ ...scope, machineId: key.machineId });
        const socket = h.socket();
        socket.trigger('ephemeral', { type: 'machine-activity', id: key.machineId, active: true, activeAt: 1 });
        socket.trigger('ephemeral', { type: 'machine-activity', id: 'another-machine', active: true, activeAt: 2, reconnected: true });
        await Promise.resolve();
        expect(watches).toBe(1);
        socket.trigger('ephemeral', { type: 'machine-activity', id: key.machineId, active: true, activeAt: 3, reconnected: true });
        await vi.waitFor(() => expect(inventory.getLocalServiceInventoryState(key).generatedAt).toBe(2));
        expect(reachability.readMachineRequestReachabilityObservation(scope, key.machineId)).toBeNull();
        expect(socket.socket.connected).toBe(true);
    });
    it('retains the same managed Home and its rows while canonical identity discovery rereads its credentials', async () => {
        h.setSessions(h.homeB, [h.session({ id: 'retained-across-discovery' })]);
        await h.start(); await h.ready();
        const previousRows = rows();
        const previousSocket = h.socket().socket;
        const credentialRead = h.holdCredentialRead();
        const canonicalId = 'srv_cache_supervised_discovered';
        try {
            await h.profiles.setServerProfileIdentityForUrl(h.homeB.serverUrl, canonicalId);
            await vi.waitFor(() => expect(credentialRead.started).toBe(true));
            expect(readSessionListRowsForServerId(h.storage.getState().sessionListRowsByServerId, canonicalId)).toBe(previousRows);
            expect(previousSocket.connected).toBe(true);
        } finally {
            credentialRead.release();
        }
        await vi.waitFor(() => expect(h.readConcurrentOrdinarySessionListLifecycle(canonicalId).hasFetchedSnapshot).toBe(true));
        expect(h.socket().socket).toBe(previousSocket);
        expect(readSessionListRowsForServerId(h.storage.getState().sessionListRowsByServerId, canonicalId)?.['retained-across-discovery']).toBeDefined();
    });

    it.each(['matching', 'other'] as const)('applies activation authorization changes only to the %s Home of an open Session', async home => {
        const waiting = { requestId: 'retained-input', requestedAt: 1, status: 'waiting' as const };
        h.setSessions(h.homeB, [h.session({ id: 'session-b' })]);
        await h.start(); await h.ready();
        h.storage.getState().applySessions([createSessionFixture({ id: 'session-b', serverId: home === 'matching' ? h.homeB.id : h.homeA.id,
            pendingCount: 1, pendingVersion: 4, pendingActivationAuthorization: waiting })]);
        h.socket().trigger('update', { id: 'activation-failed', seq: 1, createdAt: 2, body: {
            t: 'pending-changed', sid: 'session-b', sessionId: 'session-b', pendingCount: 1, pendingVersion: 4,
            pendingActivationAuthorization: { ...waiting, status: 'failed', failureCode: 'runtime_start_failed' },
        } });
        if (home === 'matching') {
            await vi.waitFor(() => expect(h.storage.getState().sessions['session-b']?.pendingActivationAuthorization)
                .toMatchObject({ status: 'failed', failureCode: 'runtime_start_failed' }));
        } else {
            expect(h.storage.getState().sessions['session-b']?.pendingActivationAuthorization).toEqual(waiting);
        }
    });

    it('refreshes grant changes after an Account wake even when the secondary Session list is unavailable', async () => {
        const machine = h.machine(h.homeB);
        h.setMachines(h.homeB, [{ ...machine, access: { ...machine.access!, role: 'use' } }]);
        await h.start(); await h.ready();
        expect(machines()?.[0]?.access?.role).toBe('use');
        h.setMachines(h.homeB, [{ ...machine, access: { ...machine.access!, role: 'manage' } }]);
        h.setResponder(async input => new URL(String(input)).pathname === '/v2/sessions'
            ? Response.json({ error: 'Unavailable' }, { status: 503 }) : null);
        h.socket().trigger('update', { id: 'grant-changed', seq: 1, createdAt: 2, body: { t: 'account-change' } });
        await vi.waitFor(() => expect(machines()?.[0]?.access?.role).toBe('manage'));
    });

    it('retains an open attention frontier until the incumbent paginator explicitly continues it', async () => {
        let release!: () => void;
        h.setResponder(async input => {
            const url = new URL(String(input));
            if (url.pathname !== '/v2/sessions') return null;
            if (url.searchParams.has('attentionCursor')) {
                await new Promise<void>(resolve => { release = resolve; });
                return Response.json({ sessions: [h.session({ id: 'attention-next' })], nextCursor: null, hasNext: false,
                    attentionNextCursor: null, attentionHasNext: false });
            }
            return Response.json({ sessions: [], nextCursor: null, hasNext: false,
                attentionNextCursor: 'attention-next-page', attentionHasNext: true });
        });
        await h.start(); await h.ready();
        expect(h.readConcurrentOrdinarySessionListLifecycle(h.homeB.id).frontier).toMatchObject({
            attentionNextCursor: 'attention-next-page', attentionHasNext: true,
        });
        const continuation = h.loadNextConcurrentOrdinarySessionListPage(h.homeB.id);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        expect(observation()?.phase).toBe('refreshing');
        expect(h.requests('/v2/sessions').at(-1)?.url.searchParams.get('attentionCursor')).toBe('attention-next-page');
        release(); await continuation; await h.ready();
        expect(rows()?.['attention-next']).toBeDefined();
        expect(h.readConcurrentOrdinarySessionListLifecycle(h.homeB.id).frontier).toMatchObject({ attentionHasNext: false });
    });

    it('aborts an owned secondary HTTP snapshot before releasing its managed transport', async () => {
        let signal: AbortSignal | null | undefined;
        h.setResponder(async (input, init) => {
            if (new URL(String(input)).pathname !== '/v2/sessions') return null;
            signal = init?.signal;
            return await new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort',
                () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
        });
        await h.start();
        await vi.waitFor(() => expect(signal).toBeDefined());
        const socket = h.socket();
        h.stopConcurrentSessionCacheSync();
        expect(signal?.aborted).toBe(true);
        await vi.waitFor(() => expect(socket.socket.connected).toBe(false));
    });

    it('projects an authenticated HTTP rejection through the exact-token reachability owner', async () => {
        h.setResponder(async input => new URL(String(input)).pathname === '/v2/sessions'
            ? Response.json({ error: 'Unauthorized' }, { status: 401 }) : null);
        await h.start();
        await vi.waitFor(() => expect(h.pool.peekServerReachabilityState(h.homeB.serverUrl, h.homeB.token)?.phase).toBe('auth_failed'));
        expect(status()).toBe('signedOut');
        expect(h.pool.peekServerReachabilityState(h.homeB.serverUrl, 'unrelated-token')).toBeNull();
    });

    it('marks a cold secondary Home offline without manufacturing machine rows or a socket', async () => {
        h.setResponder(async input => {
            if (new URL(String(input)).pathname === '/v1/auth/ping') throw new TypeError('Network unavailable');
            return null;
        });
        h.startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(status()).toBe('error'));
        expect(machines()).toBeNull();
        expect(h.network.socketBoundaries).toHaveLength(0);
    });

    it('consumes the shared reachability pool already-online initial state', async () => {
        const lease = await h.pool.acquireServerReachabilitySupervisor({ serverUrl: h.homeB.serverUrl, token: h.homeB.token });
        await vi.waitFor(() => expect(h.pool.peekServerReachabilityState(h.homeB.serverUrl, h.homeB.token)?.phase).toBe('online'));
        await h.start(); await h.ready();
        expect(h.socket().socket.connected).toBe(true);
        await lease.release();
    });

    it('publishes loading, ready, refreshing and error without losing the last successful observation time', async () => {
        const phases: string[] = [];
        disposers.push(h.storage.subscribe(state => {
            const phase = state.concurrentSessionListCacheByServerId[h.homeB.id]?.listObservation?.phase;
            if (phase && phases.at(-1) !== phase) phases.push(phase);
        }));
        await h.start(); await h.ready();
        const successAt = observation()?.lastSuccessAt;
        h.setResponder(async input => new URL(String(input)).pathname === '/v2/sessions'
            ? Response.json({ error: 'Unavailable' }, { status: 503 }) : null);
        sessionUpdate();
        await vi.waitFor(() => expect(observation()).toEqual({ phase: 'error', lastSuccessAt: successAt, failure: { reason: 'response', code: null } }));
        expect(phases.slice(0, 2)).toEqual(['loading', 'ready']);
        expect(phases.slice(-2)).toEqual(['refreshing', 'error']);
        expect(phases.slice(1)).not.toContain('loading');
    });

    it('keeps the successfully observed Session list current when the machine tail fails', async () => {
        h.setSessions(h.homeB, [h.session({ id: 'session-b' })]);
        await h.start(); await h.ready();
        h.setResponder(async input => new URL(String(input)).pathname === '/v1/machines'
            ? Response.json({ error: 'Unavailable' }, { status: 503 }) : null);
        await h.refresh();
        expect(status()).toBe('error');
        expect(observation()?.phase).toBe('ready');
        expect(rows()?.['session-b']).toBeDefined();
    });

    it('leaves the reachability owner offline fact intact after the interrupted HTTP request fails', async () => {
        await h.start(); await h.ready();
        let rejectRefresh!: () => void;
        h.setResponder(async input => {
            if (new URL(String(input)).pathname === '/v1/auth/ping') throw new TypeError('Network unavailable');
            if (new URL(String(input)).pathname !== '/v2/sessions') return null;
            return await new Promise<Response>((_resolve, reject) => { rejectRefresh = () => reject(new TypeError('Connection lost')); });
        });
        const refreshing = h.refresh();
        await vi.waitFor(() => expect(rejectRefresh).toBeTypeOf('function'));
        offline();
        await vi.waitFor(() => expect(observation()?.phase).toBe('offline'));
        rejectRefresh(); await refreshing;
        expect(observation()?.phase).toBe('offline');
        expect(status()).toBe('error');
    });

    it('preserves last-known rows while offline and restores currentness without duplication', async () => {
        h.setSessions(h.homeB, [h.session({ id: 'session-b' })]);
        h.setMachines(h.homeB, [h.machine(h.homeB)]);
        await h.start(); await h.ready();
        const currentRows = rows(); const currentMachines = machines();
        let reachable = false;
        h.setResponder(async input => {
            if (new URL(String(input)).pathname === '/v1/auth/ping' && !reachable) throw new TypeError('Offline');
            return null;
        });
        offline();
        await vi.waitFor(() => expect(observation()?.phase).toBe('offline'));
        expect(rows()).toBe(currentRows); expect(machines()).toBe(currentMachines);
        reachable = true;
        await h.pool.invalidateServerReachabilitySupervisor({ serverUrl: h.homeB.serverUrl, token: h.homeB.token });
        await h.ready();
        await vi.waitFor(() => expect(status()).toBe('idle'));
        expect(Object.keys(rows() ?? {})).toEqual(['session-b']);
        expect(machines()?.map(machine => machine.id)).toEqual(['machine-b']);
        expect(rows()).toBe(currentRows); expect(machines()).toBe(currentMachines);
    });

    it('preserves the whole last-known snapshot when a machine-only refresh fails', async () => {
        h.setSessions(h.homeB, [h.session({ id: 'session-b' })]); h.setMachines(h.homeB, [h.machine(h.homeB)]);
        await h.start(); await h.ready();
        const currentRows = rows(); const currentMachines = machines();
        h.setResponder(async input => new URL(String(input)).pathname === '/v1/machines'
            ? Response.json({ error: 'Unavailable' }, { status: 503 }) : null);
        await h.refreshConcurrentMachineList(h.homeB.id);
        expect(status()).toBe('error');
        expect(rows()).toBe(currentRows); expect(machines()).toBe(currentMachines);
        expect(observation()?.phase).toBe('ready');
    });

    it('recovers from an external Socket construction failure through canonical reconciliation', async () => {
        let first = true;
        h.network.setSocketConfigurator(() => { if (first) { first = false; throw new Error('Socket construction failed'); } });
        h.startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(h.network.socketBoundaries).toHaveLength(1));
        expect(h.network.socketBoundaries[0].socket.connected).toBe(false);
        h.network.setSocketConfigurator(() => {});
        await h.profiles.upsertServerProfile({ serverUrl: h.homeB.serverUrl, name: 'Retry B' });
        await h.ready();
        expect(h.socket().socket.connected).toBe(true);
    });

    it('does not connect while the network is disallowed and connects after re-enabling it', async () => {
        h.pool.setServerReachabilityNetworkAllowed(false);
        h.startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(h.isConcurrentOrdinarySessionListHome(h.homeB.id)).toBe(true));
        expect(h.network.socketBoundaries).toHaveLength(0);
        h.pool.setServerReachabilityNetworkAllowed(true);
        await h.ready();
        expect(h.socket().socket.connected).toBe(true);
    });

    it('opens the secondary socket with that exact Home Account credential', async () => {
        await h.start(); await h.ready();
        expect(h.io).toHaveBeenCalledWith(h.homeB.serverUrl, expect.objectContaining({
            path: '/v1/updates/', auth: expect.objectContaining({ token: h.homeB.token, clientType: 'user-scoped' }),
            reconnection: false, autoConnect: false,
        }));
        expect(h.network.socketBoundaries.every(socket => socket.serverUrl !== h.homeA.serverUrl)).toBe(true);
    });

    it('invalidates focused transfer routes when the applied generation changes', async () => {
        await h.start(); await h.ready();
        const applied = await import('./appliedActiveServerRuntime');
        const key = { serverId: h.homeA.id, remoteMachineId: 'machine-a' };
        routes.recordCachedMachineRpcDirectRouteViable(key);
        applied.publishAppliedActiveServerSnapshot({ ...applied.getAppliedActiveServerSnapshot(),
            serverId: h.homeA.id, serverUrl: h.homeA.serverUrl, generation: applied.getAppliedActiveServerSnapshot().generation + 1 });
        expect(routes.readCachedMachineRpcDirectRoute(key)).toEqual({ status: 'unknown' });
    });

    it('invalidates previous and next transfer routes when the applied Home changes', async () => {
        await h.start(); await h.ready();
        const applied = await import('./appliedActiveServerRuntime');
        const keys = [h.homeA.id, h.homeB.id].map(serverId => ({ serverId, remoteMachineId: 'machine' }));
        for (const key of keys) routes.recordCachedMachineRpcDirectRouteViable(key);
        applied.publishAppliedActiveServerSnapshot({ serverId: h.homeB.id, serverUrl: h.homeB.serverUrl, generation: 1 });
        for (const key of keys) expect(routes.readCachedMachineRpcDirectRoute(key)).toEqual({ status: 'unknown' });
        applied.publishAppliedActiveServerSnapshot({ serverId: h.homeA.id, serverUrl: h.homeA.serverUrl, generation: 1 }, false);
    });

    it('subscribes to explicit update and ephemeral channels without an unbounded onAny listener', async () => {
        await h.start(); await h.ready();
        const socket = h.socket();
        expect(socket.listeners.get('update')?.size).toBeGreaterThan(0);
        expect(socket.listeners.get('ephemeral')?.size).toBeGreaterThan(0);
        expect(socket.socket.onAny).not.toHaveBeenCalled();
    });

    it('feeds machine activity transitions to the real external status-demand recovery owner', async () => {
        const coordinator = await import('./externalSessions/externalSessionStatusDemandCoordinator');
        disposers.push(() => coordinator.resetExternalSessionStatusDemandCoordinatorForTests());
        coordinator.replaceExternalSessionStatusDemandViewport('cache-test', [{
            serverId: h.homeB.id, sessionId: 'session-b', machineId: 'machine-b', linkGeneration: 'generation-b', demand: 'visible',
        }]);
        await h.start(); await h.ready();
        const socket = h.socket(); socket.socket.emit.mockClear();
        for (const activeAt of [1000, 1001]) socket.trigger('ephemeral', { type: 'machine-activity', id: 'machine-b', active: true, activeAt });
        expect(socket.socket.emit).toHaveBeenCalledTimes(1);
        expect(socket.socket.emit).toHaveBeenLastCalledWith('external-session-status-demand-v1', expect.objectContaining({ revision: 3 }));
        socket.trigger('ephemeral', { type: 'machine-activity', id: 'machine-b', active: false, activeAt: 1002 });
        socket.trigger('ephemeral', { type: 'machine-activity', id: 'machine-b', active: true, activeAt: 1003 });
        expect(socket.socket.emit).toHaveBeenCalledTimes(2);
        expect(socket.socket.emit).toHaveBeenLastCalledWith('external-session-status-demand-v1', expect.objectContaining({ revision: 4 }));
    });

    it('refreshes only remote machine inventory after a machine update', async () => {
        h.setMachines(h.homeB, [h.machine(h.homeB)]);
        await h.start(); await h.ready();
        const sessionReads = h.requests('/v2/sessions').length;
        h.setMachines(h.homeB, [{ ...h.machine(h.homeB), seq: 2, daemonStateVersion: 2 }]);
        machineUpdate();
        await vi.waitFor(() => expect(machines()?.[0]?.seq).toBe(2));
        expect(h.requests('/v2/sessions')).toHaveLength(sessionReads);
    });

    it.each(['session-b', null])('publishes content-free Account and committed usage wakes without unrelated refreshes (%s)', async sessionId => {
        await h.start(); await h.ready();
        const observer = observeAccountChanges();
        const sessionReads = h.requests('/v2/sessions').length;
        const machineReads = h.requests('/v1/machines').length;
        const socket = h.socket();
        socket.trigger('update', { id: 'account-1', seq: 11, createdAt: 11, body: { t: 'update-account', settings: { value: 'encrypted', version: 2 } } });
        expect(observer).toHaveBeenLastCalledWith({ serverId: h.homeB.id, accountSettingsAffects: true });
        socket.trigger('ephemeral', { type: 'usage', id: sessionId, key: 'codex:model', tokens: { total: 1 }, cost: { total: 0 }, timestamp: 1000 });
        expect(observer).toHaveBeenLastCalledWith({ serverId: h.homeB.id, entityIds: ['provider-account-usage'], accountSettingsAffects: true });
        socket.trigger('ephemeral', { type: 'usage-sources-invalidated', machineId: 'machine-b', installationId: 'installation-b' });
        expect(observer).toHaveBeenCalledTimes(3);
        expect(observer).toHaveBeenLastCalledWith({ serverId: h.homeB.id, entityIds: ['provider-account-usage'], accountSettingsAffects: true });
        expect(h.requests('/v2/sessions')).toHaveLength(sessionReads);
        expect(h.requests('/v1/machines')).toHaveLength(machineReads);
    });

    it('does not interpret a machine update as an Account-change wake', async () => {
        await h.start(); await h.ready();
        const observer = observeAccountChanges();
        machineUpdate();
        expect(observer).not.toHaveBeenCalled();
    });

    it('invalidates exact-Home Account projections when a secondary socket reconnects', async () => {
        const observer = observeAccountChanges();
        await h.start(); await h.ready();
        expect(observer).toHaveBeenLastCalledWith({ serverId: h.homeB.id, source: 'connected', accountSettingsAffects: true });
        observer.mockClear();
        h.socket().trigger('connect');
        expect(observer).toHaveBeenCalledTimes(1);
        expect(observer).toHaveBeenCalledWith({ serverId: h.homeB.id, source: 'connected', accountSettingsAffects: true });
    });

    it('uses one supervised reconnect owner and disposes the secondary transport on stop', async () => {
        await h.start(); await h.ready();
        expect(h.io).toHaveBeenCalledWith(h.homeB.serverUrl, expect.objectContaining({ reconnection: false, autoConnect: false }));
        const socket = h.socket();
        h.stopConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(socket.socket.connected).toBe(false));
        expect(socket.listeners.size).toBe(0);
    });
});

describe('concurrent session cache exact-target credential reconciliation', () => {
    it('removes a running secondary transport promptly after global credential forget', async () => {
        await h.start(); await h.ready();
        const socket = h.socket();
        expect(await h.TokenStorage.removeCredentials()).toBe(true);
        await vi.waitFor(() => expect(status()).toBe('signedOut'));
        expect(socket.socket.connected).toBe(false);
        expect(h.network.socketBoundaries).toHaveLength(1);
    });

    it('replaces only the exact secondary transport for a changed token and ignores byte-identical writes', async () => {
        await h.start(); await h.ready();
        const focused = await h.TokenStorage.getCredentialsForServerUrl(h.homeA.serverUrl, { serverId: h.homeA.id });
        const socket = h.socket();
        // A different bearer for the same Account, not a fabricated Account switch.
        const [header, payload] = h.homeB.token.split('.');
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
        const token = header + '.' + Buffer.from(JSON.stringify({ ...claims, jti: 'replacement' })).toString('base64url') + '.signature';
        expect(await h.TokenStorage.setCredentialsForServerUrl(h.homeB.serverUrl, { serverId: h.homeB.id }, { token })).toBe(true);
        await vi.waitFor(() => expect(h.socket().token === token).toBe(true));
        expect(socket.socket.connected).toBe(false);
        expect(await h.TokenStorage.getCredentialsForServerUrl(h.homeA.serverUrl, { serverId: h.homeA.id })).toEqual(focused);
        const replacement = h.socket();
        expect(await h.TokenStorage.setCredentialsForServerUrl(h.homeB.serverUrl, { serverId: h.homeB.id }, { token })).toBe(true);
        expect(h.socket()).toBe(replacement);
        expect(replacement.socket.connected).toBe(true);
    });

    it('emits no mutation and restarts no transport when the OS refuses an exact-target credential write', async () => {
        await h.start(); await h.ready();
        const socket = h.socket();
        const events: unknown[] = [];
        disposers.push(subscribeHomeCredentialMutations(event => events.push(event)));
        h.rejectCredentialWrites(true);
        const written = await h.TokenStorage.setCredentialsForServerUrl(h.homeB.serverUrl, { serverId: h.homeB.id }, { token: h.homeB.token + '-replacement' });
        h.rejectCredentialWrites(false);
        expect(written).toBe(false);
        expect(events).toEqual([]);
        expect(h.socket()).toBe(socket);
        expect(socket.socket.connected).toBe(true);
    });
});
