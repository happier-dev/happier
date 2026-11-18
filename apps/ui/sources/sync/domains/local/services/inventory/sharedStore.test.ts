import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalServiceInventorySnapshotV1Schema } from '@happier-dev/protocol/local/services/inventory/v1';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { createDeferred, flushHookEffects } from '@/dev/testkit';

const rpc = vi.hoisted(() => ({ machine: vi.fn(), snapshot: vi.fn() }));
// Snapshot/watch RPCs are the genuine daemon transport; internal clients and stores stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc.machine);
});

import { expectNoWallClockPolling } from '../noPollingTestHelpers';
import {
    createLocalServiceInventoryCountAcquisition,
    getLocalServiceInventoryRunningCount,
    observeLocalServiceInventorySummary,
    publishLocalServiceInventorySummary,
    publishLocalServiceInventoryMachineSummary,
    getLocalServiceInventoryState,
    invalidateLocalServiceInventoryStore,
    revalidateLocalServiceInventoryStore,
    publishLocalServiceInventorySnapshot,
    resetLocalServiceInventoryStoreForTests,
    subscribeLocalServiceInventoryStore,
} from './sharedStore';
import { selectLocalServiceInventoryRows, selectLocalServiceInventoryPresentationRows } from './store';

const snapshot = LocalServiceInventorySnapshotV1Schema.parse({
    v: 1,
    machineId: 'machine-a',
    generatedAt: 1_000,
    refreshState: 'idle',
    entries: [{
        id: 'vite-5173',
        machineId: 'machine-a',
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        port: 5173,
        protocol: 'tcp',
        detectedAt: 1_000,
        lastSeenAt: 1_000,
        state: 'listening',
        source: 'detected',
        classification: { kind: 'vite', signals: [] },
        labels: [],
        confidence: 'high',
        processOwnershipConfidence: 'medium',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
    }],
    diagnostics: [],
});

async function flushMicrotasks(): Promise<void> {
    await flushHookEffects();
}

describe('shared local-service inventory store', () => {
    it.each(['snapshot', 'failure', 'rejection'] as const)('preserves a newer publication when an older read settles with %s', async (outcome) => {
        const pending = createDeferred<unknown>();
        rpc.snapshot.mockReturnValue(pending.promise);
        const key = { machineId: 'machine-a' };
        const release = subscribeLocalServiceInventoryStore(key, () => {});
        await flushMicrotasks();
        publishLocalServiceInventorySnapshot(key, { ...snapshot, generatedAt: 2_000, entries: [] });
        const published = getLocalServiceInventoryState(key);
        if (outcome === 'snapshot') pending.resolve({ protocolVersion: 1, snapshot });
        else if (outcome === 'failure') pending.resolve({ ok: false, error: 'request_failed' });
        else pending.reject(new Error('transport failed'));
        await flushMicrotasks();
        expect(getLocalServiceInventoryState(key)).toBe(published);
        release();
    });
    it.each(['idle', 'error'] as const)('publishes changed summary facts without notifying for equal Machine receipt metadata (%s passive detail)', refreshState => {
        const key = { machineId: 'machine-a', serverId: 'server-a' };
        const notified = vi.fn();
        const release = observeLocalServiceInventorySummary(key, notified);
        try {
            if (refreshState === 'error') {
                publishLocalServiceInventorySnapshot(key, { ...snapshot, refreshState });
                notified.mockClear();
            }
            publishLocalServiceInventoryMachineSummary(key, { v: 1, state: 'ready', runningCount: 3 });
            expect(notified).toHaveBeenCalledTimes(1);
            notified.mockClear();
            for (let arrival = 0; arrival < 139; arrival += 1) {
                publishLocalServiceInventoryMachineSummary(key, { v: 1, state: 'ready', runningCount: 3 });
            }
            expect(notified).not.toHaveBeenCalled();
            publishLocalServiceInventoryMachineSummary(key, { v: 1, state: 'ready', runningCount: 5 });
            expect(getLocalServiceInventoryRunningCount(key)).toBe(5);
            expect(notified).toHaveBeenCalledTimes(1);
            publishLocalServiceInventorySummary(key, { v: 1, state: 'ready', runningCount: 5 });
            expect(notified).toHaveBeenCalledTimes(1);
            expect(rpc.machine).not.toHaveBeenCalled();
        } finally { release(); }
    });
    it('does not overwrite a newer inventory observation when another consumer presents the same Machine summary receipt', () => {
        const key = { machineId: 'machine-a', serverId: 'server-a' };
        const received = { v: 1, state: 'ready', runningCount: 4 };
        publishLocalServiceInventoryMachineSummary(key, received);
        publishLocalServiceInventorySnapshot(key, snapshot);
        publishLocalServiceInventoryMachineSummary(key, received);
        expect(getLocalServiceInventoryRunningCount(key)).toBe(1);
        publishLocalServiceInventoryMachineSummary(key, { v: 1, state: 'ready', runningCount: 2 });
        expect(getLocalServiceInventoryRunningCount(key)).toBe(2);
    });
    it('deduplicates concurrent count acquisitions for the same mounted Session without retaining its allowance after retirement', async () => {
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };
        const pending = createDeferred<unknown>();
        rpc.snapshot.mockReturnValue(pending.promise);
        const first = createLocalServiceInventoryCountAcquisition(key);
        const second = createLocalServiceInventoryCountAcquisition(key);
        const reads = [first.readOnce(), second.readOnce()];
        expect(rpc.machine).toHaveBeenCalledTimes(1);
        first.dispose();
        expect(rpc.machine.mock.calls[0]?.[0].signal.aborted).toBe(false);
        pending.resolve({ summary: { v: 1, state: 'unknown' } });
        await Promise.all(reads);
        second.dispose();
        const reopened = createLocalServiceInventoryCountAcquisition(key);
        await reopened.readOnce();
        expect(rpc.machine).toHaveBeenCalledTimes(2);
        reopened.dispose();
    });
    it('holds a passive scalar summary with one cancellable read per acquisition and no inventory watch', async () => {
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a', accountId: 'account-a', credentialKey: 'credential-a' };
        const release = observeLocalServiceInventorySummary(key, () => {});
        publishLocalServiceInventorySummary(key, { v: 1, state: 'ready', runningCount: 4 });
        const held = createLocalServiceInventoryCountAcquisition(key);
        await held.readOnce();
        expect(getLocalServiceInventoryRunningCount(key)).toBe(4);
        expect(rpc.machine).not.toHaveBeenCalled();
        held.dispose();
        publishLocalServiceInventorySummary(key, { v: 1, state: 'unknown' });
        const pending = createDeferred<unknown>();
        rpc.snapshot.mockReturnValue(pending.promise);
        const acquisition = createLocalServiceInventoryCountAcquisition(key);
        const first = acquisition.readOnce();
        const second = acquisition.readOnce();
        pending.resolve({ summary: { v: 1, state: 'ready', runningCount: 2 } });
        await Promise.all([first, second]);
        expect(rpc.machine).toHaveBeenCalledTimes(1);
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ payload: { machineId: 'machine-a', projection: 'count' } }));
        expect(getLocalServiceInventoryRunningCount(key)).toBe(2);
        publishLocalServiceInventorySnapshot(key, snapshot);
        expect(getLocalServiceInventoryRunningCount(key)).toBe(1);
        acquisition.dispose();
        release();
    });

    it.each([{}, { summary: { v: 1, state: 'error' } }, { summary: { v: 1, state: 'disabled' } }, { protocolVersion: 1, snapshot }])(
        'settles an unavailable scalar as unknown without fallback or retry (%j)', async response => {
            const key = { machineId: 'machine-a', serverId: 'server-a' };
            rpc.snapshot.mockResolvedValue(response);
            const acquisition = createLocalServiceInventoryCountAcquisition(key);
            await acquisition.readOnce();
            await acquisition.readOnce();
            expect(getLocalServiceInventoryRunningCount(key)).toBeNull();
            expect(rpc.machine).toHaveBeenCalledTimes(1);
            acquisition.dispose();
        },
    );

    it('aborts a retired acquisition and ignores its late scalar response', async () => {
        const key = { machineId: 'machine-a', serverId: 'server-a' };
        const pending = createDeferred<unknown>();
        rpc.snapshot.mockReturnValue(pending.promise);
        const acquisition = createLocalServiceInventoryCountAcquisition(key);
        const read = acquisition.readOnce();
        acquisition.dispose();
        pending.resolve({ summary: { v: 1, state: 'ready', runningCount: 8 } });
        await read;
        expect(rpc.machine.mock.calls[0]?.[0].signal.aborted).toBe(true);
        expect(getLocalServiceInventoryRunningCount(key)).toBeNull();
    });
    it.each(['returned', 'thrown'] as const)('keeps a newer known count when an older scalar read is refused (%s)', async carrier => {
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };
        const pending = createDeferred<unknown>();
        rpc.snapshot.mockReturnValue(pending.promise);
        const acquisition = createLocalServiceInventoryCountAcquisition(key);
        const read = acquisition.readOnce();
        publishLocalServiceInventorySummary(key, { v: 1, state: 'ready', runningCount: 4 });
        if (carrier === 'returned') pending.resolve({ errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE, error: 'private request details' });
        else pending.reject(new RpcError('private request details', RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE));
        await read;
        await acquisition.readOnce();
        expect(getLocalServiceInventoryRunningCount(key)).toBe(4);
        expect(rpc.machine).toHaveBeenCalledTimes(1);
        acquisition.dispose();
    });

    it('keeps a newer unavailable Machine publication when an older scalar read replies late', async () => {
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };
        publishLocalServiceInventoryMachineSummary(key, { v: 1, state: 'unknown' });
        const pending = createDeferred<unknown>();
        rpc.snapshot.mockReturnValue(pending.promise);
        const acquisition = createLocalServiceInventoryCountAcquisition(key);
        const read = acquisition.readOnce();
        publishLocalServiceInventoryMachineSummary(key, { v: 1, state: 'unknown' });
        pending.resolve({ summary: { v: 1, state: 'ready', runningCount: 8 } });
        await read;
        expect(getLocalServiceInventoryRunningCount(key)).toBeNull();
        acquisition.dispose();
    });
    beforeEach(() => {
        rpc.snapshot.mockReset();
        rpc.machine.mockReset().mockImplementation(async (request: { method: string; payload?: { observationOnly?: true } }) => {
            if (request.payload?.observationOnly) return new Promise(() => {});
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
                return new Promise(() => {});
            }
            expect([RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT,
                RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH]).toContain(request.method);
            return rpc.snapshot(request);
        });
    });
    afterEach(() => {
        resetLocalServiceInventoryStoreForTests();
    });

    it('retains only qualified inventory content while closed and revalidates once on reopen', async () => {
        const key = { machineId: 'machine-a', serverId: 'server-a', accountId: 'account-a', credentialKey: 'credential-a' };
        const watchSignals: AbortSignal[] = [];
        rpc.machine.mockImplementation(async (request: { method: string; signal: AbortSignal; payload?: { observationOnly?: true } }) => {
            if (request.payload?.observationOnly) return new Promise(() => {});
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
                watchSignals.push(request.signal);
                return new Promise(() => {});
            }
            return rpc.snapshot(request);
        });
        rpc.snapshot.mockResolvedValue({ protocolVersion: 1, snapshot });
        const release = subscribeLocalServiceInventoryStore(key, () => {});
        await vi.waitFor(() => expect(watchSignals).toHaveLength(1));
        const heldRows = selectLocalServiceInventoryRows(getLocalServiceInventoryState(key));
        release();
        expect(watchSignals[0]?.aborted).toBe(true);
        expect(selectLocalServiceInventoryRows(getLocalServiceInventoryState(key))).toEqual(heldRows);
        expect(selectLocalServiceInventoryRows(getLocalServiceInventoryState({ ...key, accountId: 'account-b' }))).toEqual([]);
        expect(selectLocalServiceInventoryRows(getLocalServiceInventoryState({ ...key, credentialKey: 'replacement-credential' }))).toEqual([]);
        const closedCalls = rpc.machine.mock.calls.length;
        await flushMicrotasks();
        expect(rpc.machine).toHaveBeenCalledTimes(closedCalls);
        const pending = createDeferred<unknown>();
        rpc.snapshot.mockImplementation(() => pending.promise);
        const reopen = subscribeLocalServiceInventoryStore(key, () => {});
        expect(selectLocalServiceInventoryRows(getLocalServiceInventoryState(key))).toEqual(heldRows);
        await vi.waitFor(() => expect(rpc.snapshot).toHaveBeenCalledTimes(2));
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-a',
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT, payload: { machineId: 'machine-a' } }));
        pending.resolve({ protocolVersion: 1, snapshot: { ...snapshot, generatedAt: 2_000, entries: [] } });
        await vi.waitFor(() => expect(watchSignals).toHaveLength(2));
        expect(getLocalServiceInventoryState(key).generatedAt).toBe(2_000);
        expect(selectLocalServiceInventoryRows(getLocalServiceInventoryState(key))).toEqual([]);
        reopen();
        expect(watchSignals[1]?.aborted).toBe(true);
    });

    it('seeds the parked watch from the initial snapshot instead of racing the first scan', async () => {
        let finish!: (value: unknown) => void;
        rpc.snapshot.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        const key = { machineId: 'machine-a', serverId: 'server-a' };
        const unsubscribe = subscribeLocalServiceInventoryStore(key, () => {});
        await flushMicrotasks();
        expect(rpc.machine.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH)).toHaveLength(0);
        finish({ protocolVersion: 1, snapshot });
        await flushMicrotasks();
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH,
            payload: { machineId: 'machine-a', sinceGeneratedAt: snapshot.generatedAt },
        }));
        unsubscribe();
    });

    it('applies a watch delta onto the held rows, keeping untouched row identities, and reads in full when the base moved', async () => {
        const second = { ...snapshot.entries[0]!, id: 'api-8080', port: 8080 };
        const held = LocalServiceInventorySnapshotV1Schema.parse({ ...snapshot, entries: [snapshot.entries[0], second] });
        const watches: Array<(value: unknown) => void> = [];
        rpc.machine.mockImplementation(async (request: { method: string; payload?: { observationOnly?: true } }) => {
            if (request.payload?.observationOnly) return new Promise(() => {});
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return new Promise(resolve => { watches.push(resolve); });
            return { protocolVersion: 1, snapshot: held };
        });
        const key = { machineId: 'machine-a', serverId: 'server-a' };
        const unsubscribe = subscribeLocalServiceInventoryStore(key, () => {});
        await vi.waitFor(() => expect(watches).toHaveLength(1));
        const untouched = getLocalServiceInventoryState(key).rowsById.get('vite-5173');
        const added = { ...second, id: 'docs-3000', port: 3000 };
        watches[0]!({ protocolVersion: 1, changed: true, delta: { v: 1, machineId: 'machine-a', baseGeneratedAt: 1_000,
            generatedAt: 2_000, refreshState: 'idle', upserts: [added], removedIds: ['api-8080'], diagnostics: [] } });
        await vi.waitFor(() => expect(getLocalServiceInventoryState(key).generatedAt).toBe(2_000));
        expect(selectLocalServiceInventoryRows(getLocalServiceInventoryState(key)).map(row => row.id)).toEqual(['vite-5173', 'docs-3000']);
        expect(getLocalServiceInventoryState(key).rowsById.get('vite-5173')).toBe(untouched);
        const snapshotReads = rpc.machine.mock.calls.filter(([request]) => request.method !== RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH).length;
        await vi.waitFor(() => expect(watches).toHaveLength(2));
        watches[1]!({ protocolVersion: 1, changed: true, delta: { v: 1, machineId: 'machine-a', baseGeneratedAt: 1_500,
            generatedAt: 3_000, refreshState: 'idle', upserts: [], removedIds: [], diagnostics: [] } });
        await vi.waitFor(() => expect(rpc.machine.mock.calls.filter(([request]) => request.method !== RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH).length)
            .toBe(snapshotReads + 1));
        unsubscribe();
    });

    it.each(['unavailable', 'rejection'] as const)('rearms the real watch transport after fresh publication overtakes %s', async failure => {
        const watches: Array<{ resolve(value: unknown): void; reject(error: unknown): void }> = [];
        rpc.machine.mockImplementation(async (request: { method: string; payload?: { observationOnly?: true } }) => {
            if (request.payload?.observationOnly) return new Promise(() => {});
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
                return await new Promise((resolve, reject) => { watches.push({ resolve, reject }); });
            }
            return { protocolVersion: 1, snapshot };
        });
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };
        const unsubscribe = subscribeLocalServiceInventoryStore(key, () => {});
        await vi.waitFor(() => expect(watches).toHaveLength(1));
        const fresh = LocalServiceInventorySnapshotV1Schema.parse({ ...snapshot, generatedAt: 2_000 });
        publishLocalServiceInventorySnapshot(key, fresh);
        if (failure === 'rejection') watches[0]!.reject(new Error('offline'));
        else watches[0]!.resolve({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
        await vi.waitFor(() => expect(watches).toHaveLength(2));
        const changed = LocalServiceInventorySnapshotV1Schema.parse({ ...snapshot, generatedAt: 3_000, entries: [] });
        watches[1]!.resolve({ protocolVersion: 1, changed: true, snapshot: changed });
        await vi.waitFor(() => expect(getLocalServiceInventoryState(key).generatedAt).toBe(3_000));
        expect(selectLocalServiceInventoryRows(getLocalServiceInventoryState(key))).toEqual([]);
        unsubscribe();
    });

    it('reads the daemon-kept inventory on returning demand and forces a rescan only for an explicit refresh', async () => {
        rpc.machine.mockImplementation(async (request: { method: string; payload?: { observationOnly?: true } }) => {
            if (request.payload?.observationOnly || request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return new Promise(() => {});
            return rpc.snapshot(request);
        });
        rpc.snapshot.mockResolvedValue({ protocolVersion: 1, snapshot });
        const key = { machineId: 'machine-a', serverId: 'server-a', accountId: 'account-a', credentialKey: 'credential-a' };
        const methods = () => rpc.snapshot.mock.calls.map(([request]) => (request as { method: string }).method);
        const scans = () => methods().filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH).length;
        // Showing, hiding and showing a widget again three times is ordinary demand, not a request to rescan.
        for (let show = 0; show < 3; show += 1) {
            const release = subscribeLocalServiceInventoryStore(key, () => {});
            await vi.waitFor(() => expect(methods()).toHaveLength(show + 1));
            release();
        }
        expect(scans()).toBe(0);
        const release = subscribeLocalServiceInventoryStore(key, () => {});
        await vi.waitFor(() => expect(methods()).toHaveLength(4));
        revalidateLocalServiceInventoryStore(key);
        await vi.waitFor(() => expect(methods()).toHaveLength(5));
        expect(scans(), 'returning to the foreground re-reads the current inventory').toBe(0);
        invalidateLocalServiceInventoryStore(key);
        await vi.waitFor(() => expect(methods()).toHaveLength(6));
        expect(scans(), 'the refresh control asks the daemon to scan now').toBe(1);
        release();
    });

    it('fetches once for a key regardless of how many consumers subscribe', async () => {
        const snapshotClient = rpc.snapshot.mockResolvedValue({
            protocolVersion: 1,
            snapshot,
        });
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };

        const unsubA = subscribeLocalServiceInventoryStore(key, () => {});
        const unsubB = subscribeLocalServiceInventoryStore({ ...key, sessionId: 'session-b' }, () => {});
        await flushMicrotasks();

        expect(snapshotClient).toHaveBeenCalledTimes(1);
        expect(snapshotClient).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT,
            serverId: 'server-a', payload: { machineId: 'machine-a' },
        }));
        expect(selectLocalServiceInventoryRows(getLocalServiceInventoryState(key))).toEqual(snapshot.entries);

        unsubA();
        unsubB();
    });

    it('publishes action-read snapshots into the same backing model without polling', async () => {
        const snapshotClient = rpc.snapshot.mockResolvedValue({
            protocolVersion: 1,
            snapshot: { ...snapshot, entries: [] },
        });
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };
        const listener = vi.fn();

        const unsub = subscribeLocalServiceInventoryStore(key, listener);
        await flushMicrotasks();
        listener.mockClear();

        publishLocalServiceInventorySnapshot(key, snapshot);

        expect(listener).toHaveBeenCalled();
        expect(selectLocalServiceInventoryRows(getLocalServiceInventoryState(key))).toEqual(snapshot.entries);
        expect(snapshotClient).toHaveBeenCalledTimes(1);

        unsub();
    });

    it('suppresses identical publications while retaining observable scan freshness', async () => {
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };
        const listener = vi.fn();
        rpc.snapshot.mockResolvedValue({ protocolVersion: 1, snapshot });
        const unsub = subscribeLocalServiceInventoryStore(key, listener);
        await flushMicrotasks();
        listener.mockClear();
        const presentation = selectLocalServiceInventoryPresentationRows(getLocalServiceInventoryState(key));
        for (let index = 0; index < 3; index += 1) publishLocalServiceInventorySnapshot(key, structuredClone(snapshot));
        expect(listener).not.toHaveBeenCalled();
        publishLocalServiceInventorySnapshot(key, { ...snapshot, generatedAt: 2_000,
            entries: snapshot.entries.map(row => ({ ...row, lastSeenAt: 2_000 })) });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(getLocalServiceInventoryState(key).generatedAt).toBe(2_000);
        expect(selectLocalServiceInventoryPresentationRows(getLocalServiceInventoryState(key))).toBe(presentation);
        unsub();
    });


    it.each(['Machine', 'count'] as const)('recovers initial census after a late failed read without losing the newer ready %s receipt', async receipt => {
        const initial = createDeferred<unknown>();
        rpc.snapshot.mockReturnValueOnce(initial.promise).mockResolvedValue({ protocolVersion: 1, snapshot });
        const key = { machineId: 'machine-a', serverId: 'server-a' };
        const release = subscribeLocalServiceInventoryStore(key, () => {});
        try {
            expect(rpc.snapshot).toHaveBeenCalledTimes(1);
            const publish = receipt === 'Machine' ? publishLocalServiceInventoryMachineSummary : publishLocalServiceInventorySummary;
            publish(key, { v: 1, state: 'ready', runningCount: 1 });
            initial.resolve({ ok: false, error: 'request_failed' });
            await flushMicrotasks();
            expect(getLocalServiceInventoryState(key).refreshState).toBe('idle');
            expect(getLocalServiceInventoryRunningCount(key)).toBe(1);
            expect(rpc.snapshot).toHaveBeenCalledTimes(2);
            const watches = rpc.machine.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH && !request.payload.observationOnly);
            expect(watches).toHaveLength(1);
            expect(watches[0]?.[0].payload.sinceGeneratedAt).toBe(snapshot.generatedAt);
            const reads = rpc.machine.mock.calls.length;
            for (let arrival = 0; arrival < 139; arrival += 1) publish(key, { v: 1, state: 'ready', runningCount: 1 });
            await flushMicrotasks();
            expect(rpc.machine).toHaveBeenCalledTimes(reads);
        } finally { release(); }
    });

    it('does not fabricate a daemon generation when a refresh fails', async () => {
        // F-1: the same lying-generation defect the refresh-STARTED path had, on the failure path.
        // A failed read produces no daemon generation — the rows on screen are still the last real
        // one's. Stamping the client clock here re-creates both consequences: the surface host sees
        // a phantom "the daemon rescanned" and re-reads the launcher feed, and the watch's
        // `sinceGeneratedAt` cursor becomes a client clock reading the daemon cannot compare.
        let succeed = true;
        rpc.snapshot.mockImplementation(async () => {
            if (!succeed) throw new Error('daemon snapshot transport unavailable');
            return { protocolVersion: 1, snapshot };
        });
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };

        const unsub = subscribeLocalServiceInventoryStore(key, () => {});
        await flushMicrotasks();
        expect(getLocalServiceInventoryState(key).generatedAt).toBe(1_000);

        succeed = false;
        invalidateLocalServiceInventoryStore(key);
        await flushMicrotasks();

        const failed = getLocalServiceInventoryState(key);
        expect(failed.refreshState).toBe('error');
        // Keep-last-good still holds, and the generation still names the snapshot those rows are from.
        expect(selectLocalServiceInventoryRows(failed)).toEqual(snapshot.entries);
        expect(failed.generatedAt).toBe(1_000);

        unsub();
    });

    it('does not re-fetch the inventory on a wall clock while subscribed', async () => {
        const snapshotClient = rpc.snapshot.mockResolvedValue({
            protocolVersion: 1,
            snapshot,
        });
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };

        await expectNoWallClockPolling({
            subscribe: () => subscribeLocalServiceInventoryStore(key, () => {}),
            fetchSpy: snapshotClient,
        });
    });
});
