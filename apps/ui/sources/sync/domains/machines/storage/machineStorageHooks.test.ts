import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HappierStorageSummaryV1, MachineStorageWatchResultV1 } from '@happier-dev/protocol/storage/storageV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import type { MachineVitalsWatchResultV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';

installDisconnectedServerSocketBoundary();
const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
// Only the Machine network is replaced; credential binding, Actions, hooks and both stores run for real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: transport.rpc }));
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { machineStorageStore } = await import('./machineStorageStore');
const { machineResourceStore } = await import('../resources/machineResourceStore');
const { useMachineStorageSummary } = await import('./useMachineStorageSummary');
const { useMachineStorageCategory } = await import('./useMachineStorageCategory');
const { useMachineStoragePile } = await import('./useMachineStoragePile');
const { useMachineStorageScan } = await import('./useMachineStorageScan');
const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
const { storage } = await import('@/sync/domains/state/storageStore');
const { useMachineDaemonReadTargets, resolveMachineDaemonReadServerId } = await import('../useMachineDaemonReadTarget');
const { selectStorageTabView } = await import('@/components/machines/storage/storageViewModel');

function report(revision: number): HappierStorageSummaryV1 {
    return { revision, sizedAt: 100, volumes: [], categories: [
        { categoryId: 'logs', size: { allocatedBytes: revision, freesBytes: 0, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false }, count: 1, canGoBytes: 0, detailFacts: {} },
        { categoryId: 'caches', size: { allocatedBytes: 10, freesBytes: 0, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false }, count: 1, canGoBytes: 0, detailFacts: {} },
    ], suggestionsTop: [], pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 }, wholeDisk: { enabled: false, scans: [] } };
}

const beforeState = storage.getState();
beforeEach(async () => { await home.reset(); machineStorageStore.reset(); machineResourceStore.reset(); transport.rpc.mockReset(); });
afterEach(async () => { standardCleanup(); machineStorageStore.reset(); machineResourceStore.reset(); storage.setState(beforeState); await home.reset(); });

describe('machine storage hooks', () => {
    it('keeps cold measurement in Sizing and advances through the existing watch to measured figures', async () => {
        const serverId = await home.addHome({ name: 'Storage Home', serverUrl: 'https://storage-sizing.test', serverIdentityId: 'srv_storage_sizing', accountId: 'owner' });
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: 'machine', active: true, activeAt: Date.now() })]);
        home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
        const watches: Array<ReturnType<typeof createDeferred<MachineStorageWatchResultV1>>> = [];
        transport.rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method === RPC_METHODS.DAEMON_STORAGE_WATCH) {
                const answer = createDeferred<MachineStorageWatchResultV1>(); watches.push(answer); return answer.promise;
            }
            if (method === RPC_METHODS.MACHINES_VITALS_GET) return { state: 'unavailable', reason: 'unavailable' };
            if (method === RPC_METHODS.DAEMON_STORAGE_SIZE_REFRESH) return { ...report(4), measurement: { status: 'ready' } };
            return { ...report(1), categories: [], measurement: { status: 'measuring', hasMeasured: false } };
        });
        const hook = await renderHook(() => useMachineStorageSummary({ serverId, machineId: 'machine', expectedAccountId: 'owner' }));
        try {
            await act(async () => { await vi.waitFor(() => expect(watches).toHaveLength(1)); });
            expect(hook.getCurrent()).toMatchObject({ status: 'loading', summary: null });
            expect(selectStorageTabView({ ...hook.getCurrent(), recipient: false }).kind).toBe('loading');
            await act(async () => {
                watches[0]!.resolve({ changed: true, summary: { ...report(2), measurement: { status: 'ready' } } });
                await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', summary: { revision: 2 } }));
            });
            expect(selectStorageTabView({ ...hook.getCurrent(), recipient: false }).kind).toBe('ready');
            expect(transport.rpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET)).toHaveLength(1);
            await act(async () => {
                await vi.waitFor(() => expect(watches).toHaveLength(2));
                watches[1]!.resolve({ changed: true, summary: { ...report(2), revision: 3,
                    measurement: { status: 'failed', hasMeasured: true, error: 'Storage measurement failed' } } });
                await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'error',
                    summary: { sizedAt: 100 }, failure: { reason: 'request_failed' } }));
            });
            await act(async () => {
                hook.getCurrent().retry();
                await vi.waitFor(() => expect(transport.rpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.DAEMON_STORAGE_SIZE_REFRESH)).toHaveLength(1));
                await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', summary: { revision: 4 } }));
            });
        } finally { await hook.unmount(); }
    });
    it('joins live Vitals capacity without rereading Storage or changing its summary on CPU-only ticks', async () => {
        const serverId = await home.addHome({ name: 'Storage Home', serverUrl: 'https://storage-vitals.test', serverIdentityId: 'srv_storage_vitals', accountId: 'owner' });
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: 'machine', active: true, activeAt: Date.now() })]);
        home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
        const sample = (sampledAt: number, availableBytes: number, busyPct = 20): MachineVitalsSampleV1 => ({
            v: 1, sampledAt, intervalMs: 15_000, cpu: { reported: true, busyPct },
            memory: { reported: false, reason: 'unavailable' }, network: { reported: false, reason: 'unavailable' },
            disk: { reported: true, volumes: [{ id: 'disk', label: 'System', mount: '/', totalBytes: 1000, availableBytes,
                availableIncludingPurgeableBytes: 500 }] },
        });
        const stored = { ...report(1), volumes: [{ volume: { volumeId: 'disk', label: 'System', mountPath: '/' }, totalBytes: 1000,
            freeBytes: 100, availableIncludingPurgeableBytes: 400, happierBytes: 100, pileBytes: 20, pileFreesBytes: 10, trashBytes: 0 },
            { volume: { volumeId: 'other', label: 'Other', mountPath: '/other' }, totalBytes: 1000,
                freeBytes: 100, happierBytes: 0, pileBytes: 0, pileFreesBytes: 0, trashBytes: 0 }],
            pile: { count: 1, freesBytes: 10, droppedSinceLastView: [] } };
        const watches: Array<ReturnType<typeof createDeferred<MachineVitalsWatchResultV1>>> = [];
        transport.rpc.mockImplementation(async ({ method, onDispatched }: { method: string; onDispatched?: () => void }) => {
            if (method === RPC_METHODS.DAEMON_STORAGE_WATCH) return new Promise(() => {});
            if (method === RPC_METHODS.DAEMON_VITALS_WATCH) {
                const answer = createDeferred<MachineVitalsWatchResultV1>(); watches.push(answer); onDispatched?.(); return answer.promise;
            }
            if (method === RPC_METHODS.MACHINES_VITALS_GET) return { state: 'reporting', sample: sample(100, 200),
                series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } };
            return stored;
        });
        let renders = 0;
        const targetKey = { serverId: resolveMachineDaemonReadServerId(serverId), machineId: 'machine', expectedAccountId: 'owner' };
        const hook = await renderHook(() => { renders++; return useMachineStorageSummary({ serverId, machineId: 'machine', expectedAccountId: 'owner' }); });
        try {
            await act(async () => { await vi.waitFor(() => expect(hook.getCurrent().summary?.volumes[0]?.freeBytes).toBe(200)); });
            const retained = machineStorageStore.getState(targetKey).summary;
            const readCount = transport.rpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET).length;
            const vitalsReadCount = transport.rpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.MACHINES_VITALS_GET).length;
            await act(async () => { await vi.waitFor(() => expect(watches).toHaveLength(1)); });
            await act(async () => { watches[0]!.resolve({ changed: true, samples: [sample(200, 300)] });
                await vi.waitFor(() => expect(hook.getCurrent().summary?.volumes[0]?.freeBytes).toBe(300)); });
            const joined = hook.getCurrent().summary;
            const renderCount = renders;
            await act(async () => { await vi.waitFor(() => expect(watches).toHaveLength(2));
                watches[1]!.resolve({ changed: true, samples: [sample(300, 300, 70)] });
                await vi.waitFor(() => expect(watches).toHaveLength(3)); });
            expect(hook.getCurrent().summary).toBe(joined);
            expect(renders).toBe(renderCount);
            await hook.rerender();
            expect(watches).toHaveLength(3);
            expect(transport.rpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.MACHINES_VITALS_GET)).toHaveLength(vitalsReadCount);
            expect(transport.rpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.DAEMON_STORAGE_WATCH)).toHaveLength(1);
            expect(joined?.pile).toBe(retained?.pile);
            expect(joined?.volumes[0]).toMatchObject({ freeBytes: 300, availableIncludingPurgeableBytes: 500, happierBytes: 100, pileFreesBytes: 10 });
            expect(joined?.volumes[1]).toBe(retained?.volumes[1]);
            expect(machineStorageStore.getState(targetKey).summary).toBe(retained);
            expect(transport.rpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET)).toHaveLength(readCount);
        } finally { await hook.unmount(); }
    });
    it('retires a failed read on an authoritative offline push and retains the last ready storage report', async () => {
        const before = storage.getState();
        const serverId = await home.addHome({ name: 'Storage Home', serverUrl: 'https://storage-expiry.test', serverIdentityId: 'srv_storage_expiry', accountId: 'owner' });
        home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
        const machine = createMachineFixture({ id: 'machine', active: true, activeAt: Date.now() });
        storage.setState({ machines: {}, machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
        transport.rpc.mockRejectedValue(new Error('Request failed'));
        vi.useFakeTimers();
        const hook = await renderHook(useMachineStorageSummary, { initialProps: { serverId, machineId: 'machine', expectedAccountId: 'owner' } });
        const targets = await renderHook(() => useMachineDaemonReadTargets({ serverId, machineIds: ['machine'] }));
        try {
            await act(async () => { await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'error', offline: false, summary: null })); });
            await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
            expect(hook.getCurrent().offline).toBe(false);
            await act(async () => storage.setState({ machineListByServerId: { [serverId]: [{ ...machine, active: false }] } }));
            expect({ storage: hook.getCurrent(), targets: targets.getCurrent() }).toMatchObject({
                storage: { offline: true, summary: null }, targets: [{ offline: true, enabled: false }],
            });
            expect(selectStorageTabView({ ...hook.getCurrent(), recipient: false }).kind).toBe('offline_empty');
            const dispatches = transport.rpc.mock.calls.length;
            await act(async () => { hook.getCurrent().retry(); });
            expect(transport.rpc.mock.calls).toHaveLength(dispatches);
            transport.rpc.mockImplementation(async ({ method }: { method: string }) => method === RPC_METHODS.DAEMON_STORAGE_WATCH
                ? new Promise(() => {}) : report(2));
            const heartbeat = { ...machine, activeAt: Date.now() };
            await act(async () => {
                storage.setState({ machineListByServerId: { [serverId]: [heartbeat] } });
                await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', offline: false, summary: { revision: 2 } }));
            });
            const known = hook.getCurrent().summary;
            await act(async () => storage.setState({ machineListByServerId: { [serverId]: [{ ...heartbeat, active: false }] } }));
            expect(hook.getCurrent()).toMatchObject({ status: 'ready', offline: true });
            expect(hook.getCurrent().summary).toBe(known);
            expect(hook.getCurrent().summary?.sizedAt).toBe(100);
            expect(selectStorageTabView({ ...hook.getCurrent(), recipient: false })).toMatchObject({ kind: 'ready', offline: true, stale: false });
        } finally {
            await targets.unmount();
            await hook.unmount();
            vi.useRealTimers();
            storage.setState(before);
        }
    });
    it('reads a private scan view through the bound Action and refuses mutations while offline', async () => {
        const serverId = await home.addHome({ name: 'Storage Home', serverUrl: 'https://storage-scan.test', serverIdentityId: 'srv_storage_scan', accountId: 'owner' });
        const machine = createMachineFixture({ id: 'machine', active: true, activeAt: Date.now() });
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [machine]);
        home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
        const page = { state: null, nodes: [], coverage: [], indexedAt: 100 };
        const scan = { scanId: 'scan', target: { volumeId: 'volume' }, status: 'running', startedAt: 100,
            progress: { sizedBytes: 0, usedBytes: 100, items: 0 }, unreadable: { counts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, examples: [] },
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'processcustody', path: '/native' } } };
        transport.rpc.mockImplementation(async ({ method }: { method: string }) => method === RPC_METHODS.DAEMON_STORAGE_WATCH
            ? new Promise(() => {}) : method === RPC_METHODS.DAEMON_STORAGE_SCAN_GET ? page
                : method === RPC_METHODS.DAEMON_STORAGE_SCAN_START || method === RPC_METHODS.DAEMON_STORAGE_SCAN_CANCEL || method === RPC_METHODS.DAEMON_STORAGE_SCAN_SKIP
                    ? scan : report(1));
        const input = { serverId, machineId: 'machine', expectedAccountId: 'owner', online: true,
            view: { tab: 'old' as const, depth: 1 as const, olderThanDays: 1000 } };
        const hook = await renderHook(useMachineStorageScan, { initialProps: input });
        await act(async () => { await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ scanStatus: 'ready', page })); });
        expect(transport.rpc).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_STORAGE_SCAN_GET, serverId: 'srv_storage_scan', accountId: 'owner',
            payload: { machineId: 'machine', serverId: 'srv_storage_scan', view: input.view } }));
        await act(async () => {
            expect(await hook.getCurrent().start({ target: { volumeId: 'volume' } })).toEqual({ ok: true, value: scan });
            expect(await hook.getCurrent().cancel('scan')).toEqual({ ok: true, value: scan });
            expect(await hook.getCurrent().skip('scan', '/slow')).toEqual({ ok: true, value: scan });
        });
        expect(transport.rpc).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_STORAGE_SCAN_SKIP,
            serverId: 'srv_storage_scan', accountId: 'owner', payload: { machineId: 'machine', serverId: 'srv_storage_scan', scanId: 'scan', path: '/slow' } }));
        await act(async () => { await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [{ ...machine, active: false, activeAt: 1 }]); });
        await hook.rerender({ ...input, online: false });
        expect(hook.getCurrent()).toMatchObject({ offline: true, page });
        const count = transport.rpc.mock.calls.length;
        expect(await hook.getCurrent().start({ target: { volumeId: 'volume' } })).toEqual({ ok: false, reason: 'request_failed' });
        expect(transport.rpc.mock.calls).toHaveLength(count);
        await hook.unmount();
    });
    it('ticks the pile through the bound Account Action and settles optimistic membership from the daemon', async () => {
        const serverId = await home.addHome({ name: 'Storage Home', serverUrl: 'https://storage-pile.test',
            serverIdentityId: 'srv_storage_pile', accountId: 'owner' });
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: 'machine', active: true, activeAt: Date.now() })]);
        home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
        const pending = createDeferred<unknown>();
        const ref = { itemId: 'log', path: '/logs/old', identity: { dev: '1', ino: '2', kind: 'file' as const },
            collectedAt: 100, collectedBy: { accountId: 'owner', kind: 'person' as const } };
        // The tick sends the served reference; the machine answers with the identity it resolved.
        const served = { itemId: 'log', path: '/logs/old' };
        transport.rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method === RPC_METHODS.DAEMON_STORAGE_WATCH) return new Promise(() => {});
            if (method === RPC_METHODS.DAEMON_STORAGE_PILE_GET) return { revision: 1, items: [], summary: report(1).pile };
            if (method === RPC_METHODS.DAEMON_STORAGE_PILE_SET) return pending.promise;
            return report(1);
        });
        const hook = await renderHook(() => useMachineStoragePile({ serverId, machineId: 'machine', expectedAccountId: 'owner', online: true }));
        await act(async () => { await vi.waitFor(() => expect(transport.rpc.mock.calls.some(([input]) => input.method === RPC_METHODS.DAEMON_STORAGE_PILE_GET)).toBe(true)); });
        let writing!: ReturnType<ReturnType<typeof hook.getCurrent>['set']>;
        await act(async () => { writing = hook.getCurrent().set({ add: [served] }); });
        expect(hook.getCurrent()).toMatchObject({ items: [served], pile: { count: 1 }, pending: true });
        await act(async () => { pending.resolve({ revision: 2, items: [ref], summary: { ...report(2).pile, count: 1 } }); await writing; });
        expect(hook.getCurrent().items).toEqual([ref]);
        expect(hook.getCurrent().pending).toBe(false);
        expect(transport.rpc).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_STORAGE_PILE_SET,
            serverId: 'srv_storage_pile', accountId: 'owner', payload: { machineId: 'machine', serverId: 'srv_storage_pile', add: [served] } }));
        await hook.unmount();
    });
    it('keeps the bound Home projection without rereading credentials when only its label changes', async () => {
        const serverUrl = 'https://storage-rebind.test';
        const serverId = await home.addHome({ name: 'Storage Home', serverUrl, serverIdentityId: 'srv_storage_rebind', accountId: 'owner' });
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [createMachineFixture({ id: 'machine', active: true, activeAt: Date.now() })]);
        home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
        transport.rpc.mockImplementation(async ({ method }: { method: string }) => method === RPC_METHODS.DAEMON_STORAGE_WATCH ? new Promise(() => {}) : report(1));
        const hook = await renderHook(() => useMachineStorageSummary({ serverId, machineId: 'machine', online: true }));
        await act(async () => { await vi.waitFor(() => expect(transport.rpc).toHaveBeenCalled()); });
        expect(hook.getCurrent().summary?.revision).toBe(1);
        const known = hook.getCurrent().summary;
        const watchSignal: AbortSignal | undefined = transport.rpc.mock.calls.find(([input]) => input.method === RPC_METHODS.DAEMON_STORAGE_WATCH)?.[0].signal;
        expect(watchSignal?.aborted).toBe(false);
        // Only the profile transaction acquires the shared Home lock; a label change
        // must preserve the existing credential binding without another device read.
        const deviceLock = vi.spyOn(navigator.locks, 'request');
        try {
            await act(async () => { await upsertServerProfile({ serverUrl, name: 'Renamed Home' }); });
            expect(deviceLock).toHaveBeenCalledOnce();
            expect(hook.getCurrent().summary).toBe(known);
            expect(watchSignal?.aborted).toBe(false);
        } finally {
            deviceLock.mockRestore();
            await hook.unmount();
        }
    });

    it('shares demand, keeps unchanged projection consumers still, and retains reports while offline', async () => {
        const serverId = await home.addHome({ name: 'Storage Home', serverUrl: 'https://storage-home.test', serverIdentityId: 'srv_storage_home', accountId: 'owner' });
        const machine = createMachineFixture({ id: 'machine', active: true, activeAt: Date.now() });
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [machine]);
        home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
        const watches: { signal?: AbortSignal; answer: ReturnType<typeof createDeferred<MachineStorageWatchResultV1>> }[] = [];
        let revision = 1;
        transport.rpc.mockImplementation(async (input: { method: string; signal?: AbortSignal }) => {
            if (input.method === RPC_METHODS.DAEMON_STORAGE_WATCH) {
                const answer = createDeferred<MachineStorageWatchResultV1>(); watches.push({ signal: input.signal, answer }); return answer.promise;
            }
            if (input.method === RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST) return { revision, sizedAt: 100, categoryId: 'caches', items: [] };
            return report(revision);
        });
        const input = { serverId, machineId: 'machine', expectedAccountId: 'owner', online: true };
        let pileRenders = 0;
        let scanRenders = 0;
        const summary = await renderHook(useMachineStorageSummary, { initialProps: input });
        const category = await renderHook(props => useMachineStorageCategory({ ...props, categoryId: 'caches' }), { initialProps: input });
        const pile = await renderHook(props => { pileRenders++; return useMachineStoragePile(props); }, { initialProps: input });
        const scan = await renderHook(props => { scanRenders++; return useMachineStorageScan(props); }, { initialProps: input });
        expect(summary.getCurrent().summary?.revision).toBe(1);
        expect(watches).toHaveLength(1);
        const oldCategory = category.getCurrent().category;
        const oldPile = pile.getCurrent();
        const oldScan = scan.getCurrent();
        const oldCallbacks = { retry: summary.getCurrent().retry, sizeAgain: summary.getCurrent().sizeAgain };
        const counts = { pile: pileRenders, scan: scanRenders };
        await act(async () => { revision = 2; watches[0].answer.resolve({ changed: true, summary: report(revision) }); });
        expect(summary.getCurrent().summary?.revision).toBe(2);
        expect(category.getCurrent().category).toBe(oldCategory);
        expect(pile.getCurrent()).toBe(oldPile);
        expect(scan.getCurrent()).toBe(oldScan);
        expect({ pile: pileRenders, scan: scanRenders }).toEqual(counts);
        expect(summary.getCurrent().retry).toBe(oldCallbacks.retry);
        expect(summary.getCurrent().sizeAgain).toBe(oldCallbacks.sizeAgain);
        await category.unmount(); await pile.unmount(); await scan.unmount();
        expect(watches.at(-1)?.signal?.aborted).toBe(false);
        await act(async () => { await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [{ ...machine, active: false, activeAt: 1 }]); });
        await summary.rerender({ ...input, online: false });
        expect(summary.getCurrent()).toMatchObject({ offline: true, status: 'ready', summary: { revision: 2 } });
        expect(watches.at(-1)?.signal?.aborted).toBe(true);
        const dispatches = transport.rpc.mock.calls.length;
        const reopened = await renderHook(useMachineStorageSummary, { initialProps: { ...input, online: false } });
        expect(reopened.getCurrent().summary?.revision).toBe(2);
        expect(transport.rpc.mock.calls).toHaveLength(dispatches);
        await summary.unmount(); await reopened.unmount();
    });
});
