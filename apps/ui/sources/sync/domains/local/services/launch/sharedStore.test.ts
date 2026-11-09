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
import { buildLocalServiceRows, groupLocalServiceRowsBySection, selectLocalServiceRunningCount } from '../serviceRow';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { getLocalServiceInventoryState, publishLocalServiceInventoryMachineSummary, resetLocalServiceInventoryStoreForTests,
    subscribeLocalServiceInventoryStore } from '../inventory/sharedStore';
import { createLocalServicesRuntimeActionExecutor } from '../actions/runtimeActionExecutor';
import { startLocalServiceLauncherTargetViaMachineRpc } from './machineRpc';
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

// Returning demand reads the daemon-kept inventory; an explicit refresh rescans it. Both answer the inventory.
const isInventoryRead = (method: string) => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT
    || method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH;

async function flushMicrotasks(): Promise<void> {
    await flushHookEffects();
}

describe('shared local-service launcher store', () => {
    it('settles requester-owned rows through a scoped watch when broad inventory is refused', async () => {
        const watches: Array<(value: unknown) => void> = [];
        rpc.machine.mockImplementation(async (request: { method: string; payload?: { launcherProjection?: unknown } }) => {
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT) return { protocolVersion: 1, snapshot };
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH && request.payload?.launcherProjection) {
                return new Promise(resolve => watches.push(resolve));
            }
            return { error: 'requester_credentials_unavailable' };
        });
        const key = { machineId: 'machine-a', serverId: 'server-a', accountId: 'guest', credentialKey: 'guest-credential' };
        const release = subscribeLocalServiceLauncherStore(key, () => {});
        try {
            await vi.waitFor(() => expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))).toEqual(snapshot.targets));
            await vi.waitFor(() => expect(watches).toHaveLength(1));
            watches[0]!({ protocolVersion: 1, changed: true, snapshot: { ...snapshot, updatedAt: 2_000, targets: [] } });
            await vi.waitFor(() => expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))).toEqual([]));
            expect(watches).toHaveLength(2);
            expect(getLocalServiceLauncherState(key).refreshStatus).toBe('idle');
        } finally { release(); }
    });

    it('hydrates a declared Service while the scan owner exposes one failed observation', async () => {
        const key = { machineId: 'machine-a', serverId: 'server-a', workspaceRoot: '/repo' };
        const diagnostic = { code: 'local_services_inventory_scan_failed', severity: 'error' };
        let declared = LocalServiceLauncherSnapshotV1Schema.parse({ ...snapshot, targets: [{
            id: 'declared:web', source: 'managed_service', machineId: key.machineId, title: 'Web',
            confidence: 'high', state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [],
            workspace: { serverId: key.serverId, machineId: key.machineId, workspaceId: 'checkout', rootPath: '/repo' },
            declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'web' } },
        }] });
        rpc.machine.mockImplementation(async (request: { method: string; payload?: { observationOnly?: true } }) => {
            if (request.payload?.observationOnly) return new Promise(() => {});
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return new Promise(() => {});
            if (isInventoryRead(request.method)) return { protocolVersion: 1,
                snapshot: { v: 1, machineId: key.machineId, generatedAt: 1_000, refreshState: 'error',
                    entries: [], diagnostics: [diagnostic] } };
            return { protocolVersion: 1, snapshot: declared };
        });
        const releaseInventory = subscribeLocalServiceInventoryStore(key, () => {});
        let releaseLauncher: (() => void) | undefined;
        try {
            await vi.waitFor(() => expect(getLocalServiceInventoryState(key).refreshState).toBe('error'));
            releaseLauncher = subscribeLocalServiceLauncherStore(key, () => {});
            await readLocalServiceLauncherStore(key);
            const state = getLocalServiceLauncherState(key);
            const rows = buildLocalServiceRows({ inventoryRows: [], launchTargets: selectLocalServiceLaunchTargets(state),
                sessionId: null, scope: 'workspace' });
            expect(rows).toEqual([expect.objectContaining({ title: 'Web', status: 'stopped',
                primaryAction: { kind: 'start', target: declared.targets[0] } })]);
            expect(state.refreshStatus).toBe('idle');
            expect(getLocalServiceInventoryState(key).diagnostics).toEqual([diagnostic]);
            // A new connection must read declarations even if the same scan failure persists.
            declared = { ...declared, updatedAt: 2_000, targets: declared.targets.map(target => ({ ...target, title: 'Renamed web' })) };
            publishHomeAccountChange(key.serverId, undefined, { source: 'connected' });
            await vi.waitFor(() => expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))[0]?.title).toBe('Renamed web'));
            expect(getLocalServiceInventoryState(key).diagnostics).toEqual([diagnostic]);
        } finally { releaseLauncher?.(); releaseInventory(); }
    });

    it('settles a remounted Session projection from its scoped Start receipt while the Machine push is still parked', async () => {
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a', scope: 'workspace' as const };
        const started = createDeferred<void>();
        let running = false;
        const nativeSnapshot = () => ({ ...snapshot, updatedAt: running ? 2_000 : 1_000,
            targets: snapshot.targets.map(target => ({ ...target, serviceState: running ? 'running' as const : 'stopped' as const })) });
        rpc.machine.mockImplementation(async (request: { method: string; payload: { targetId?: string; observationOnly?: true } }) => {
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START) {
                await started.promise;
                return { protocolVersion: 1, machineId: key.machineId, targetId: request.payload.targetId,
                    status: 'succeeded', snapshot: nativeSnapshot() };
            }
            if (request.payload?.observationOnly) return new Promise(() => {});
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return new Promise(() => {});
            if (isInventoryRead(request.method)) return { protocolVersion: 1,
                snapshot: { v: 1, machineId: key.machineId, generatedAt: 1_000, refreshState: 'idle', entries: [], diagnostics: [] } };
            return { protocolVersion: 1, snapshot: nativeSnapshot() };
        });
        const rows = () => buildLocalServiceRows({ inventoryRows: [],
            launchTargets: selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key)), sessionId: key.sessionId, scope: 'workspace' });
        let release = subscribeLocalServiceLauncherStore(key, () => {});
        const execute = createLocalServicesRuntimeActionExecutor({ startLauncherTarget: startLocalServiceLauncherTargetViaMachineRpc });
        let action: Promise<unknown> | undefined;
        try {
            await vi.waitFor(() => expect(rows()[0]?.status).toBe('stopped'));
            action = execute({ actionId: 'localServices.launcher.start', context: { serverId: key.serverId, surface: 'ui' },
                input: { machineId: key.machineId, sessionId: key.sessionId, targetId: snapshot.targets[0]!.id,
                    workspace: { serverId: key.serverId, machineId: key.machineId, workspaceId: 'checkout', rootPath: '/repo' },
                    declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'web' } } } });
            await vi.waitFor(() => expect(rpc.machine.mock.calls.filter(([request]) => (
                request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START
            ))).toHaveLength(1));
            release();
            release = subscribeLocalServiceLauncherStore(key, () => {});
            await flushMicrotasks();
            expect(rows()[0]?.status).toBe('stopped');
            const projectionReads = () => rpc.machine.mock.calls.filter(([request]) => (
                request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT
            )).length;
            const readsBeforeReceipt = projectionReads();
            running = true;
            started.resolve();
            expect(await action).toMatchObject({ status: 'succeeded' });
            await vi.waitFor(() => expect(rows()[0]?.status).toBe('running'));
            expect(projectionReads()).toBe(readsBeforeReceipt + 1);
            const settledRequests = rpc.machine.mock.calls.length;
            vi.useFakeTimers();
            try {
                await vi.advanceTimersByTimeAsync(10 * 60_000);
                expect(rpc.machine).toHaveBeenCalledTimes(settledRequests);
            } finally { vi.useRealTimers(); }
        } finally { started.resolve(); await action; release(); }
    });
    it('converges after a Services owner remounts during Start and ignores the retired watch', async () => {
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a', scope: 'workspace' as const,
            accountId: 'account-a', credentialKey: 'credential-a' };
        const watches: Array<{ signal: AbortSignal; resolve(value: unknown): void }> = [];
        let running = false;
        let generation = 1_000;
        rpc.machine.mockImplementation(async (request: { method: string; signal: AbortSignal; payload?: { observationOnly?: true } }) => {
            if (request.payload?.observationOnly) return new Promise(() => {});
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
                return new Promise(resolve => watches.push({ signal: request.signal, resolve }));
            }
            if (isInventoryRead(request.method)) return { protocolVersion: 1,
                snapshot: { v: 1, machineId: key.machineId, generatedAt: generation, refreshState: 'idle', entries: [], diagnostics: [] } };
            return { protocolVersion: 1, snapshot: { ...snapshot, updatedAt: generation,
                targets: snapshot.targets.map(target => ({ ...target, serviceState: running ? 'running' : 'stopped' })) } };
        });
        const rows = () => buildLocalServiceRows({ inventoryRows: [],
            launchTargets: selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key)), sessionId: key.sessionId, scope: 'workspace' });
        let release = subscribeLocalServiceLauncherStore(key, () => {});
        try {
            await vi.waitFor(() => expect(watches).toHaveLength(1));
            expect(rows()[0]?.status).toBe('stopped');
            release();
            expect(watches[0]?.signal.aborted).toBe(true);
            release = subscribeLocalServiceLauncherStore(key, () => {});
            await vi.waitFor(() => expect(watches).toHaveLength(2));
            running = true;
            generation = 2_000;
            watches[1]!.resolve({ protocolVersion: 1, changed: true,
                snapshot: { ...snapshot, updatedAt: generation,
                    targets: snapshot.targets.map(target => ({ ...target, serviceState: 'running' })) } });
            await vi.waitFor(() => expect(rows()[0]?.status).toBe('running'));
            expect(watches).toHaveLength(3);
            const calls = rpc.machine.mock.calls.length;
            watches[0]!.resolve({ protocolVersion: 1, changed: false });
            await flushMicrotasks();
            expect(rows()[0]?.status).toBe('running');
            expect(rpc.machine).toHaveBeenCalledTimes(calls);
            expect(watches.filter(watch => !watch.signal.aborted)).toHaveLength(2);
        } finally { release(); }
    });
    beforeEach(() => {
        rpc.launcher.mockReset();
        rpc.machine.mockReset().mockImplementation(async (request: { method: string; payload?: { observationOnly?: true } }) => {
            if (isInventoryRead(request.method)) {
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
            if (isInventoryRead(request.method)) return { protocolVersion: 1,
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
            if (isInventoryRead(request.method)) return { protocolVersion: 1,
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

    it('retains last-known rows and groups after watch retirement and recovers at the same inventory generation', async () => {
        const watches: Array<(value: unknown) => void> = [];
        let available = true;
        rpc.machine.mockImplementation(async (request: { method: string; payload?: { observationOnly?: true } }) => {
            if (request.payload?.observationOnly) return new Promise(() => {});
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return new Promise(resolve => watches.push(resolve));
            if (isInventoryRead(request.method)) return { protocolVersion: 1,
                snapshot: { v: 1, machineId: 'machine-a', generatedAt: 1_000, refreshState: 'idle', entries: [], diagnostics: [] } };
            return { protocolVersion: 1, snapshot: LocalServiceLauncherSnapshotV1Schema.parse({ ...snapshot,
                targets: [...snapshot.targets.map(target => ({ ...target, state: available ? 'available' : 'unavailable',
                    ...(available ? {} : { unavailableReason: 'launch_unavailable' }), actions: available ? ['start'] : [] })),
                { id: 'declared:docs', source: 'managed_service', machineId: 'machine-a', title: 'Docs',
                    confidence: 'high', state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [],
                    workspace: { serverId: 'server-a', machineId: 'machine-a', workspaceId: 'checkout', rootPath: '/repo' },
                    declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'docs' } } }] }) };
        });
        const key = { machineId: 'machine-a', serverId: 'server-a' };
        const release = subscribeLocalServiceLauncherStore(key, () => {});
        const rows = () => buildLocalServiceRows({ inventoryRows: [], launchTargets: selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key)),
            sessionId: 'session-a', scope: 'machine' });
        try {
            await vi.waitFor(() => expect(rows()[0]?.status).toBe('running'));
            await vi.waitFor(() => expect(watches).toHaveLength(1));
            const lastKnownTargets = selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key));
            const lastKnownRows = rows();
            const lastKnownGroups = groupLocalServiceRowsBySection(lastKnownRows);
            expect(lastKnownGroups.map(group => group.section)).toEqual(['running', 'ready']);
            watches[0]!({ invalid: true });
            await flushMicrotasks();
            expect.soft(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))).toBe(lastKnownTargets);
            expect.soft(rows()).toEqual(lastKnownRows);
            expect.soft(groupLocalServiceRowsBySection(rows())).toEqual(lastKnownGroups);
            expect.soft(selectLocalServiceRunningCount(rows())).toBe(1);
            expect.soft(getLocalServiceLauncherState(key).updatedAt).toBe(snapshot.updatedAt);
            available = false;
            publishHomeAccountChange(key.serverId, undefined, { source: 'connected' });
            await vi.waitFor(() => expect(watches).toHaveLength(2));
            await vi.waitFor(() => expect(rows()[0]?.status).toBe('unavailable'));
        } finally { release(); }
    });

    it('recovers a failed Session read on authenticated reconnect without unrelated inventory receipt rereads', async () => {
        const watches: Array<(value: unknown) => void> = [];
        rpc.launcher.mockResolvedValue({ protocolVersion: 1, snapshot });
        rpc.machine.mockImplementation(async (request: { method: string; payload?: { observationOnly?: true } }) => {
            if (request.payload?.observationOnly) return new Promise(() => {});
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return new Promise(resolve => watches.push(resolve));
            if (isInventoryRead(request.method)) return { protocolVersion: 1,
                snapshot: { v: 1, machineId: 'machine-a', generatedAt: 1_000, refreshState: 'idle', entries: [], diagnostics: [] } };
            return rpc.launcher(request);
        });
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };
        const listener = vi.fn();
        const release = subscribeLocalServiceLauncherStore(key, listener);
        try {
            await vi.waitFor(() => expect(watches).toHaveLength(1));
            await flushMicrotasks();
            rpc.launcher.mockRejectedValueOnce(new Error('independent launcher failure'));
            invalidateLocalServiceLauncherStore(key);
            await vi.waitFor(() => expect(getLocalServiceLauncherState(key).refreshStatus).toBe('error'));
            const reads = rpc.launcher.mock.calls.length;
            publishLocalServiceInventoryMachineSummary({ ...key, machineId: 'other-machine' }, { v: 1, state: 'ready', runningCount: 1 });
            publishLocalServiceInventoryMachineSummary(key, { v: 1, state: 'unknown' });
            await flushMicrotasks();
            expect(rpc.launcher).toHaveBeenCalledTimes(reads);
            publishHomeAccountChange(key.serverId, undefined, { source: 'connected' });
            await vi.waitFor(() => expect(getLocalServiceLauncherState(key).refreshStatus).toBe('idle'));
            expect(watches).toHaveLength(1);
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

    it('reads a recovered launcher independently of inventory and retains subsequent projected changes', async () => {
            const key = { machineId: 'machine-a', serverId: 'server-a' };
            const watches: Array<(value: unknown) => void> = [];
            const launcherReply = createDeferred<unknown>();
            let holdLauncher = false;
            rpc.machine.mockImplementation(async (request: { method: string; payload?: { observationOnly?: true } }) => {
                if (request.payload?.observationOnly) return new Promise(() => {});
                if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return new Promise(resolve => watches.push(resolve));
                if (isInventoryRead(request.method)) throw new Error('Launcher must not read broad inventory');
                return rpc.launcher(request);
            });
            rpc.launcher.mockImplementation(() => holdLauncher ? launcherReply.promise : Promise.resolve({ protocolVersion: 1, snapshot }));
            const release = subscribeLocalServiceLauncherStore(key, () => {});
            try {
                await vi.waitFor(() => expect(watches).toHaveLength(1));
                await flushMicrotasks();
                rpc.launcher.mockRejectedValueOnce(new Error('independent launcher failure'));
                invalidateLocalServiceLauncherStore(key);
                await readLocalServiceLauncherStore(key);
                expect(getLocalServiceLauncherState(key).refreshStatus).toBe('error');
                const reads = rpc.launcher.mock.calls.length;
                holdLauncher = true;
                publishHomeAccountChange(key.serverId, undefined, { source: 'connected' });
                await flushMicrotasks();
                await vi.waitFor(() => expect(rpc.launcher.mock.calls.length - reads).toBe(1));
                holdLauncher = false;
                launcherReply.resolve({ protocolVersion: 1, snapshot: { ...snapshot, updatedAt: 2_000 } });
                await vi.waitFor(() => expect(getLocalServiceLauncherState(key).refreshStatus).toBe('idle'));
                expect(watches).toHaveLength(1);
                watches[0]!({ protocolVersion: 1, changed: true,
                    snapshot: { ...snapshot, updatedAt: 3_000, targets: [] } });
                await vi.waitFor(() => expect(getLocalServiceLauncherState(key).targetIds).toEqual([]));
                expect(rpc.launcher.mock.calls.length - reads).toBe(1);
                expect(getLocalServiceLauncherState(key).refreshStatus).toBe('idle');
            } finally { launcherReply.resolve({ invalid: true }); release(); }
    });

    it('refreshes all launcher projections after external runtime changes without a mounted surface refresh', async () => {
        const watches: Array<(value: unknown) => void> = [];
        let generation = 1_000;
        let running = true;
        rpc.machine.mockImplementation(async (request: { method: string; payload: { projection?: string; workspaceRoot?: string; observationOnly?: true } }) => {
            if (request.payload?.observationOnly) return new Promise(() => {});
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
                return await new Promise(resolve => watches.push(resolve));
            }
            if (isInventoryRead(request.method)) {
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
        // Each qualified projection receives only its own material snapshot.
        const changed = { protocolVersion: 1, changed: true, snapshot: { ...snapshot, updatedAt: generation,
            targets: snapshot.targets.map(target => ({ ...target, serviceState: 'stopped' })) } };
        watches[0]!(changed);
        watches[1]!(changed);
        await vi.waitFor(() => expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(source))[0]?.serviceState).toBe('stopped'));
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(bindings))[0]?.serviceState).toBe('stopped');
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(otherHome))[0]?.serviceState).toBe('healthy');
        dispose.forEach(unsubscribe => unsubscribe());
    });

    it('shares one initial launcher read regardless of how many consumers subscribe', async () => {
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

        expect(snapshotClient).toHaveBeenCalledTimes(1);
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

    it('refreshes and restores a retired projected watch after a successful Stop through the Action owner', async () => {
        let running = true;
        let generation = 1_000;
        let watches = 0;
        rpc.machine.mockImplementation(async (request: { method: string; payload?: { observationOnly?: true } }) => {
            if (request.payload?.observationOnly) return new Promise(() => {});
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
                if (++watches === 1) return { ok: false };
                return await new Promise(() => {});
            }
            if (isInventoryRead(request.method)) {
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
        // Machine execution is the transport boundary; Action settlement/publication stay real.
        const execute = createLocalServicesRuntimeActionExecutor({ executeOnMachine: async args => {
            const request = LocalServiceActionRequestV1Schema.parse(args.input);
            running = false;
            generation = 2_000;
            return LocalServiceActionResultV1Schema.parse({ v: 1,
                requestId: request.requestId, action: request.action, status: 'succeeded', auditEvents: [{ v: 1,
                    eventId: 'stopped', requestId: request.requestId, action: request.action, machineId: request.target.machineId,
                    result: 'succeeded', recordedAt: generation }] });
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
        expect(snapshotClient).toHaveBeenCalledTimes(1);

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
