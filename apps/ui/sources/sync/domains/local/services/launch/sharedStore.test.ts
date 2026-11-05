import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createDeferred, flushHookEffects } from '@/dev/testkit';

const rpc = vi.hoisted(() => ({ machine: vi.fn(), launcher: vi.fn() }));
// Daemon transport is the boundary; subscription, request and response owners remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc.machine);
});

import { expectNoWallClockPolling } from '../noPollingTestHelpers';
import {
    getLocalServiceLauncherState,
    publishLocalServiceLauncherSnapshot,
    invalidateLocalServiceLauncherStore,
    readLocalServiceLauncherStore,
    resetLocalServiceLauncherStoreForTests,
    subscribeLocalServiceLauncherStore,
} from './sharedStore';
import { readLocalServiceLauncherSnapshotTime, selectLocalServiceLaunchTargets } from './store';
import { buildLocalServiceRows } from '../serviceRow';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { publishLocalServiceInventoryMachineSummary, resetLocalServiceInventoryStoreForTests } from '../inventory/sharedStore';
import { createLocalServicesRuntimeActionExecutor } from '../actions/runtimeActionExecutor';
import { LocalServiceActionRequestV1Schema, LocalServiceActionResultV1Schema } from '@happier-dev/protocol/local/services/actions/v1';

const snapshot = LocalServiceLauncherSnapshotV1Schema.parse({
    v: 1,
    machineId: 'machine-a',
    sessionId: 'session-a',
    updatedAt: 1_000,
    targets: [{
        id: 'managed:preview',
        source: 'managed_service',
        sourceClass: { kind: 'managed_service', managedServiceId: 'preview' },
        machineId: 'machine-a',
        sessionId: 'session-a',
        title: 'Preview',
        confidence: 'medium',
        state: 'available',
        serviceState: 'running',
        actions: ['start'],
    }],
});

async function flushMicrotasks(): Promise<void> {
    await flushHookEffects();
}

describe('shared local-service launcher store', () => {
    beforeEach(() => {
        rpc.launcher.mockReset();
        rpc.machine.mockReset().mockImplementation(async (request: { method: string; payload?: { observationOnly?: true } }) => {
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) {
                return { protocolVersion: 1, snapshot: { v: 1, machineId: 'machine-a', generatedAt: 1_000,
                    refreshState: 'idle', entries: [], diagnostics: [] } };
            }
            if (request.payload?.observationOnly) return new Promise(() => {});
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return new Promise(() => {});
            return rpc.launcher(request);
        });
    });
    afterEach(() => {
        resetLocalServiceLauncherStoreForTests();
        resetLocalServiceInventoryStoreForTests();
    });

    it('keeps a newer Stop publication when it supersedes the retained Session read before commit', async () => {
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };
        const pending = createDeferred<{ ok: true; snapshot: typeof snapshot }>();
        let held = false;
        let currentSnapshot = snapshot;
        const snapshotClient = vi.fn(() => held ? pending.promise : Promise.resolve({ ok: true as const, snapshot: currentSnapshot }));
        const release = subscribeLocalServiceLauncherStore(key, () => {}, { snapshotClient });
        try {
            await vi.waitFor(() => expect(getLocalServiceLauncherState(key).targetIds).toEqual(['managed:preview']));
            await flushMicrotasks();
            const initialReads = snapshotClient.mock.calls.length;
            held = true;
            invalidateLocalServiceLauncherStore(key);
            pending.resolve({ ok: true, snapshot });
            // The domain reducer finishes before the subscription owner's await commits it.
            await Promise.resolve();
            currentSnapshot = { ...snapshot, updatedAt: 2_000, targets: [] };
            held = false;
            publishLocalServiceLauncherSnapshot(key, currentSnapshot);
            await flushMicrotasks();
            expect(getLocalServiceLauncherState(key).targetIds).toEqual([]);
            expect(readLocalServiceLauncherSnapshotTime(getLocalServiceLauncherState(key))).toBe(2_000);
            expect(snapshotClient).toHaveBeenCalledTimes(initialReads + 1);
        } finally { release(); }
    });

    it('retains only qualified launcher content while closed and revalidates once on reopen', async () => {
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a',
            accountId: 'account-a', credentialKey: 'credential-a' };
        const watchSignals: AbortSignal[] = [];
        rpc.machine.mockImplementation(async (request: { method: string; signal: AbortSignal; payload?: { observationOnly?: true } }) => {
            if (request.payload?.observationOnly) return new Promise(() => {});
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
                watchSignals.push(request.signal);
                return new Promise(() => {});
            }
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) return { protocolVersion: 1,
                snapshot: { v: 1, machineId: 'machine-a', generatedAt: 1_000, refreshState: 'idle', entries: [], diagnostics: [] } };
            return rpc.launcher(request);
        });
        rpc.launcher.mockResolvedValue({ protocolVersion: 1, snapshot });
        const release = subscribeLocalServiceLauncherStore(key, () => {});
        await vi.waitFor(() => expect(watchSignals).toHaveLength(1));
        await flushMicrotasks();
        const heldRows = selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key));
        const initialReads = rpc.launcher.mock.calls.length;
        release();
        expect(watchSignals[0]?.aborted).toBe(true);
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))).toEqual(heldRows);
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState({ ...key, accountId: 'account-b' }))).toEqual([]);
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState({ ...key, credentialKey: 'replacement-credential' }))).toEqual([]);
        const closedCalls = rpc.machine.mock.calls.length;
        await flushMicrotasks();
        expect(rpc.machine).toHaveBeenCalledTimes(closedCalls);
        const pending = createDeferred<unknown>();
        rpc.launcher.mockImplementation(() => pending.promise);
        const reopen = subscribeLocalServiceLauncherStore(key, () => {});
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))).toEqual(heldRows);
        await vi.waitFor(() => expect(rpc.launcher).toHaveBeenCalledTimes(initialReads + 1));
        pending.resolve({ protocolVersion: 1, snapshot: { ...snapshot, updatedAt: 2_000, targets: [] } });
        await vi.waitFor(() => expect(getLocalServiceLauncherState(key).updatedAt).toBe(2_000));
        expect(rpc.launcher).toHaveBeenCalledTimes(initialReads + 1);
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))).toEqual([]);
        reopen();
        expect(watchSignals[1]?.aborted).toBe(true);
    });

    it('does not prefetch a closed qualified projection after a broader Action publication', async () => {
        const binding = { machineId: 'machine-a', serverId: 'server-a', accountId: 'account-a', credentialKey: 'credential-a' };
        const key = { ...binding, scope: 'workspace' as const, workspaceRoot: '/repo', projection: 'managed_bindings' as const };
        const watchSignals: AbortSignal[] = [];
        rpc.machine.mockImplementation(async (request: { method: string; signal: AbortSignal; payload?: { observationOnly?: true } }) => {
            if (request.payload?.observationOnly) return new Promise(() => {});
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
                watchSignals.push(request.signal);
                return new Promise(() => {});
            }
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) return { protocolVersion: 1,
                snapshot: { v: 1, machineId: 'machine-a', generatedAt: 1_000, refreshState: 'idle', entries: [], diagnostics: [] } };
            return rpc.launcher(request);
        });
        rpc.launcher.mockResolvedValue({ protocolVersion: 1, snapshot });
        const release = subscribeLocalServiceLauncherStore(key, () => {});
        await vi.waitFor(() => expect(watchSignals).toHaveLength(1));
        await flushMicrotasks();
        release();
        expect(watchSignals[0]?.aborted).toBe(true);
        const closedCalls = rpc.machine.mock.calls.length;
        publishLocalServiceLauncherSnapshot(binding, { ...snapshot, updatedAt: 2_000, targets: [] });
        await flushMicrotasks();
        expect(rpc.machine).toHaveBeenCalledTimes(closedCalls);
        // A covering current publication is useful cached truth, not demand.
        publishLocalServiceLauncherSnapshot(key, { ...snapshot, updatedAt: 3_000 });
        expect(readLocalServiceLauncherSnapshotTime(getLocalServiceLauncherState(key))).toBe(3_000);
        expect(rpc.machine).toHaveBeenCalledTimes(closedCalls);
        const readsBeforeReopen = rpc.launcher.mock.calls.length;
        rpc.launcher.mockResolvedValue({ protocolVersion: 1, snapshot: { ...snapshot, updatedAt: 4_000 } });
        const reopen = subscribeLocalServiceLauncherStore(key, () => {});
        await vi.waitFor(() => expect(readLocalServiceLauncherSnapshotTime(getLocalServiceLauncherState(key))).toBe(4_000));
        expect(rpc.launcher).toHaveBeenCalledTimes(readsBeforeReopen + 1);
        reopen();
        expect(watchSignals.every(signal => signal.aborted)).toBe(true);
    });

    it.each(['snapshot', 'failure'] as const)('does not let a late pre-Start read overwrite a newer succeeded-Start snapshot (%s)', async reply => {
        const stale = createDeferred<void>();
        const entered = createDeferred<void>();
        let held = false;
        rpc.launcher.mockImplementation(async () => {
            if (held) {
                entered.resolve(); await stale.promise;
                if (reply === 'failure') throw new Error('earlier_read_failed');
            }
            return { protocolVersion: 1, snapshot: { ...snapshot, targets: [] } };
        });
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };
        const unsubscribe = subscribeLocalServiceLauncherStore(key, () => {});
        try {
            await flushMicrotasks();
            held = true;
            invalidateLocalServiceLauncherStore(key);
            await entered.promise;
            const pending = readLocalServiceLauncherStore(key);
            publishLocalServiceLauncherSnapshot(key, { ...snapshot, updatedAt: 2_000 });
            stale.resolve();
            await pending;
            expect(readLocalServiceLauncherSnapshotTime(getLocalServiceLauncherState(key))).toBe(2_000);
            expect(getLocalServiceLauncherState(key).refreshStatus).toBe('idle');
            expect(buildLocalServiceRows({ inventoryRows: [], launchTargets: selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key)),
                sessionId: 'session-a', scope: 'machine' })[0]?.status).toBe('running');
            const current = getLocalServiceLauncherState(key);
            publishLocalServiceLauncherSnapshot(key, { ...snapshot, targets: [] });
            expect(getLocalServiceLauncherState(key)).toBe(current);
        } finally { stale.resolve(); unsubscribe(); }
    });

    it('keeps last-known rows stale after watch retirement and recovers even at the same inventory generation', async () => {
        const watches: Array<(value: unknown) => void> = [];
        let available = true;
        rpc.machine.mockImplementation(async (request: { method: string; payload?: { observationOnly?: true } }) => {
            if (request.payload?.observationOnly) return new Promise(() => {});
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return new Promise(resolve => watches.push(resolve));
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) return { protocolVersion: 1,
                snapshot: { v: 1, machineId: 'machine-a', generatedAt: 1_000, refreshState: 'idle', entries: [], diagnostics: [] } };
            return { protocolVersion: 1, snapshot: LocalServiceLauncherSnapshotV1Schema.parse({ ...snapshot,
                targets: snapshot.targets.map(target => ({ ...target, state: available ? 'available' : 'unavailable',
                    ...(available ? {} : { unavailableReason: 'launch_unavailable' }), actions: available ? ['start'] : [] })) }) };
        });
        const key = { machineId: 'machine-a', serverId: 'server-a' };
        const release = subscribeLocalServiceLauncherStore(key, () => {});
        const rows = () => buildLocalServiceRows({ inventoryRows: [], launchTargets: selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key)),
            sessionId: 'session-a', scope: 'machine' });
        try {
            await vi.waitFor(() => expect(rows()[0]?.status).toBe('running'));
            await vi.waitFor(() => expect(watches).toHaveLength(1));
            watches[0]!({ invalid: true });
            await flushMicrotasks();
            expect.soft(rows()[0]).toMatchObject({ id: snapshot.targets[0]!.id, status: 'stale', primaryAction: null });
            expect.soft(getLocalServiceLauncherState(key).updatedAt).toBe(snapshot.updatedAt);
            available = false;
            publishHomeAccountChange(key.serverId, undefined, { source: 'connected' });
            await vi.waitFor(() => expect(watches).toHaveLength(2));
            await vi.waitFor(() => expect(rows()[0]?.status).toBe('unavailable'));
        } finally { release(); }
    });

    it('recovers stale Session rows on a new ready Machine observation without polling or healthy receipt rereads', async () => {
        const watches: Array<(value: unknown) => void> = [];
        rpc.launcher.mockResolvedValue({ protocolVersion: 1, snapshot });
        rpc.machine.mockImplementation(async (request: { method: string; payload?: { observationOnly?: true } }) => {
            if (request.payload?.observationOnly) return new Promise(() => {});
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return new Promise(resolve => watches.push(resolve));
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) return { protocolVersion: 1,
                snapshot: { v: 1, machineId: 'machine-a', generatedAt: 1_000, refreshState: 'idle', entries: [], diagnostics: [] } };
            return rpc.launcher(request);
        });
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };
        const listener = vi.fn();
        const release = subscribeLocalServiceLauncherStore(key, listener);
        try {
            await vi.waitFor(() => expect(watches).toHaveLength(1));
            await flushMicrotasks();
            watches[0]!({ invalid: true });
            await vi.waitFor(() => expect(getLocalServiceLauncherState(key).targetsById.get('managed:preview')?.state).toBe('stale'));
            const reads = rpc.launcher.mock.calls.length;
            publishLocalServiceInventoryMachineSummary({ ...key, machineId: 'other-machine' }, { v: 1, state: 'ready', runningCount: 1 });
            publishLocalServiceInventoryMachineSummary(key, { v: 1, state: 'unknown' });
            await flushMicrotasks();
            expect(rpc.launcher).toHaveBeenCalledTimes(reads);
            publishLocalServiceInventoryMachineSummary(key, { v: 1, state: 'ready', runningCount: 1 });
            await vi.waitFor(() => expect(getLocalServiceLauncherState(key).targetsById.get('managed:preview')?.state).toBe('available'));
            await vi.waitFor(() => expect(watches).toHaveLength(2));
            expect(rpc.launcher).toHaveBeenCalledTimes(reads + 1);
            const totalReads = rpc.machine.mock.calls.length;
            const current = getLocalServiceLauncherState(key);
            listener.mockClear();
            for (let receipt = 0; receipt < 139; receipt++) {
                publishLocalServiceInventoryMachineSummary(key, { v: 1, state: 'ready', runningCount: 1 });
            }
            await flushMicrotasks();
            expect(rpc.machine).toHaveBeenCalledTimes(totalReads);
            expect(getLocalServiceLauncherState(key)).toBe(current);
            expect(listener).not.toHaveBeenCalled();
        } finally { release(); }
    });

    it('publishes the first of 75 equal warm launcher failures only', async () => {
        const key = { machineId: 'machine-a', serverId: 'server-a' };
        rpc.launcher.mockResolvedValue({ protocolVersion: 1, snapshot });
        const listener = vi.fn();
        const release = subscribeLocalServiceLauncherStore(key, listener);
        try {
            await flushMicrotasks();
            listener.mockClear();
            const reads = rpc.launcher.mock.calls.length;
            rpc.launcher.mockRejectedValue(new Error('unavailable'));
            for (let index = 0; index < 75; index++) {
                invalidateLocalServiceLauncherStore(key);
                await readLocalServiceLauncherStore(key);
            }
            expect(rpc.launcher.mock.calls.length - reads).toBe(75);
            expect(listener).toHaveBeenCalledTimes(1);
            expect(getLocalServiceLauncherState(key).refreshStatus).toBe('error');
        } finally { release(); }
    });

    it.each(['healthy inventory', 'recovering inventory', 'change during read'] as const)(
        'reads a recovered launcher once and retains subsequent-change freshness (%s)', async scenario => {
            const key = { machineId: 'machine-a', serverId: 'server-a' };
            const watches: Array<(value: unknown) => void> = [];
            const inventoryReply = createDeferred<unknown>();
            const launcherReply = createDeferred<unknown>();
            let holdInventory = false;
            let holdLauncher = false;
            rpc.machine.mockImplementation(async (request: { method: string; payload?: { observationOnly?: true } }) => {
                if (request.payload?.observationOnly) return new Promise(() => {});
                if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return new Promise(resolve => watches.push(resolve));
                if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) return holdInventory ? inventoryReply.promise
                    : { protocolVersion: 1, snapshot: { v: 1, machineId: 'machine-a', generatedAt: 1_000,
                        refreshState: 'idle', entries: [], diagnostics: [] } };
                return rpc.launcher(request);
            });
            rpc.launcher.mockImplementation(() => holdLauncher ? launcherReply.promise : Promise.resolve({ protocolVersion: 1, snapshot }));
            const release = subscribeLocalServiceLauncherStore(key, () => {});
            try {
                await vi.waitFor(() => expect(watches).toHaveLength(1));
                await flushMicrotasks();
                if (scenario === 'recovering inventory') {
                    watches[0]!({ invalid: true });
                    await flushMicrotasks();
                    expect(getLocalServiceLauncherState(key).refreshStatus).toBe('error');
                    holdInventory = true;
                } else {
                    rpc.launcher.mockRejectedValueOnce(new Error('independent launcher failure'));
                    invalidateLocalServiceLauncherStore(key);
                    await readLocalServiceLauncherStore(key);
                    expect(getLocalServiceLauncherState(key).refreshStatus).toBe('error');
                }
                const reads = rpc.launcher.mock.calls.length;
                holdLauncher = true;
                publishHomeAccountChange(key.serverId, undefined, { source: 'connected' });
                await flushMicrotasks();
                if (scenario === 'recovering inventory') {
                    // No derived read until the recovering inventory has current facts.
                    expect.soft(rpc.launcher.mock.calls.length - reads).toBe(0);
                    inventoryReply.resolve({ protocolVersion: 1, snapshot: { v: 1, machineId: 'machine-a', generatedAt: 1_000,
                        refreshState: 'idle', entries: [], diagnostics: [] } });
                }
                await vi.waitFor(() => expect(rpc.launcher.mock.calls.length - reads).toBe(1));
                if (scenario === 'change during read') {
                    watches[0]!({ protocolVersion: 1, changed: true, snapshot: { v: 1, machineId: 'machine-a', generatedAt: 2_000,
                        refreshState: 'idle', entries: [], diagnostics: [] } });
                    await flushMicrotasks();
                }
                holdLauncher = false;
                rpc.launcher.mockResolvedValue({ protocolVersion: 1, snapshot: { ...snapshot, updatedAt: 3_000, targets: [] } });
                launcherReply.resolve({ protocolVersion: 1, snapshot: { ...snapshot, updatedAt: 2_000 } });
                await flushMicrotasks();
                expect(rpc.launcher.mock.calls.length - reads).toBe(scenario === 'change during read' ? 2 : 1);
                expect(getLocalServiceLauncherState(key).refreshStatus).toBe('idle');
                if (scenario === 'change during read') expect(getLocalServiceLauncherState(key).targetIds).toEqual([]);
            } finally { inventoryReply.resolve({ invalid: true }); launcherReply.resolve({ invalid: true }); release(); }
        },
    );

    it('refreshes all launcher projections after external runtime changes without a mounted surface refresh', async () => {
        const watches: Array<(value: unknown) => void> = [];
        let generation = 1_000;
        let running = true;
        rpc.machine.mockImplementation(async (request: { method: string; payload: { projection?: string; workspaceRoot?: string; observationOnly?: true } }) => {
            if (request.payload?.observationOnly) return new Promise(() => {});
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
                return await new Promise(resolve => watches.push(resolve));
            }
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) {
                return { protocolVersion: 1, snapshot: { v: 1, machineId: 'machine-a', generatedAt: generation,
                    refreshState: 'idle', entries: [], diagnostics: [] } };
            }
            return { protocolVersion: 1, snapshot: { ...snapshot, updatedAt: generation,
                targets: snapshot.targets.map(target => ({ ...target, serviceState: running ? 'healthy' : 'stopped' })) } };
        });
        const source = { machineId: 'machine-a', serverId: 'server-a', accountId: 'owner', credentialKey: 'credential-a',
            scope: 'workspace' as const, workspaceRoot: '/repo' };
        const bindings = { ...source, projection: 'managed_bindings' as const };
        const otherHome = { ...source, serverId: 'server-b' };
        const dispose = [source, bindings, otherHome].map(key => subscribeLocalServiceLauncherStore(key, () => {}));
        await vi.waitFor(() => expect(watches.length).toBeGreaterThanOrEqual(2));
        await flushMicrotasks();
        running = false;
        generation = 2_000;
        // An inventory watch is shared by every launcher projection on this Home/Machine.
        watches[0]!({ protocolVersion: 1, changed: true, snapshot: { v: 1, machineId: 'machine-a', generatedAt: generation,
            refreshState: 'idle', entries: [], diagnostics: [] } });
        await vi.waitFor(() => expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(source))[0]?.serviceState).toBe('stopped'));
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(bindings))[0]?.serviceState).toBe('stopped');
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(otherHome))[0]?.serviceState).toBe('healthy');
        dispose.forEach(unsubscribe => unsubscribe());
    });

    it('shares the initial launcher and completed-scan reads regardless of how many consumers subscribe', async () => {
        const snapshotClient = rpc.launcher.mockResolvedValue({
            protocolVersion: 1,
            snapshot,
        });
        const key = {
            machineId: 'machine-a',
            serverId: 'server-a',
            sessionId: 'session-a',
            scope: 'workspace' as const,
            workspaceRoot: '/repo',
        };

        const unsubA = subscribeLocalServiceLauncherStore(key, () => {});
        const unsubB = subscribeLocalServiceLauncherStore(key, () => {});
        await flushMicrotasks();

        expect(snapshotClient).toHaveBeenCalledTimes(2);
        expect(snapshotClient).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
            serverId: 'server-a', payload: { machineId: 'machine-a', sessionId: 'session-a', scope: 'workspace', workspaceRoot: '/repo' },
        }));
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))).toEqual(snapshot.targets);

        unsubA();
        unsubB();
    });

    it.each(['server-a', undefined])('recovers failed projections after same-generation Action Refresh only on its Home (%s)', async serverId => {
        let available = false;
        rpc.launcher.mockImplementation(async (request: { payload: { workspaceRoot?: string } }) => {
            if (!available && request.payload.workspaceRoot !== '/healthy') throw new Error('temporarily unavailable');
            return { protocolVersion: 1, snapshot };
        });
        const source = { machineId: 'machine-a', serverId, scope: 'workspace' as const, workspaceRoot: '/repo' };
        // This bare executor intentionally exercises the standalone, unqualified contract.
        const bindings = { ...source, projection: 'managed_bindings' as const };
        const otherHome = { ...source, serverId: 'server-b' };
        const healthy = { ...source, workspaceRoot: '/healthy' };
        const dispose = [source, bindings, otherHome, healthy].map(key => subscribeLocalServiceLauncherStore(key, () => {}));
        try {
            await vi.waitFor(() => {
                for (const key of [source, bindings, otherHome]) expect(getLocalServiceLauncherState(key).refreshStatus).toBe('error');
                expect(getLocalServiceLauncherState(healthy).refreshStatus).toBe('idle');
            });
            const previousHealthy = getLocalServiceLauncherState(healthy);
            available = true;
            const execute = createLocalServicesRuntimeActionExecutor({ request: async () => new Response(JSON.stringify({
                v: 1, machineId: 'machine-a', generatedAt: 1_000, refreshState: 'idle', entries: [], diagnostics: [],
            })) });
            await execute({ actionId: 'localServices.inventory.refresh', context: { surface: 'ui', serverId }, input: { machineId: 'machine-a' } });
            await vi.waitFor(() => {
                for (const key of [source, bindings]) expect(getLocalServiceLauncherState(key).refreshStatus).toBe('idle');
            });
            expect(getLocalServiceLauncherState(otherHome).refreshStatus).toBe('error');
            expect(getLocalServiceLauncherState(healthy)).toBe(previousHealthy);
        } finally { dispose.forEach(unsubscribe => unsubscribe()); }
    });

    it('refreshes and restores a retired inventory watch after a successful Stop through the Action owner', async () => {
        let running = true;
        let generation = 1_000;
        let watches = 0;
        rpc.machine.mockImplementation(async (request: { method: string; payload?: { observationOnly?: true } }) => {
            if (request.payload?.observationOnly) return new Promise(() => {});
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
                if (++watches === 1) return { ok: false };
                return await new Promise(() => {});
            }
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) {
                return { protocolVersion: 1, snapshot: { v: 1, machineId: 'machine-a', generatedAt: generation,
                    refreshState: 'idle', entries: [], diagnostics: [] } };
            }
            return { protocolVersion: 1, snapshot: { ...snapshot, updatedAt: generation,
                targets: snapshot.targets.map(target => ({ ...target, serviceState: running ? 'healthy' : 'stopped' })) } };
        });
        const key = { machineId: 'machine-a', serverId: 'server-a', scope: 'workspace' as const, workspaceRoot: '/repo' };
        const unsubscribe = subscribeLocalServiceLauncherStore(key, () => {});
        await vi.waitFor(() => expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))[0]?.serviceState).toBe('healthy'));
        expect(watches).toBe(1);
        const execute = createLocalServicesRuntimeActionExecutor({ request: async (_path, init) => {
            const request = LocalServiceActionRequestV1Schema.parse(JSON.parse(String(init?.body)));
            running = false;
            generation = 2_000;
            return new Response(JSON.stringify(LocalServiceActionResultV1Schema.parse({ v: 1,
                requestId: request.requestId, action: request.action, status: 'succeeded', auditEvents: [{ v: 1,
                    eventId: 'stopped', requestId: request.requestId, action: request.action, machineId: request.target.machineId,
                    result: 'succeeded', recordedAt: generation }] })), { status: 200 });
        } });
        const result = await execute({ actionId: 'localServices.actions.stopManaged', context: { serverId: 'server-a', surface: 'ui' },
            input: { requestId: 'stop-preview', action: 'stop_managed', target: { kind: 'managed_service', machineId: 'machine-a',
                managedServiceId: 'preview' } } });
        expect(result).toMatchObject({ status: 'succeeded' });
        await vi.waitFor(() => expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))[0]?.serviceState).toBe('stopped'));
        expect(watches).toBe(2);
        unsubscribe();
    });

    it('publishes action snapshots into the same backing model without polling', async () => {
        const snapshotClient = rpc.launcher.mockResolvedValue({
            protocolVersion: 1,
            snapshot: { ...snapshot, targets: [] },
        });
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };
        const listener = vi.fn();

        const unsub = subscribeLocalServiceLauncherStore(key, listener);
        await flushMicrotasks();
        listener.mockClear();

        publishLocalServiceLauncherSnapshot(key, snapshot);

        expect(listener).toHaveBeenCalled();
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))).toEqual(snapshot.targets);
        expect(snapshotClient).toHaveBeenCalledTimes(2);

        unsub();
    });

    it('re-reads scoped projections when an Action publishes a broader launcher snapshot', async () => {
        let generation = 1_000;
        rpc.launcher.mockImplementation(async () => ({ protocolVersion: 1, snapshot: { ...snapshot, updatedAt: generation } }));
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a',
            scope: 'workspace' as const, workspaceRoot: '/repo' };
        const unsubscribe = subscribeLocalServiceLauncherStore(key, () => {});
        await flushMicrotasks();
        generation = 2_000;
        publishLocalServiceLauncherSnapshot({ machineId: 'machine-a', serverId: 'server-a' }, {
            ...snapshot, updatedAt: 2_000, targets: [],
        });
        await flushMicrotasks();
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))).toEqual(snapshot.targets);
        expect(readLocalServiceLauncherSnapshotTime(getLocalServiceLauncherState(key))).toBe(2_000);
        unsubscribe();
    });

    it('does not re-fetch launch targets on a wall clock while subscribed', async () => {
        const snapshotClient = rpc.launcher.mockResolvedValue({
            protocolVersion: 1,
            snapshot,
        });
        const key = {
            machineId: 'machine-a',
            serverId: 'server-a',
            sessionId: 'session-a',
            scope: 'workspace' as const,
            workspaceRoot: '/repo',
        };

        await expectNoWallClockPolling({
            subscribe: () => subscribeLocalServiceLauncherStore(key, () => {}),
            fetchSpy: snapshotClient,
        });
    });
});
