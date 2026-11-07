import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { MACHINE_STORAGE_ACTION_IDS } from '@happier-dev/protocol/actions/specs/storage';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { HappierStorageSummaryV1Schema, MachineStorageCategoryListResultV1Schema, MachineStorageScanGetResultV1Schema, DiskScanStateV1Schema, PileItemRefV1Schema, StorageItemV1Schema,
    type HappierStorageSummaryV1, type MachineStorageCategoryListResultV1, type MachineStorageWatchResultV1 } from '@happier-dev/protocol/storage/storageV1';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { createMachineStorageStore, type MachineStorageStore } from './machineStorageStore';
import { describeStoragePileBar } from '@/components/machines/storage/storagePileModel';
import { fetchMachineStorageSummaryViaAction, fetchMachineStorageCategoryViaAction, refreshMachineStorageSizeViaAction, watchMachineStorageViaMachineRpc,
    type MachineStorageClients, type MachineStorageWatchInput } from './machineRpc';

const boundary = vi.hoisted(() => ({ reply: vi.fn(), rpc: vi.fn() }));
// The fixture replies sit behind the Machine network. Actions, admission, parsers and stores remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(boundary.rpc);
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
// The front door is lazy: load its real executor graph after the system boundaries,
// during collection so cold module transforms do not consume the first behavior test's clock.
await import('@/sync/ops/actions/defaultActionExecutor');

const key = { serverId: 'home-a', machineId: 'machine-a', expectedAccountId: 'account-a' };
beforeEach(async () => {
    await homes.reset();
    key.serverId = await homes.addHome({ name: 'Storage store', serverUrl: 'https://storage-store.test',
        serverIdentityId: 'srv_storage_store', accountId: key.expectedAccountId, currentAccount: true });
    homes.answer(key.serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1: {
        v: 1, actions: {}, approvalWaivedSurfaces: {
            'machines.storage.trash.move': ['ui'], 'machines.storage.trash.empty': ['ui'],
        },
    } } }, version: 1 } });
});
afterEach(async () => { await homes.reset(); });
const summary = (revision = 1): HappierStorageSummaryV1 => HappierStorageSummaryV1Schema.parse({
    revision, sizedAt: 100, volumes: [], categories: [
        { categoryId: 'logs', size: { allocatedBytes: 20, freesBytes: 10, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false }, canGoBytes: 10, count: 1, detailFacts: {} },
        { categoryId: 'caches', size: { allocatedBytes: 30, freesBytes: 30, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false }, canGoBytes: 30, count: 1, detailFacts: {} },
    ], suggestionsTop: [], pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 }, wholeDisk: { enabled: false, scans: [] },
});
const category = (revision = 1): MachineStorageCategoryListResultV1 => MachineStorageCategoryListResultV1Schema.parse({ revision, sizedAt: 100, categoryId: 'logs', items: [], nextCursor: 'next-page' });
const success = (result: unknown) => ({ ok: true, result });
const unavailable = { ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'Method not found' };
const failed = { ok: false, errorCode: 'request_failed', error: 'Request failed' };
const stores: MachineStorageStore[] = [];
function harness() {
    boundary.reply.mockReset(); boundary.rpc.mockReset();
    const watches: { input: Pick<MachineStorageWatchInput, 'signal'>; answer: ReturnType<typeof createDeferred<MachineStorageWatchResultV1>> }[] = [];
    const responses = {
        summary: vi.fn<(input: unknown) => Promise<unknown>>(async () => success(summary())),
        category: vi.fn<(input: unknown) => Promise<unknown>>(async () => success(category())),
        refresh: vi.fn<(input: unknown) => Promise<unknown>>(async () => success(summary(2))),
    };
    boundary.reply.mockImplementation((action: string, input: unknown) => {
        if (action === 'machines.storage.summary.get') return responses.summary(input);
        if (action === 'machines.storage.category.list') return responses.category(input);
        if (action === 'machines.storage.size.refresh') return responses.refresh(input);
        throw new Error(`Unexpected storage Action: ${action}`);
    });
    boundary.rpc.mockImplementation(async (input: { method: string; payload: unknown; signal?: AbortSignal }) => {
        if (input.method === RPC_METHODS.DAEMON_STORAGE_WATCH) {
            const answer = createDeferred<MachineStorageWatchResultV1>();
            watches.push({ input, answer });
            return answer.promise;
        }
        const action = MACHINE_STORAGE_ACTION_IDS.find(id => getActionSpec(id).bindings?.rpcMethod === input.method);
        if (!action) throw new Error(`Unexpected storage RPC: ${input.method}`);
        const reply = await boundary.reply(action, input.payload);
        return reply.ok ? reply.result : reply;
    });
    const clients: MachineStorageClients = {
        summaryClient: fetchMachineStorageSummaryViaAction,
        categoryClient: fetchMachineStorageCategoryViaAction,
        refreshClient: refreshMachineStorageSizeViaAction,
        watchClient: watchMachineStorageViaMachineRpc,
    };
    const store = createMachineStorageStore(clients);
    stores.push(store);
    return { responses, watches, store };
}

describe('machine storage subscription owner', () => {
    it('reads no unchanged pile or category for six scan pushes and reads each changed fact once', async () => {
        type WatchAnswer = Awaited<ReturnType<MachineStorageClients['watchClient']>>;
        const watches: Array<ReturnType<typeof createDeferred<WatchAnswer>>> = [];
        let report = { ...summary(), pileRevision: 1, itemsRevision: 1,
            categories: summary().categories.map(row => ({ ...row, revision: 1 })),
            wholeDisk: { enabled: true, scans: [DiskScanStateV1Schema.parse({ scanId: 'scan',
                target: { folderPath: '/scan' }, status: 'running', startedAt: 100,
                progress: { sizedBytes: 16_199_680, items: 1181 },
                unreadable: { counts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, examples: [] },
                fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: '/fixture' } },
            })] } };
        const categoryRead = vi.fn<MachineStorageClients['categoryClient']>(async input => ({ ok: true,
            value: { ...category(report.revision), categoryId: input.categoryId } }));
        const pileRead = vi.fn(async () => ({ ok: true as const, value: { revision: report.revision,
            items: report.pile.count ? [PileItemRefV1Schema.parse({ itemId: 'selected', path: '/selected',
                identity: { dev: '1', ino: '1', kind: 'directory' }, collectedAt: 100,
                collectedBy: { accountId: key.expectedAccountId, kind: 'person' } })] : [], summary: report.pile } }));
        const itemsRead = vi.fn(async () => ({ ok: true as const, value: { revision: report.revision, items: [] } }));
        const store = createMachineStorageStore({ summaryClient: async () => ({ ok: true, value: report }),
            categoryClient: categoryRead, pileClient: pileRead, itemsClient: itemsRead,
            refreshClient: async () => ({ ok: true, value: report }), watchClient: () => {
                const answer = createDeferred<WatchAnswer>(); watches.push(answer); return answer.promise;
            } });
        stores.push(store);
        const logs = { ...key, categoryId: 'logs' as const };
        const caches = { ...key, categoryId: 'caches' as const };
        const worktrees = { ...key, list: 'worktrees' as const, filter: 'safe' as const };
        await store.read(key);
        const releases = [store.demandCategory(logs), store.demandCategory(caches), store.demandPile(key), store.demandItems(worktrees)];
        const push = async () => {
            const index = watches.length - 1;
            watches[index]!.resolve({ ok: true, value: { changed: true, summary: structuredClone(report) } });
            await vi.waitFor(() => {
                expect(watches).toHaveLength(index + 2);
                expect(store.getState(key).summary?.revision).toBe(report.revision);
                expect(store.getCategory(logs).status).toBe('ready');
                expect(store.getCategory(caches).status).toBe('ready');
                expect(store.getPile(key).status).toBe('ready');
                expect(store.getItems(worktrees).status).toBe('ready');
            });
        };
        try {
            await vi.waitFor(() => {
                expect(watches).toHaveLength(1);
                expect(store.getCategory(logs).status).toBe('ready');
                expect(store.getCategory(caches).status).toBe('ready');
                expect(store.getPile(key).status).toBe('ready');
                expect(store.getItems(worktrees).status).toBe('ready');
            });
            categoryRead.mockClear(); pileRead.mockClear(); itemsRead.mockClear();
            for (let index = 0; index < 6; index++) {
                report = structuredClone(report); report.revision++;
                report.wholeDisk.scans[0]!.progress.items += 13_130;
                await push();
            }
            expect.soft(pileRead).toHaveBeenCalledTimes(0);
            expect.soft(categoryRead).toHaveBeenCalledTimes(0);
            expect.soft(itemsRead).toHaveBeenCalledTimes(0);
            expect(store.getState(key).summary?.wholeDisk.scans[0]?.progress.items).toBe(79_961);
            // A refreshed actor projection may change a detail without moving the scan cursor.
            report = { ...report, pileRevision: 2,
                pile: { ...report.pile, count: 1 } };
            await push();
            await vi.waitFor(() => expect(pileRead).toHaveBeenCalledTimes(1));
            expect.soft(categoryRead).toHaveBeenCalledTimes(0);
            expect(store.getPile(key).page?.items).toMatchObject([{ itemId: 'selected' }]);
            report = { ...report, revision: report.revision + 1,
                categories: report.categories.map(row => row.categoryId === 'logs' ? { ...row, revision: 2, count: 2 } : row) };
            await push();
            expect(pileRead).toHaveBeenCalledTimes(1);
            expect(categoryRead).toHaveBeenCalledTimes(1);
            expect(categoryRead.mock.calls[0]?.[0].categoryId).toBe('logs');
            expect(itemsRead).toHaveBeenCalledTimes(0);
            report = { ...report, revision: report.revision + 1, itemsRevision: 2 };
            await push();
            await vi.waitFor(() => expect(itemsRead).toHaveBeenCalledTimes(1));
            expect(store.getItems(worktrees).page?.revision).toBe(report.revision);
            await store.read(key);
            expect(pileRead).toHaveBeenCalledTimes(1);
            expect(categoryRead).toHaveBeenCalledTimes(1);
            // The existing reconnect snapshot may come from a restarted daemon's revision zero.
            report = { ...report, revision: 0, pile: { ...report.pile, count: 0 } };
            await store.read(key);
            await vi.waitFor(() => expect(store.getPile(key).page?.items).toEqual([]));
            expect(pileRead).toHaveBeenCalledTimes(2);
        } finally { for (const release of releases) release(); }
    });

    it('retains unchanged summary scans and category Trash entries and groups through reordered changes', async () => {
        let report = { ...summary(), wholeDisk: { enabled: true, scans: ['first', 'second'].map(scanId => DiskScanStateV1Schema.parse({
            scanId, target: { folderPath: `/${scanId}` }, status: 'complete', startedAt: 100, finishedAt: 200,
            progress: { sizedBytes: 20, items: 1 },
            unreadable: { counts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, examples: [] },
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: '/fixture' } },
        })) } };
        let page = MachineStorageCategoryListResultV1Schema.parse({ ...category(), categoryId: 'trash',
            trashEntries: ['first', 'second'].map(entryId => ({ entryId, batchId: 'batch', volumeId: 'volume', originalPath: `/${entryId}`,
                title: entryId, size: summary().categories[0]!.size, movedAt: 100,
                movedBy: { accountId: key.expectedAccountId, kind: 'person' }, emptiesAt: null, restorable: true })),
            groups: [{ id: 'stopped', itemIds: ['first'] }, { id: 'recent', itemIds: ['second'] }],
        });
        const store = createMachineStorageStore({ summaryClient: async () => ({ ok: true, value: structuredClone(report) }),
            categoryClient: async () => ({ ok: true, value: structuredClone(page) }),
            refreshClient: async () => ({ ok: true, value: summary() }), watchClient: async () => new Promise(() => {}),
        });
        stores.push(store);
        const input = { ...key, categoryId: 'trash' as const };
        await store.read(key); await store.readCategory(input);
        const heldSummary = store.getState(key).summary!;
        const heldPage = store.getCategory(input).page!;
        const summaryUpdates = vi.fn(); const categoryUpdates = vi.fn();
        const stopSummary = store.observe(key, summaryUpdates); const stopCategory = store.observeCategory(input, categoryUpdates);
        try {
            for (let index = 0; index < 3; index++) { await store.read(key); await store.readCategory(input); }
            expect(summaryUpdates).not.toHaveBeenCalled(); expect(categoryUpdates).not.toHaveBeenCalled();
            report = structuredClone(report); report.revision++;
            report.wholeDisk.scans[0]!.progress.sizedBytes = 25; report.wholeDisk.scans.reverse();
            page = structuredClone(page); page.revision++;
            page.trashEntries![0]!.restorable = false; page.trashEntries!.reverse();
            page.groups![0]!.itemIds = []; page.groups!.reverse();
            await store.read(key); await store.readCategory(input);
            expect(summaryUpdates).toHaveBeenCalledTimes(1); expect(categoryUpdates).toHaveBeenCalledTimes(1);
            const current = store.getCategory(input).page!;
            expect(store.getState(key).summary?.wholeDisk.scans[0]).toBe(heldSummary.wholeDisk.scans[1]);
            expect(store.getState(key).summary?.wholeDisk.scans[1].progress.sizedBytes).toBe(25);
            expect(current.trashEntries?.[0]).toBe(heldPage.trashEntries?.[1]);
            expect(current.trashEntries?.[1].restorable).toBe(false);
            expect(current.groups?.[0]).toBe(heldPage.groups?.[1]);
            expect(current.groups?.[1].itemIds).toEqual([]);
        } finally { stopSummary(); stopCategory(); }
    });

    it('keeps equal scan and pile reads silent and retains unchanged rows through reordered changes', async () => {
        const size = summary().categories[0]!.size;
        let scan = MachineStorageScanGetResultV1Schema.parse({ state: null, coverage: [], nodes: ['first', 'second'].map(nodeId => ({
            nodeId, name: nodeId, kind: 'folder', size, logicalBytes: 20, items: 1, changedAt: 100, childCount: 0,
            flags: { happier: false, protection: 'none', atLeast: false, inUse: false },
        })) });
        let pile = { revision: 1, items: ['first', 'second'].map(itemId => PileItemRefV1Schema.parse({
            itemId, path: `/${itemId}`, identity: { dev: '1', ino: itemId, kind: 'directory' }, collectedAt: 100,
            collectedBy: { accountId: key.expectedAccountId, kind: 'person' },
        })), summary: { count: 2, freesBytes: 20, droppedSinceLastView: [] } };
        const store = createMachineStorageStore({ summaryClient: async () => ({ ok: true, value: summary() }),
            categoryClient: async () => ({ ok: true, value: category() }), refreshClient: async () => ({ ok: true, value: summary() }),
            watchClient: async () => new Promise(() => {}),
            scanClient: async () => ({ ok: true, value: structuredClone(scan) }),
            pileClient: async () => ({ ok: true, value: structuredClone(pile) }),
        });
        stores.push(store);
        const input = { ...key, view: { tab: 'folders' as const, depth: 1 as const } };
        await store.readScan(input); await store.readPile(key);
        const heldScan = store.getScan(input); const heldPile = store.getPile(key);
        const scanUpdates = vi.fn(); const pileUpdates = vi.fn();
        const stopScan = store.observeScan(input, scanUpdates); const stopPile = store.observePile(key, pileUpdates);
        try {
            for (let index = 0; index < 3; index++) { await store.readScan(input); await store.readPile(key); }
            expect(scanUpdates).not.toHaveBeenCalled(); expect(pileUpdates).not.toHaveBeenCalled();
            scan = structuredClone(scan); scan.nodes[0]!.size.allocatedBytes = 25; scan.nodes.reverse();
            pile = structuredClone(pile); pile.revision++;
            pile.items[0] = { ...pile.items[0]!, title: 'Changed' }; pile.items.reverse();
            await store.readScan(input); await store.readPile(key);
            expect(scanUpdates).toHaveBeenCalledTimes(1); expect(pileUpdates).toHaveBeenCalledTimes(1);
            expect(store.getScan(input).page?.nodes[0]).toBe(heldScan.page?.nodes[1]);
            expect(store.getScan(input).page?.nodes[1].size.allocatedBytes).toBe(25);
            expect(store.getPile(key).page?.items[0]).toBe(heldPile.page?.items[1]);
            expect(store.getPile(key).page?.items[1]).toMatchObject({ itemId: 'first', title: 'Changed' });
        } finally { stopScan(); stopPile(); }
    });

    it('keeps unavailable policy while cancellation and optimistic pile overlays update retained facts', async () => {
        const h = harness();
        const running = DiskScanStateV1Schema.parse({ scanId: 'scan', target: { folderPath: '/cache' }, status: 'running', startedAt: 100,
            progress: { sizedBytes: 100, items: 1 }, unreadable: { counts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, examples: [] },
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: '/fixture' } } });
        const stopped = { ...running, status: 'cancelled' as const, finishedAt: 200 };
        const report = { ...summary(), wholeDisk: { enabled: true, scans: [running] } };
        const scanInput = { ...key, scanId: 'scan', view: { tab: 'folders' as const, depth: 1 as const } };
        const refusal = { ok: false, errorCode: 'policy_unavailable', error: 'Storage policy is unavailable' };
        let policyAvailable = true;
        boundary.reply.mockImplementation((action: string) => {
            if (action === 'machines.storage.scan.cancel') return Promise.resolve(success(stopped));
            if (!policyAvailable) return Promise.resolve(refusal);
            return Promise.resolve(success(action === 'machines.storage.scan.get'
                ? { state: running, nodes: [], coverage: [] }
                : action === 'machines.storage.pile.get' ? { revision: 1, items: [], summary: report.pile } : report));
        });
        await h.store.read(key);
        await h.store.readPile(key);
        const release = h.store.demandScan(scanInput);
        const rootStatuses: string[] = [];
        const scanStatuses: string[] = [];
        let stopRoot = () => {};
        let stopScan = () => {};
        try {
            await h.store.readScan(scanInput);
            await h.store.read(key);
            policyAvailable = false;
            await h.store.read(key);
            await h.store.readPile(key);
            await h.store.readScan(scanInput);
            expect([h.store.getState(key).status, h.store.getPile(key).status, h.store.getScan(scanInput).status])
                .toEqual(['policy_unavailable', 'policy_unavailable', 'policy_unavailable']);
            stopRoot = h.store.observe(key, () => rootStatuses.push(h.store.getState(key).status));
            stopScan = h.store.observeScan(scanInput, () => scanStatuses.push(h.store.getScan(scanInput).status));
            expect(await h.store.cancelScan({ ...key, scanId: 'scan' })).toEqual({ ok: true, value: stopped });
            expect(h.store.getState(key)).toMatchObject({ status: 'policy_unavailable', summary: { wholeDisk: { scans: [stopped] } } });
            expect(h.store.getScan(scanInput)).toMatchObject({ status: 'policy_unavailable', page: { state: stopped } });
            const ref = { itemId: 'cache', path: '/cache' };
            const writing = h.store.setPile({ ...key, add: [ref] });
            expect(h.store.getState(key)).toMatchObject({ status: 'policy_unavailable', summary: { pile: { count: 1 } } });
            expect(h.store.getPile(key)).toMatchObject({ status: 'policy_unavailable', pending: true, page: { items: [ref] } });
            await writing;
            expect(h.store.getState(key)).toMatchObject({ status: 'policy_unavailable', summary: { pile: { count: 0 } } });
            expect(rootStatuses).not.toContain('ready');
            expect(scanStatuses).not.toContain('ready');
        } finally { stopRoot(); stopScan(); release(); }
    });
    it('settles an unavailable-policy watch without automatic rereads or re-polls', async () => {
        const h = harness();
        await h.store.read(key);
        expect(h.store.getState(key).status).toBe('ready');
        const release = h.store.demand(key);
        try {
            await vi.waitFor(() => expect(h.watches).toHaveLength(1));
            const known = h.store.getState(key).summary;
            const reads = h.responses.summary.mock.calls.length;
            h.watches[0]!.answer.reject(new RpcError('Storage policy is unavailable', 'policy_unavailable'));
            await vi.waitFor(() => expect(h.store.getState(key).status).toBe('policy_unavailable'));
            vi.useFakeTimers();
            await vi.advanceTimersByTimeAsync(120_000);
            expect(h.store.getState(key).summary).toBe(known);
            expect(h.responses.summary).toHaveBeenCalledTimes(reads);
            expect(h.watches).toHaveLength(1);
        } finally { release(); }
    });
    it('retains the typed policy status after fresh review, scan, cleanup and refresh refusals', async () => {
        const h = harness();
        await h.store.read(key);
        const known = h.store.getState(key).summary;
        // Apply consumes the daemon-resolved review ref, not a served view's short ref.
        const ref = PileItemRefV1Schema.parse({ itemId: 'log', path: '/logs/old', identity: { dev: '1', ino: '2', kind: 'file' },
            collectedAt: 100, collectedBy: { accountId: key.expectedAccountId, kind: 'person' } });
        for (const [operation, request] of [
            ['review', () => h.store.checkPile({ ...key, refs: [ref] })],
            ['scan', () => h.store.startScan({ ...key, target: { folderPath: '/logs' } })],
            ['apply', () => h.store.applyPile({ ...key, mode: 'trash', items: [{ ref, expect: 'reviewed' }] })],
        ] as const) {
            boundary.rpc.mockResolvedValue(summary());
            await h.store.read(key);
            expect(h.store.getState(key).status).toBe('ready');
            boundary.rpc.mockRejectedValue(new RpcError('Storage policy is unavailable', 'policy_unavailable'));
            expect(await request(), operation).toEqual({ ok: false, reason: 'policy_unavailable' });
            expect(h.store.getState(key), operation).toEqual({ status: 'policy_unavailable', summary: known });
        }
        boundary.rpc.mockResolvedValue(summary());
        await h.store.read(key);
        expect(h.store.getState(key).status).toBe('ready');
        boundary.rpc.mockRejectedValue(new RpcError('Storage policy is unavailable', 'policy_unavailable'));
        expect(await h.store.sizeAgain(key)).toEqual({ status: 'policy_unavailable', summary: known });
        expect(h.store.getState(key).summary).toBe(known);
    });
    it('keeps a refused scan start as page state until the next attempt or success', async () => {
        const h = harness();
        const running = DiskScanStateV1Schema.parse({ scanId: 'scan', target: { folderPath: '/cache' }, status: 'running', startedAt: 100,
            progress: { sizedBytes: 100, items: 1 }, unreadable: { counts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, examples: [] },
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: '/fixture' } } });
        const target = { folderPath: '/cache' };
        const answers: unknown[] = [
            { ok: false, errorCode: 'storage_whole_disk_disabled', error: 'Whole-disk scan disabled' },
            { ok: false, errorCode: 'something_new', error: 'A refusal this client has never seen' },
            success(running),
        ];
        boundary.reply.mockImplementation((action: string) => {
            if (action === 'machines.storage.scan.start') return Promise.resolve(answers.shift());
            return Promise.resolve(success(summary()));
        });
        const notified = vi.fn();
        const stop = h.store.observeScanStartFailure(key, notified);
        expect(h.store.getScanStartFailure(key)).toBeNull();
        expect(await h.store.startScan({ ...key, target })).toEqual({ ok: false, reason: 'whole_disk_disabled' });
        expect(h.store.getScanStartFailure(key)).toEqual({ reason: 'whole_disk_disabled', target });
        expect(notified).toHaveBeenCalledTimes(1);
        // An unknown refusal is kept too, as the generic reason the view words plainly.
        expect(await h.store.startScan({ ...key, target })).toMatchObject({ ok: false });
        expect(h.store.getScanStartFailure(key)).toEqual({ reason: 'request_failed', target });
        expect(await h.store.startScan({ ...key, target })).toMatchObject({ ok: true });
        expect(h.store.getScanStartFailure(key)).toBeNull();
        stop();
    });
    it('clears the previous scan refusal when the next attempt starts, and keeps nothing when the person declined', async () => {
        const h = harness();
        const target = { volumeId: 'disk' };
        const second = createDeferred<unknown>();
        const answers: unknown[] = [{ ok: false, errorCode: 'request_failed', error: 'Request failed' }];
        boundary.reply.mockImplementation((action: string) => {
            if (action !== 'machines.storage.scan.start') return Promise.resolve(success(summary()));
            return answers.length ? Promise.resolve(answers.shift()) : second.promise;
        });
        await h.store.startScan({ ...key, target });
        expect(h.store.getScanStartFailure(key)).not.toBeNull();
        const retry = h.store.startScan({ ...key, target });
        await vi.waitFor(() => expect(h.store.getScanStartFailure(key)).toBeNull());
        second.resolve({ ok: false, errorCode: 'approval_rejected', error: 'Declined' });
        expect(await retry).toEqual({ ok: false, reason: 'declined' });
        expect(h.store.getScanStartFailure(key)).toBeNull();
    });
    it('retains last-known sizes while policy is unavailable and recovers on the daemon policy edge', async () => {
        const h = harness();
        await h.store.read(key);
        const known = h.store.getState(key).summary;
        h.responses.summary.mockResolvedValue({ ok: false, errorCode: 'policy_unavailable', error: 'Storage policy is unavailable' });
        await h.store.read(key);
        expect(h.store.getState(key)).toEqual({ status: 'policy_unavailable', summary: known });
        h.responses.summary.mockResolvedValue(success(summary(2)));
        const release = h.store.demand(key);
        try {
            h.store.daemonStateChanged(key, 2);
            await vi.waitFor(() => expect(h.store.getState(key).status).toBe('ready'));
            expect(h.store.getState(key).summary?.revision).toBe(2);
        } finally { release(); }
    });
    afterEach(() => { for (const store of stores.splice(0)) store.reset(); vi.useRealTimers(); });
    it.each([
        { source: 'action', staleStopped: false }, { source: 'watch', staleStopped: false },
        { source: 'action', staleStopped: true }, { source: 'watch', staleStopped: true },
    ] as const)('publishes the stopped retained total before a slow page refresh ($source; old stop: $staleStopped)', async ({ source, staleStopped }) => {
        const running = DiskScanStateV1Schema.parse({ scanId: 'scan', target: { folderPath: '/cache' }, status: 'running', startedAt: 100,
            progress: { sizedBytes: 100, items: 1, usedBytes: 0 }, unreadable: { counts: { permission: 0, os_private: 0, timeout: 0, io: 0 }, examples: [] },
            fullDiskAccess: { state: 'not_applicable', binary: { name: 'fixture', path: '/fixture' } } });
        const stopped = { ...running, status: 'cancelled' as const, finishedAt: 200, progress: { ...running.progress, sizedBytes: 1000, items: 10 } };
        const page = MachineStorageScanGetResultV1Schema.parse({ state: staleStopped ? { ...running, status: 'cancelled', finishedAt: 150 } : running, nodes: [], coverage: [], indexedAt: 100,
            root: { nodeId: '/cache', name: 'cache', kind: 'folder', logicalBytes: 100, items: 1, changedAt: 100, childCount: 0,
                size: { allocatedBytes: 100, freesBytes: 0, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: true },
                flags: { happier: false, protection: 'none', atLeast: true, inUse: false } } });
        const report = { ...summary(), wholeDisk: { enabled: true, scans: [running] } };
        const slow = createDeferred<Awaited<ReturnType<NonNullable<MachineStorageClients['scanClient']>>>>();
        const watches: Array<ReturnType<typeof createDeferred<Awaited<ReturnType<MachineStorageClients['watchClient']>>>>> = [];
        let reading = false; let cancelled = false;
        const store = createMachineStorageStore({ summaryClient: async () => ({ ok: true, value: cancelled
            ? { ...report, revision: 2, wholeDisk: { enabled: true, scans: [stopped] } } : report }),
            categoryClient: async () => ({ ok: true, value: category() }), refreshClient: async () => ({ ok: true, value: report }),
            watchClient: () => { const answer = createDeferred<Awaited<ReturnType<MachineStorageClients['watchClient']>>>(); watches.push(answer); return answer.promise; },
            scanClient: async request => {
                const response = reading ? await slow.promise : { ok: true as const, value: page };
                return response.ok && request.view?.nodeId ? { ...response, value: { ...response.value,
                    root: { ...page.root!, nodeId: request.view.nodeId, parentId: '/cache' } } } : response;
            },
            scanCancelClient: async () => { cancelled = true; return { ok: true, value: stopped }; } });
        stores.push(store);
        const input = { ...key, scanId: running.scanId, view: { tab: 'folders' as const, depth: 1 as const } };
        const drill = { ...input, view: { ...input.view, nodeId: '/cache/child' } };
        const release = store.demandScan(input);
        const releaseDrill = store.demandScan(drill);
        try {
            await vi.waitFor(() => expect(store.getScan(input).page).toEqual(page));
            await vi.waitFor(() => expect(store.getScan(drill).page?.root?.nodeId).toBe('/cache/child'));
            await store.read(key);
            reading = true; const staleRead = store.readScan(input);
            if (source === 'action') await store.cancelScan({ ...key, scanId: running.scanId });
            else {
                cancelled = true;
                watches[0]!.resolve({ ok: true, value: { changed: true, summary: { ...report, revision: 2, wholeDisk: { enabled: true, scans: [stopped] } } } });
                await vi.waitFor(() => expect(store.getState(key).summary?.wholeDisk.scans[0]?.status).toBe('cancelled'));
            }
            expect(store.getState(key).summary?.wholeDisk.scans[0]).toEqual(stopped);
            expect(store.getScan(input).page).toMatchObject({ state: stopped, root: { size: { allocatedBytes: 1000 }, items: 10 } });
            expect(store.getScan(drill).page).toMatchObject({ state: stopped, root: { nodeId: '/cache/child', size: { allocatedBytes: 100 }, items: 1 } });
            // A get dispatched before cancellation must not restore a running
            // page after the authorized terminal answer has been published.
            slow.resolve({ ok: true, value: page });
            await staleRead;
            await store.readScan(input);
            expect(store.getScan(input).page).toMatchObject({ state: stopped, root: { size: { allocatedBytes: 1000 } } });
        } finally { slow.resolve({ ok: true, value: page }); release(); releaseDrill(); }
    });
    it('rearms a changed Storage watch before notifying the summary or refreshing category pages', async () => {
        type WatchAnswer = Awaited<ReturnType<MachineStorageClients['watchClient']>>;
        const watches: Array<ReturnType<typeof createDeferred<WatchAnswer>>> = [];
        const order: string[] = [];
        let changed = false;
        const store = createMachineStorageStore({
            summaryClient: async () => ({ ok: true, value: summary() }),
            categoryClient: async () => {
                if (changed) order.push(`category:${watches.length}`);
                return { ok: true, value: category(changed ? 2 : 1) };
            },
            refreshClient: async () => ({ ok: true, value: summary() }),
            watchClient: () => {
                const answer = createDeferred<WatchAnswer>();
                watches.push(answer); return answer.promise;
            },
        });
        stores.push(store);
        const release = store.demandCategory({ ...key, categoryId: 'logs' });
        const unobserve = store.observe(key, () => {
            if (store.getState(key).summary?.revision === 2) order.push(`summary:${watches.length}`);
        });
        try {
            await vi.waitFor(() => expect(watches).toHaveLength(1));
            changed = true;
            watches[0]!.resolve({ ok: true, value: { changed: true, summary: summary(2) } });
            await vi.waitFor(() => expect(store.getCategory({ ...key, categoryId: 'logs' }).page?.revision).toBe(2));
            expect(order).toContain('summary:2');
            expect(order).toContain('category:2');
            expect(order).not.toContain('summary:1');
            expect(order).not.toContain('category:1');
        } finally { release(); unobserve(); }
    });
    it('retains daemon per-volume Safe totals and distinguishes an absent total from measured zero', async () => {
        const h = harness();
        const volume = { volume: { volumeId: 'main', label: 'Main', mountPath: '/' }, totalBytes: 1000,
            freeBytes: 500, happierBytes: 100, pileBytes: 0, trashBytes: 0 };
        const reported = { ...summary(), suggestionsSafeTop: [], suggestionsTotalCount: 0, volumes: [{ ...volume, canGoBytes: 10 },
            { ...volume, volume: { ...volume.volume, volumeId: 'secondary', mountPath: '/second' }, canGoBytes: 30 },
            { ...volume, volume: { ...volume.volume, volumeId: 'empty', mountPath: '/empty' }, canGoBytes: 0 },
            { ...volume, volume: { ...volume.volume, volumeId: 'unreported', mountPath: '/unknown' } }] };
        h.responses.summary.mockResolvedValue(success(reported));
        await h.store.read(key);
        expect(h.store.getState(key).summary?.volumes).toEqual(reported.volumes);
        const retained = h.store.getState(key).summary!.volumes[1];
        const safePreview = h.store.getState(key).summary!.suggestionsSafeTop;
        const release = h.store.demand(key);
        await vi.waitFor(() => expect(h.watches).toHaveLength(1));
        h.watches[0].answer.resolve({ changed: true, summary: { ...reported, revision: 2,
            volumes: [{ ...reported.volumes[0], canGoBytes: 20 }, ...reported.volumes.slice(1)] } });
        await vi.waitFor(() => expect(h.store.getState(key).summary?.volumes[0]).toMatchObject({ canGoBytes: 20 }));
        expect(h.store.getState(key).summary?.volumes[0]).toMatchObject({ canGoBytes: 20 });
        expect(h.store.getState(key).summary?.volumes[1]).toBe(retained);
        expect(h.store.getState(key).summary?.suggestionsSafeTop).toBe(safePreview);
        release();
    });
    it('shares private scan pages and refreshes them on the same revision watch without polling or scope leakage', async () => {
        const h = harness(); await h.store.read(key);
        const input = { ...key, view: { tab: 'old' as const, depth: 1 as const, olderThanDays: 1000 } };
        const page = { state: null, nodes: [], coverage: [], indexedAt: 100 };
        let current = page;
        boundary.reply.mockImplementation((action: string) => Promise.resolve(success(action === 'machines.storage.scan.get' ? current : summary())));
        vi.useFakeTimers();
        const first = h.store.demandScan(input); const second = h.store.demandScan(input);
        await vi.waitFor(() => expect(h.store.getScan(input)).toEqual({ status: 'ready', page }));
        expect(h.store.getScan(input)).toEqual({ status: 'ready', page });
        expect(h.store.getScan({ ...input, expectedAccountId: 'other' }).page).toBeNull();
        const retained = h.store.getScan(input).page;
        current = { ...page, indexedAt: 200 };
        await vi.waitFor(() => expect(h.watches).toHaveLength(1));
        h.watches[0].answer.resolve({ changed: true, summary: summary(2) });
        await vi.waitFor(() => expect(h.store.getScan(input).page?.indexedAt).toBe(200));
        expect(h.store.getScan(input).page?.indexedAt).toBe(200);
        expect(h.store.getScan(input).page).not.toBe(retained);
        const slow = createDeferred<unknown>();
        const scanReplies = vi.fn<() => Promise<unknown>>(async () => success(current))
            .mockImplementationOnce(() => slow.promise)
            .mockResolvedValueOnce(success({ ...page, indexedAt: 300 }));
        boundary.reply.mockImplementation((action: string) => action === 'machines.storage.scan.get'
            ? scanReplies() : Promise.resolve(success(summary(2))));
        h.store.retryScan(input);
        await vi.waitFor(() => expect(scanReplies).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(h.watches).toHaveLength(2));
        h.watches[1].answer.resolve({ changed: true, summary: summary(3) });
        await vi.waitFor(() => expect(h.store.getState(key).summary?.revision).toBe(3));
        slow.resolve(success(current));
        await vi.waitFor(() => expect(h.store.getScan(input).page?.indexedAt).toBe(300));
        expect(h.store.getScan(input).page?.indexedAt).toBe(300);
        expect(vi.getTimerCount()).toBe(0);
        first(); expect(h.watches.at(-1)?.input.signal?.aborted).toBe(false);
        second(); expect(h.watches.at(-1)?.input.signal?.aborted).toBe(true);
    });

    it('projects optimistic pile membership and rolls back a rejected delta against current daemon truth', async () => {
        const h = harness();
        await h.store.read(key);
        const served = { itemId: 'log-1', path: '/fixture/log' };
        const pending = createDeferred<unknown>();
        boundary.reply.mockImplementation((action: string) => action === 'machines.storage.pile.get'
            ? Promise.resolve(success({ revision: 1, items: [], summary: summary().pile }))
            : action === 'machines.storage.pile.set' ? pending.promise : Promise.resolve(success(summary())));
        await h.store.readPile(key);
        const writing = h.store.setPile({ ...key, add: [served] });
        expect(h.store.getPile(key)).toMatchObject({ page: { items: [served], summary: { count: 1 } }, pending: true });
        expect(h.store.getState(key).summary?.pile.count).toBe(1);
        await vi.waitFor(() => expect(boundary.reply.mock.calls.some(([action]) => action === 'machines.storage.pile.set')).toBe(true));
        pending.resolve(failed);
        expect(await writing).toEqual({ ok: false, reason: 'request_failed' });
        expect(h.store.getPile(key)).toMatchObject({ page: { items: [], summary: { count: 0 } }, pending: false });
        expect(h.store.getState(key).summary?.pile.count).toBe(0);
    });

    it('shares one watch across summary/category demand, preserves nested identities and aborts final demand without a timer', async () => {
        const h = harness();
        const suggestions = ['first', 'second'].map(itemId => StorageItemV1Schema.parse({
            itemId, kind: 'suggestion', title: itemId, path: `/${itemId}`, evidence: ['verified_cache_location'],
            size: summary().categories[0]!.size, verdict: 'safe', reason: { code: 'rebuilds' }, collectable: true,
        }));
        const initial = { ...summary(), suggestionsTop: suggestions, suggestionsSafeTop: structuredClone(suggestions) };
        h.responses.summary.mockImplementation(async () => success(structuredClone(initial)));
        // Establish the report through the real read before several consumers acquire demand.
        await h.store.read(key);
        vi.useFakeTimers();
        const releaseSummary = h.store.demand(key);
        const releaseCategory = h.store.demandCategory({ ...key, categoryId: 'logs' });
        await vi.waitFor(() => {
            expect(h.store.getCategory({ ...key, categoryId: 'logs' })).toMatchObject({ status: 'ready', page: { nextCursor: 'next-page' } });
            expect(h.watches).toHaveLength(1);
        });
        expect(h.store.getState(key).summary?.revision).toBe(1);
        expect(h.store.getCategory({ ...key, categoryId: 'logs' })).toMatchObject({ status: 'ready', page: { nextCursor: 'next-page' } });
        expect(h.watches).toHaveLength(1);
        const before = h.store.getState(key).summary!;
        const publications = vi.fn();
        const stop = h.store.observe(key, publications);
        for (let index = 0; index < 3; index++) await h.store.read(key);
        expect(publications).not.toHaveBeenCalled();
        const next = structuredClone(initial); next.revision++;
        next.categories[0].size.allocatedBytes = 25;
        for (const rows of [next.suggestionsTop, next.suggestionsSafeTop]) {
            rows[0]!.size.allocatedBytes = 25;
            rows.reverse();
        }
        h.responses.category.mockResolvedValueOnce(success(category(2)));
        h.watches[0].answer.resolve({ changed: true, summary: next });
        await vi.waitFor(() => expect(h.store.getCategory({ ...key, categoryId: 'logs' }).page).toMatchObject({ revision: 2, nextCursor: 'next-page' }));
        const after = h.store.getState(key).summary!;
        expect(publications).toHaveBeenCalledTimes(1);
        expect(after.revision).toBe(2);
        expect(after.suggestionsTop[0]).toBe(before.suggestionsTop[1]);
        expect(after.suggestionsSafeTop?.[0]).toBe(before.suggestionsSafeTop?.[1]);
        expect(after.suggestionsTop[1].size.allocatedBytes).toBe(25);
        expect(after.suggestionsSafeTop?.[1].size.allocatedBytes).toBe(25);
        expect(after.categories[1]).toBe(before.categories[1]);
        expect(after.pile).toBe(before.pile);
        expect(h.store.getCategory({ ...key, categoryId: 'logs' }).page).toMatchObject({ revision: 2, nextCursor: 'next-page' });
        expect(vi.getTimerCount()).toBe(0);
        releaseSummary(); expect(h.watches.at(-1)?.input.signal?.aborted).toBe(false);
        releaseCategory(); expect(h.watches.at(-1)?.input.signal?.aborted).toBe(true);
        stop();
        h.store.reset(); vi.useRealTimers();
    });

    it('keeps a pending pile tick visible through a daemon watch and rolls back onto its refreshed membership', async () => {
        const h = harness();
        await h.store.read(key);
        const ref = { itemId: 'log-1', path: '/fixture/log', identity: { dev: '1', ino: '2', kind: 'file' as const },
            collectedAt: 100, collectedBy: { accountId: 'account-a', kind: 'person' as const } };
        const other = { ...ref, itemId: 'log-2', path: '/fixture/other' };
        const served = { itemId: ref.itemId, path: ref.path };
        const pending = createDeferred<unknown>();
        let daemonItems = [other];
        boundary.reply.mockImplementation((action: string) => action === 'machines.storage.pile.get'
            ? Promise.resolve(success({ revision: 2, items: daemonItems,
                summary: { ...summary().pile, count: daemonItems.length } }))
            : action === 'machines.storage.pile.set' ? pending.promise : Promise.resolve(success(summary())));
        const release = h.store.demandPile(key);
        await vi.waitFor(() => {
            expect(h.store.getPile(key).page?.items).toEqual([other]);
            expect(h.watches).toHaveLength(1);
        });
        const writing = h.store.setPile({ ...key, add: [served] });
        await vi.waitFor(() => expect(boundary.reply.mock.calls.some(([action]) => action === 'machines.storage.pile.set')).toBe(true));
        daemonItems = [];
        h.watches[0].answer.resolve({ changed: true, summary: summary(3) });
        await vi.waitFor(() => expect(h.store.getPile(key)).toMatchObject({ page: { items: [served] }, pending: true }));
        expect(h.store.getState(key).summary?.pile.count).toBe(1);
        pending.resolve(failed); await writing;
        expect(h.store.getPile(key)).toMatchObject({ page: { items: [] }, pending: false });
        release();
    });

    it('retains the last report on errors and distinguishes Home and Account scopes', async () => {
        const h = harness();
        await h.store.read(key);
        const good = h.store.getState(key).summary;
        h.responses.summary.mockResolvedValueOnce(failed);
        await h.store.read(key);
        expect(h.store.getState(key)).toMatchObject({ status: 'error', summary: good });
        expect(h.store.getState({ ...key, serverId: 'home-b' }).summary).toBeNull();
        expect(h.store.getState({ ...key, expectedAccountId: 'account-b' }).summary).toBeNull();
        h.store.reset();
    });

    it('ignores aborted reads and old revisions arriving after a watched revision', async () => {
        const h = harness();
        const release = h.store.demand(key);
        await vi.waitFor(() => expect(h.watches).toHaveLength(1));
        expect(h.watches).toHaveLength(1);
        const slow = createDeferred<unknown>();
        h.responses.summary.mockImplementationOnce(() => slow.promise);
        const readCount = h.responses.summary.mock.calls.length;
        const pending = h.store.read(key);
        await vi.waitFor(() => expect(h.responses.summary).toHaveBeenCalledTimes(readCount + 1));
        h.watches[0].answer.resolve({ changed: true, summary: summary(3) });
        await vi.waitFor(() => expect(h.store.getState(key).summary?.revision).toBe(3));
        slow.resolve(success(summary(2))); await pending;
        expect(h.store.getState(key).summary?.revision).toBe(3);
        const late = createDeferred<unknown>();
        h.responses.summary.mockImplementationOnce(() => late.promise);
        const cancelled = h.store.read(key); release();
        late.resolve(success(summary(4))); await cancelled;
        expect(h.store.getState(key).summary?.revision).toBe(3);
        h.store.reset();
    });

    it('degrades only unavailable operations and retries after the daemon changes', async () => {
        const h = harness();
        h.responses.summary.mockResolvedValueOnce(unavailable);
        const release = h.store.demand(key);
        await vi.waitFor(() => expect(h.store.getState(key).status).toBe('not_reported'));
        expect(h.store.getState(key).status).toBe('not_reported');
        expect(h.watches).toHaveLength(0);
        h.store.daemonStateChanged(key, 2);
        await vi.waitFor(() => expect(h.store.getState(key).status).toBe('ready'));
        expect(h.store.getState(key).status).toBe('ready');
        h.responses.category.mockResolvedValueOnce(unavailable);
        const releaseCategory = h.store.demandCategory({ ...key, categoryId: 'logs' });
        await vi.waitFor(() => expect(h.store.getCategory({ ...key, categoryId: 'logs' }).status).toBe('not_reported'));
        expect(h.store.getCategory({ ...key, categoryId: 'logs' }).status).toBe('not_reported');
        expect(h.store.getState(key).status).toBe('ready');
        release(); releaseCategory(); h.store.reset();
    });

    it('keeps older-daemon pile mutation unavailable without hiding its supported summary', async () => {
        const h = harness();
        await h.store.read(key);
        boundary.reply.mockImplementation(async (action: string) => action === 'machines.storage.pile.get' ? unavailable : success(summary()));
        expect(await h.store.setPile({ ...key, clear: true })).toEqual({ ok: false, reason: 'older_happier' });
        expect(h.store.getState(key).status).toBe('ready');
        expect(boundary.reply.mock.calls.some(([action]) => action === 'machines.storage.pile.set')).toBe(false);
    });

    it('sizes explicitly once and publishes the new summary without starting a polling loop', async () => {
        const h = harness();
        await h.store.read(key);
        await h.store.sizeAgain({ ...key, categoryId: 'logs' });
        expect(h.store.getState(key).summary?.revision).toBe(2);
        expect(h.responses.refresh).toHaveBeenCalledWith(expect.objectContaining({ categoryId: 'logs' }));
        expect(h.watches).toHaveLength(0);
        h.store.reset();
    });

    it('does not let a pending Size again response overwrite a newer watched summary', async () => {
        const h = harness();
        const release = h.store.demand(key);
        await vi.waitFor(() => expect(h.watches).toHaveLength(1));
        const slow = createDeferred<unknown>();
        h.responses.refresh.mockImplementationOnce(() => slow.promise);
        const pending = h.store.sizeAgain(key);
        await vi.waitFor(() => expect(h.responses.refresh).toHaveBeenCalled());
        h.watches[0].answer.resolve({ changed: true, summary: summary(3) });
        await vi.waitFor(() => expect(h.store.getState(key).summary?.revision).toBe(3));
        slow.resolve(success(summary(2))); await pending;
        expect(h.store.getState(key).summary?.revision).toBe(3);
        release(); h.store.reset();
    });

    it('accepts a restarted daemon revision and does not let an obsolete category page win a watch invalidation', async () => {
        const h = harness();
        await h.store.read(key);
        h.responses.summary.mockResolvedValueOnce(success(summary(0)));
        await h.store.read(key);
        expect(h.store.getState(key).summary?.revision).toBe(0);
        const release = h.store.demand(key);
        await vi.waitFor(() => expect(h.watches).toHaveLength(1));
        const slow = createDeferred<unknown>();
        h.responses.category.mockImplementationOnce(() => slow.promise).mockResolvedValueOnce(success(category(3)));
        const releaseCategory = h.store.demandCategory({ ...key, categoryId: 'logs' });
        await vi.waitFor(() => expect(h.responses.category).toHaveBeenCalledTimes(1));
        h.watches[0].answer.resolve({ changed: true, summary: summary(3) });
        await vi.waitFor(() => expect(h.store.getState(key).summary?.revision).toBe(3));
        slow.resolve(success(category(1)));
        await vi.waitFor(() => expect(h.store.getCategory({ ...key, categoryId: 'logs' }).page?.revision).toBe(3));
        expect(h.store.getCategory({ ...key, categoryId: 'logs' }).page?.revision).toBe(3);
        releaseCategory(); release(); h.store.reset();
    });
});

describe('machine storage cleanup and item lists', () => {
    afterEach(() => { for (const store of stores.splice(0)) store.reset(); vi.useRealTimers(); });
    const ref = { itemId: 'wt-1', path: '/repo/.dev/worktree/a', identity: { dev: '1', ino: '2', kind: 'directory' as const },
        collectedAt: 1, collectedBy: { accountId: 'account-a', kind: 'person' as const } };
    const item = { itemId: 'wt-1', kind: 'worktree' as const, title: 'a', evidence: [], path: '/repo/.dev/worktree/a',
        size: { allocatedBytes: 5, freesBytes: 5, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false },
        verdict: 'safe' as const, reason: { code: 'merged_clean' as const }, collectable: true };

    it('checks the pile by served reference, never resending the identity the machine resolved', async () => {
        const h = harness();
        await h.store.read(key);
        const calls: Array<[string, unknown]> = [];
        boundary.reply.mockImplementation((action: string, input: unknown) => {
            calls.push([action, input]);
            return Promise.resolve(success(action === 'machines.storage.items.check' ? { items: [], staying: [], countedOnceBytes: 0, totalFreesBytes: 0, trashVolumes: [] } : summary()));
        });
        const resolved = { itemId: 'log-1', path: '/fixture/log', identity: { dev: '1', ino: '2', kind: 'file' as const },
            collectedAt: 100, collectedBy: { accountId: 'account-a', kind: 'person' as const } };
        await h.store.checkPile({ ...key, refs: [resolved] });
        expect((calls.find(([action]) => action === 'machines.storage.items.check')?.[1] as { refs: unknown }).refs).toEqual([{ itemId: 'log-1', path: '/fixture/log' }]);
    });

    it('retains category and receipt restore refusals and offers the same owner a beside retry', async () => {
        const h = harness();
        await h.store.read(key);
        const calls: unknown[] = [];
        boundary.reply.mockImplementation(async (action: string, input: { beside?: true }) => {
            if (action === 'machines.storage.trash.move') return success({ batchId: 'batch', mode: 'trash', inTrashBytes: 5, freedBytes: 0,
                trashEntryIds: ['occupied'], outcomes: [{ itemId: ref.itemId, status: 'moved' }] });
            if (action === 'machines.storage.trash.restore') {
                calls.push(input);
                return success({ outcomes: [{ entryId: 'occupied', ...(input.beside
                    ? { status: 'restored', path: '/cache/original (restored)' }
                    : { status: 'refused', reason: { code: 'destination_occupied' } }) }] });
            }
            return success(summary());
        });
        const changed = vi.fn();
        const release = h.store.observeRestoreOutcomes(key, changed);
        await h.store.restoreTrash({ ...key, entryIds: ['occupied'] });
        expect(h.store.getRestoreOutcomes(key)).toMatchObject({ occupied: { status: 'refused', reason: { code: 'destination_occupied' } } });
        expect(h.store.getRestoreOutcomes({ ...key, machineId: 'other' })).toEqual({});
        expect(changed).toHaveBeenCalledTimes(1);
        await h.store.restoreTrash({ ...key, entryIds: ['occupied'] });
        expect(changed).toHaveBeenCalledTimes(1);
        await h.store.applyPile({ ...key, mode: 'trash', items: [{ ref, expect: 'token', claimedVerdict: 'safe' }] });
        await h.store.undoReceipt(key);
        expect(h.store.getReceipt(key)).toMatchObject({ kind: 'applied', result: { batchId: 'batch' } });
        await h.store.restoreTrashBeside({ ...key, entryId: 'occupied' });
        expect(calls.at(-1)).toMatchObject({ entryIds: ['occupied'], beside: true });
        expect(h.store.getRestoreOutcomes(key)).toMatchObject({ occupied: { status: 'restored', path: '/cache/original (restored)' } });
        expect(h.store.getReceipt(key)).toBeNull();
        release();
    });

    it.each(['refused', 'failed'] as const)('retains a %s Empty entry and projects only the remaining Trash until retry settles', async status => {
        const h = harness();
        let retry = false;
        boundary.reply.mockImplementation(async (action: string) => {
            if (action === 'machines.storage.trash.move') return success({ batchId: 'batch', mode: 'trash', inTrashBytes: 30, freedBytes: 0,
                trashEntryIds: ['first', 'second'], outcomes: [{ itemId: 'a', status: 'moved' }, { itemId: 'b', status: 'moved' }] });
            if (action === 'machines.storage.trash.empty') return success({ outcomes: retry
                ? [{ entryId: 'second', status: 'deleted' }]
                : [{ entryId: 'first', status: 'deleted' }, { entryId: 'second', status, reason: { code: 'in_use' } }], freedBytes: retry ? 20 : 10 });
            return success(summary());
        });
        await h.store.applyPile({ ...key, mode: 'trash', items: [{ ref, expect: 'token', claimedVerdict: 'safe' }] });
        await h.store.emptyReceipt(key);
        const receipt = h.store.getReceipt(key);
        expect(receipt).toMatchObject({ kind: 'applied', trash: { remaining: [{ entryId: 'second' }], deletedCount: 1, freedBytes: 10,
            emptyOutcomes: { second: { status, reason: { code: 'in_use' } } } } });
        expect(describeStoragePileBar({ pile: null, checking: null,
            receipt: receipt?.kind === 'applied' ? { ...receipt, emptiesAt: null } : receipt })).toMatchObject({ kind: 'held', count: 1, inTrashBytes: null });
        const changed = vi.fn();
        const release = h.store.observeReceipt(key, changed);
        // Repeating the same refusal after the first item is gone changes no receipt fact.
        await h.store.emptyReceipt(key);
        expect(changed).not.toHaveBeenCalled();
        retry = true;
        await h.store.emptyReceipt(key);
        expect(h.store.getReceipt(key)).toEqual({ kind: 'emptied', count: 2, freedBytes: 30 });
        release();
    });

    it.each(['beside', 'empty'] as const)('projects a partial Put back and keeps the occupied entry actionable through %s recovery', async recovery => {
        const h = harness();
        boundary.reply.mockImplementation(async (action: string, input: { beside?: true }) => {
            if (action === 'machines.storage.trash.move') return success({ batchId: 'batch', mode: 'trash', inTrashBytes: 30, freedBytes: 0,
                trashEntryIds: ['first', 'second'], outcomes: [{ itemId: 'a', status: 'moved' }, { itemId: 'b', status: 'moved' }] });
            if (action === 'machines.storage.trash.restore') return success({ outcomes: input.beside
                ? [{ entryId: 'second', status: 'restored', path: '/second (restored)' }]
                : [{ entryId: 'first', status: 'restored', path: '/first' }, { entryId: 'second', status: 'refused', reason: { code: 'destination_occupied' } }] });
            if (action === 'machines.storage.trash.empty') return success({ outcomes: [{ entryId: 'second', status: 'deleted' }], freedBytes: 20 });
            return success(summary());
        });
        await h.store.applyPile({ ...key, mode: 'trash', items: [{ ref, expect: 'token', claimedVerdict: 'safe' }] });
        await h.store.undoReceipt(key);
        const receipt = h.store.getReceipt(key);
        expect(receipt).toMatchObject({ kind: 'applied', trash: { remaining: [{ entryId: 'second' }], restoredCount: 1,
            restoreOutcomes: { second: { status: 'refused', reason: { code: 'destination_occupied' } } } } });
        expect(describeStoragePileBar({ pile: null, checking: null,
            receipt: receipt?.kind === 'applied' ? { ...receipt, emptiesAt: null } : receipt })).toMatchObject({ kind: 'held', count: 1, inTrashBytes: null });
        if (recovery === 'beside') {
            await h.store.restoreTrashBeside({ ...key, entryId: 'second' });
            expect(h.store.getReceipt(key)).toBeNull();
            expect(h.store.getRestoreOutcomes(key).second).toMatchObject({ status: 'restored', path: '/second (restored)' });
        } else {
            await h.store.emptyReceipt(key);
            expect(h.store.getReceipt(key)).toMatchObject({ kind: 'emptied', count: 1, freedBytes: 20, restoredCount: 1 });
        }
    });

    it('reconciles category Empty against its receipt without assigning other batches freed bytes to it', async () => {
        const h = harness();
        boundary.reply.mockImplementation(async (action: string) => {
            if (action === 'machines.storage.trash.move') return success({ batchId: 'batch', mode: 'trash', inTrashBytes: 10, freedBytes: 0,
                trashEntryIds: ['own'], outcomes: [{ itemId: 'a', status: 'moved' }] });
            if (action === 'machines.storage.trash.empty') return success({ outcomes: [
                { entryId: 'own', status: 'deleted' }, { entryId: 'another-batch', status: 'deleted' }], freedBytes: 100 });
            return success(summary());
        });
        await h.store.applyPile({ ...key, mode: 'trash', items: [{ ref, expect: 'token', claimedVerdict: 'safe' }] });
        await h.store.emptyTrash(key);
        // All its entries are settled, but the wider operation's measured total is not this batch's total.
        expect(h.store.getReceipt(key)).toBeNull();
    });

    it('keeps uncorrelated legacy entries unresolved until the exact batch produces their outcomes', async () => {
        const h = harness();
        let first = true;
        boundary.reply.mockImplementation(async (action: string) => {
            if (action === 'machines.storage.trash.move') return success({ batchId: 'batch', mode: 'trash', inTrashBytes: 30, freedBytes: 0,
                outcomes: [{ itemId: 'a', status: 'moved' }, { itemId: 'b', status: 'moved' }] });
            if (action === 'machines.storage.trash.restore') return success({ outcomes: [{ entryId: first ? 'first' : 'second', status: 'restored' }] });
            return success(summary());
        });
        await h.store.applyPile({ ...key, mode: 'trash', items: [{ ref, expect: 'token', claimedVerdict: 'safe' }] });
        await h.store.undoReceipt(key);
        expect(h.store.getReceipt(key)).toMatchObject({ kind: 'applied', trash: { remaining: [], unknownCount: 1, restoredCount: 1 } });
        first = false;
        await h.store.undoReceipt(key);
        expect(h.store.getReceipt(key)).toBeNull();
    });

    it('holds one receipt per machine after a Trash move, puts that batch back on Undo and frees it on Empty now', async () => {
        const h = harness();
        const receiptChanged = vi.fn();
        const stopReceipt = h.store.observeReceipt(key, receiptChanged);
        h.store.dismissReceipt(key);
        expect(receiptChanged).not.toHaveBeenCalled();
        await h.store.read(key);
        const calls: Array<[string, unknown]> = [];
        boundary.reply.mockImplementation((action: string, input: unknown) => {
            calls.push([action, input]);
            if (action === 'machines.storage.trash.move') return Promise.resolve(success({ batchId: 'batch-1', mode: 'trash', inTrashBytes: 5, freedBytes: 0,
                outcomes: [{ itemId: 'wt-1', status: 'moved' }] }));
            if (action === 'machines.storage.trash.restore') return Promise.resolve(success({ outcomes: [{ entryId: 'e1', status: 'restored' }] }));
            if (action === 'machines.storage.trash.empty') return Promise.resolve(success({ outcomes: [{ entryId: 'e1', status: 'deleted' }], freedBytes: 5 }));
            return Promise.resolve(success(summary(calls.length + 1)));
        });
        // A mounted Storage tab holds the summary's demand; the move makes it read the machine again.
        const release = h.store.demand(key);
        await vi.waitFor(() => expect(h.watches).toHaveLength(1));
        const readsBefore = calls.filter(([action]) => action === 'machines.storage.summary.get').length;
        const moved = await h.store.applyPile({ ...key, mode: 'trash', items: [{ ref, expect: 'token', claimedVerdict: 'safe' }] });
        expect(moved.ok).toBe(true);
        expect(calls.find(([action]) => action === 'machines.storage.trash.move')?.[1]).toMatchObject({ items: [{ ref, expect: 'token', claimedVerdict: 'safe' }] });
        expect(h.store.getReceipt(key)).toMatchObject({ kind: 'applied', result: { batchId: 'batch-1' } });
        expect(h.store.getReceipt({ ...key, machineId: 'other' })).toBeNull();
        await vi.waitFor(() => expect(calls.filter(([action]) => action === 'machines.storage.summary.get').length).toBeGreaterThan(readsBefore));
        // The summary is read again so the Trash row and the disk's hatch follow the move.
        expect(calls.filter(([action]) => action === 'machines.storage.summary.get').length).toBeGreaterThan(readsBefore);

        expect((await h.store.undoReceipt(key)).ok).toBe(true);
        expect(calls.find(([action]) => action === 'machines.storage.trash.restore')?.[1]).toMatchObject({ batchId: 'batch-1' });
        expect(h.store.getReceipt(key)).toBeNull();

        await h.store.applyPile({ ...key, mode: 'trash', items: [{ ref, expect: 'token', claimedVerdict: 'safe' }] });
        expect((await h.store.emptyReceipt(key)).ok).toBe(true);
        expect(calls.filter(([action]) => action === 'machines.storage.trash.empty').at(-1)?.[1]).toMatchObject({ batchId: 'batch-1' });
        expect(h.store.getReceipt(key)).toEqual({ kind: 'emptied', count: 1, freedBytes: 5 });
        expect(receiptChanged).toHaveBeenCalledTimes(4);
        h.store.dismissReceipt(key);
        expect(h.store.getReceipt(key)).toBeNull();
        expect(receiptChanged).toHaveBeenCalledTimes(5);
        h.store.dismissReceipt(key);
        expect(receiptChanged).toHaveBeenCalledTimes(5);
        stopReceipt();
        release();
    });

    it('reads Worktrees and Suggestions lists once per filter and again when the storage revision moves', async () => {
        const h = harness();
        await h.store.read(key);
        let listRevision = 1;
        const lists: unknown[] = [];
        boundary.reply.mockImplementation((action: string, input: unknown) => {
            if (action === 'machines.storage.worktrees.list') { lists.push(input); return Promise.resolve(success({ revision: listRevision, items: [item] })); }
            return Promise.resolve(success(summary()));
        });
        const input = { ...key, list: 'worktrees' as const, filter: 'safe' as const };
        const first = h.store.demandItems(input); const second = h.store.demandItems(input);
        await vi.waitFor(() => {
            expect(h.store.getItems(input)).toMatchObject({ status: 'ready', page: { items: [item] } });
            expect(h.watches).toHaveLength(1);
        });
        expect(h.store.getItems(input)).toMatchObject({ status: 'ready', page: { items: [item] } });
        expect(lists).toHaveLength(1);
        expect(lists[0]).toMatchObject({ filter: 'safe' });
        listRevision = 2;
        h.watches[0]!.answer.resolve({ changed: true, summary: summary(2) });
        await vi.waitFor(() => expect(h.store.getItems(input).page?.revision).toBe(2));
        expect(lists).toHaveLength(2);
        expect(h.store.getItems(input).page?.revision).toBe(2);
        first(); second();
    });

    it('prepares the low-disk pile from the quickest Safe items for the named disk, through the ordinary collect Action', async () => {
        const h = harness();
        await h.store.read(key);
        const calls: Array<[string, Record<string, unknown>]> = [];
        const quickest = [
            { ...item, itemId: 'a', path: '/data/a' },
            { ...item, itemId: 'b', path: '/data/b', verdict: 'caution' as const },
            { ...item, itemId: 'c', path: '/data/c', collectable: false },
        ];
        boundary.reply.mockImplementation((action: string, input: Record<string, unknown>) => {
            calls.push([action, input]);
            if (action === 'machines.storage.suggestions.list') return Promise.resolve(success({ revision: 1, items: quickest }));
            if (action === 'machines.storage.pile.get') return Promise.resolve(success({ revision: 1, items: [], summary: summary().pile }));
            if (action === 'machines.storage.pile.set') return Promise.resolve(success({ revision: 2, items: [], summary: summary().pile }));
            return Promise.resolve(success(summary()));
        });
        expect(await h.store.prepareLowDisk({ ...key, volumeId: 'data' })).toBe(1);
        expect(calls.find(([action]) => action === 'machines.storage.suggestions.list')?.[1]).toMatchObject({ quickestForVolume: 'data' });
        const sets = calls.filter(([action]) => action === 'machines.storage.pile.set');
        expect(sets).toHaveLength(1);
        // Served references only: the machine reads identity and records who collected it (no placeholder facts).
        expect(sets[0]![1].add).toEqual([{ itemId: 'a', path: '/data/a' }]);
        boundary.reply.mockImplementation((action: string, input: Record<string, unknown>) => {
            calls.push([action, input]);
            return Promise.resolve(success(action === 'machines.storage.suggestions.list' ? { revision: 1, items: [quickest[1]] } : summary()));
        });
        expect(await h.store.prepareLowDisk({ ...key, volumeId: 'data' })).toBe(0);
        expect(calls.filter(([action]) => action === 'machines.storage.pile.set')).toHaveLength(1);
    });
});
