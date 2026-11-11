import { getDemoMachineRead } from '@/demoMode/runtime/demoMachineReadProjection';
import type { HappierStorageSummaryV1, MachineStorageCategoryListResultV1, MachineStoragePileResultV1, StorageItemRefV1, MachineStorageScanGetResultV1, DiskScanStateV1,
    MachineStorageItemsListResultV1, PileApplyResultV1, PileReviewV1, TrashEmptyResultV1, TrashRestoreResultV1 } from '@happier-dev/protocol/storage/storageV1';
import type { MachineResourcesPolicyMutationResultV1 } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import type { MachineStorageClients, MachineStorageKey, MachineStorageCategoryInput, MachineStorageRefreshInput, MachineStoragePileSetInput, MachineStorageResult, MachineStorageFailure } from './machineRpc';
import type { MachineStorageScanInput, MachineStorageScanStartInput, MachineStorageScanCancelInput, MachineStorageScanSkipInput,
    MachineStorageItemsInput, MachineStorageCheckInput, MachineStorageApplyInput, MachineStorageTrashEmptyInput, MachineStorageTrashRestoreInput, MachineStorageTrashMoveInput, MachineStorageReadInput } from './machineRpc';
import { createSharedSubscriptionStore } from '@/sync/runtime/subscriptions/sharedSubscriptionStore';
import { toStorageItemRef } from './pileRef';
import { storageVerdictStartsTicked } from './storageVerdictSelection';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createStorageTrashReceipt, isStorageTrashReceiptSettled, settleStorageTrashReceipt, type StorageTrashReceipt, type StorageTrashReceiptEffect } from './trashReceipt';
import { readStorageCategoryPages } from './readCategoryPages';
import { machineGuardStore } from '../guard/machineGuardStore';
import { retainDeep, retainKeyedRows } from '@/sync/domains/state/structuralSharing';

export type MachineStorageState = Readonly<{ status: 'loading' | 'ready' | 'error' | 'not_reported' | 'policy_unavailable'; summary: HappierStorageSummaryV1 | null; failure?: MachineStorageFailure }>;
export type MachineStorageCategoryState = Readonly<{ status: MachineStorageState['status']; page: MachineStorageCategoryListResultV1 | null; failure?: MachineStorageFailure }>;
/**
 * The pile as rows read it: the machine's own refs (identity and who collected each, daemon-resolved) plus
 * any delta still on its way, which carries only the served reference until the machine answers.
 */
export type MachineStoragePileView = Omit<MachineStoragePileResultV1, 'items'> & Readonly<{ items: readonly Readonly<StorageItemRefV1>[] }>;
export type MachineStoragePileState = Readonly<{ status: MachineStorageState['status']; page: MachineStoragePileView | null; pending: boolean; failure?: MachineStorageFailure }>;
export type MachineStorageScanState = Readonly<{ status: MachineStorageState['status']; page: MachineStorageScanGetResultV1 | null; failure?: MachineStorageFailure }>;
export type MachineStorageRestoreOutcomes = Readonly<Record<string, TrashRestoreResultV1['outcomes'][number]>>;
const EMPTY_RESTORE_OUTCOMES: MachineStorageRestoreOutcomes = Object.freeze({});
export type MachineStorageItemsState = Readonly<{ status: MachineStorageState['status']; page: MachineStorageItemsListResultV1 | null; failure?: MachineStorageFailure }>;
/** What the last review-sheet action did on this machine, kept until dismissed (the pile bar's result). */
export type MachineStorageReceipt =
    | Readonly<{ kind: 'applied'; result: PileApplyResultV1; at: number; paths: Readonly<Record<string, string>>; trash?: StorageTrashReceipt }>
    | Readonly<{ kind: 'emptied'; count: number; freedBytes: number; restoredCount?: number }>;
/**
 * Why the last whole-disk or folder scan did not start, kept per machine until the next attempt or a started scan.
 * Policy refusals are not kept here: the summary status already carries them.
 */
export type MachineStorageScanStartFailure = Readonly<Omit<MachineStorageFailure, 'ok' | 'reason'> & {
    reason: Exclude<FailureReason, 'policy_unavailable' | 'declined'>;
    target: MachineStorageScanStartInput['target'];
    resume?: true;
}>;
const EMPTY: MachineStorageState = { status: 'loading', summary: null };
const EMPTY_CATEGORY: MachineStorageCategoryState = { status: 'loading', page: null };
const EMPTY_PILE: MachineStoragePileState = { status: 'loading', page: null, pending: false };
const EMPTY_SCAN: MachineStorageScanState = { status: 'loading', page: null };
const EMPTY_ITEMS: MachineStorageItemsState = { status: 'loading', page: null };

function machineKey(input: MachineStorageKey): string { return JSON.stringify([input.serverId ?? null, input.expectedAccountId ?? null, input.machineId]); }
type CategoryReadInput = MachineStorageCategoryInput & Readonly<{ allPages?: true }>;
function categoryKey(input: CategoryReadInput): string {
    const page = [machineKey(input), input.categoryId, input.cursor ?? null];
    return JSON.stringify(input.allPages ? [...page, 'all-pages'] : page);
}
const trashInventoryInput = (input: MachineStorageKey): CategoryReadInput => ({ ...input, categoryId: 'trash', allPages: true });
function scanKey(input: MachineStorageScanInput): string { return JSON.stringify([machineKey(input), input.scanId ?? null, input.view ?? null]); }
function itemsKey(input: MachineStorageItemsInput): string {
    return JSON.stringify([machineKey(input), input.list, input.projectId ?? null, input.filter ?? null, input.group ?? null, input.quickestForVolume ?? null]);
}
function retainRows<T>(previous: T[] | undefined, incoming: T[], key: (row: T) => string): T[] {
    return retainKeyedRows(previous, incoming, key, { freeze: false }) as T[];
}
/** One observable value per machine; an equal value keeps its reference and does not notify. */
function createKeyedValue<T>() {
    const values = new Map<string, T>();
    const listeners = new Map<string, Set<() => void>>();
    return {
        get: (key: string): T | null => values.get(key) ?? null,
        set(key: string, value: T | null) {
            const previous = values.get(key) ?? null;
            if (value === null ? previous === null : sameStrictJsonValue(previous, value)) return;
            if (value === null) values.delete(key); else values.set(key, value);
            for (const listener of listeners.get(key) ?? []) listener();
        },
        observe(key: string, listener: () => void) {
            const set = listeners.get(key) ?? new Set(); set.add(listener); listeners.set(key, set);
            return () => { set.delete(listener); if (set.size === 0) listeners.delete(key); };
        },
        clear() { values.clear(); listeners.clear(); },
    };
}
function reconcileSummary(previous: HappierStorageSummaryV1 | null, incoming: HappierStorageSummaryV1): HappierStorageSummaryV1 {
    if (!previous) return incoming;
    const oldCategories = new Map(previous.categories.map(category => [category.categoryId, category]));
    const oldVolumes = new Map(previous.volumes.map(volume => [volume.volume.volumeId, volume]));
    return retainDeep(previous, {
        ...incoming,
        categories: retainDeep(previous.categories, incoming.categories.map(category => retainDeep(oldCategories.get(category.categoryId), category)!)),
        volumes: retainDeep(previous.volumes, incoming.volumes.map(volume => retainDeep(oldVolumes.get(volume.volume.volumeId), volume)!)),
        suggestionsTop: retainRows(previous.suggestionsTop, incoming.suggestionsTop, item => item.itemId),
        ...(incoming.suggestionsSafeTop === undefined ? {} : {
            suggestionsSafeTop: retainRows(previous.suggestionsSafeTop, incoming.suggestionsSafeTop, item => item.itemId),
        }),
        pile: retainDeep(previous.pile, incoming.pile), trash: retainDeep(previous.trash, incoming.trash),
        wholeDisk: retainDeep(previous.wholeDisk, { ...incoming.wholeDisk,
            scans: retainRows(previous.wholeDisk.scans, incoming.wholeDisk.scans, scan => scan.scanId),
        }),
    });
}
function reconcileCategory(previous: MachineStorageCategoryListResultV1 | null, incoming: MachineStorageCategoryListResultV1): MachineStorageCategoryListResultV1 {
    return previous ? retainDeep(previous, { ...incoming,
        items: retainRows(previous.items, incoming.items, item => item.itemId),
        ...(incoming.trashEntries === undefined ? {} : {
            trashEntries: retainRows(previous.trashEntries, incoming.trashEntries, entry => entry.entryId),
        }),
        ...(incoming.groups === undefined ? {} : { groups: retainRows(previous.groups, incoming.groups, group => group.id) }),
    }) : incoming;
}
function reconcilePile(previous: MachineStoragePileView | null, incoming: MachineStoragePileView): MachineStoragePileView {
    if (!previous) return incoming;
    const byId = new Map(previous.items.map(item => [item.itemId, item]));
    return retainDeep(previous, { ...incoming,
        items: retainDeep(previous.items, incoming.items.map(item => retainDeep(byId.get(item.itemId), item))),
        summary: retainDeep(previous.summary, incoming.summary),
    });
}
function reconcileScan(previous: MachineStorageScanGetResultV1 | null, incoming: MachineStorageScanGetResultV1): MachineStorageScanGetResultV1 {
    return previous ? retainDeep(previous, { ...incoming,
        nodes: retainRows(previous.nodes, incoming.nodes, node => node.nodeId),
        state: retainDeep(previous.state, incoming.state), coverage: retainDeep(previous.coverage, incoming.coverage),
        ...(incoming.root === undefined ? {} : { root: retainDeep(previous.root, incoming.root) }),
    }) : incoming;
}
function projectScanPageState(page: MachineStorageScanGetResultV1, scan: DiskScanStateV1): MachineStorageScanGetResultV1 {
    if (page.state?.scanId !== scan.scanId) return page;
    // A stopped target and its header receive one daemon-owned total.
    // Drilled subfolders retain their own (different) subtree totals.
    const root = page.root;
    const targetRoot = root && ('folderPath' in scan.target ? root.nodeId === scan.target.folderPath : !root.parentId);
    return { ...page, state: scan,
        ...(targetRoot && scan.status !== 'running' ? { root: { ...root,
            items: scan.progress.items, size: { ...root.size, allocatedBytes: scan.progress.sizedBytes } } } : {}) };
}
type FailureReason = Extract<MachineStorageResult<unknown>, { ok: false }>['reason'];
function failureStatus(reason: FailureReason): 'error' | 'not_reported' | 'policy_unavailable' {
    return reason === 'older_happier' ? 'not_reported' : reason === 'policy_unavailable' ? 'policy_unavailable' : 'error';
}
type Update = Readonly<{ kind: 'summary' | 'summary_overlay'; summary: HappierStorageSummaryV1 }> | Readonly<{ kind: ReturnType<typeof failureStatus>; failure?: MachineStorageFailure }>;
function failureUpdate(failure: MachineStorageFailure) {
    return { kind: failureStatus(failure.reason), ...(failure.errorCode || failure.failureCause || failure.error ? { failure } : {}) };
}

export function createMachineStorageStore(clients: MachineStorageClients) {
    const categoryDemands = new Map<string, { input: CategoryReadInput; count: number }>();
    const daemonVersions = new Map<string, number | null | undefined>();
    const pileDemands = new Map<string, { input: MachineStorageKey; count: number }>();
    const scanDemands = new Map<string, { input: MachineStorageScanInput; count: number }>();
    const itemDemands = new Map<string, { input: MachineStorageItemsInput; count: number }>();
    const receipts = createKeyedValue<MachineStorageReceipt>();
    const restoreOutcomes = createKeyedValue<MachineStorageRestoreOutcomes>();
    const scanStartFailures = createKeyedValue<MachineStorageScanStartFailure>();
    type PileWrite = { input: MachineStoragePileSetInput };
    type PileWriteQueue = { base: MachineStoragePileView; writes: PileWrite[]; tail: Promise<void> };
    const pileWrites = new Map<string, PileWriteQueue>();
    const projectPile = (input: MachineStorageKey, base: MachineStoragePileView): MachineStoragePileView => {
        const writes = pileWrites.get(machineKey(input))?.writes;
        if (!writes?.length) return base;
        let items = base.items;
        for (const { input: delta } of writes) {
            const byId = new Map<string, Readonly<StorageItemRefV1>>((delta.clear ? [] : items).map(item => [item.itemId, item]));
            for (const itemId of delta.remove ?? []) byId.delete(itemId);
            for (const ref of delta.add ?? []) byId.set(ref.itemId, ref);
            items = [...byId.values()];
        }
        // Membership is optimistic; byte reclamation remains the daemon's measured fact.
        return { ...base, items, summary: { ...base.summary, count: items.length } };
    };
    // Retained-fact overlays cannot prove that the machine's policy is readable again.
    const apply = (state: MachineStorageState, update: Update): MachineStorageState => {
        if ('summary' in update) {
            return retainDeep(state, { status: update.kind === 'summary' ? 'ready' : state.status, summary: reconcileSummary(state.summary, update.summary),
                ...(update.kind === 'summary_overlay' && state.failure ? { failure: state.failure } : {}) });
        }
        return retainDeep(state, { status: update.kind, summary: state.summary, ...(update.failure ? { failure: update.failure } : {}) });
    };
    const refreshChangedDetails = (input: MachineStorageKey, previous: MachineStorageState, incoming: HappierStorageSummaryV1) => {
        const recovered = previous.status === 'policy_unavailable'
            || (previous.summary !== null && incoming.revision < previous.summary.revision);
        for (const entry of categoryDemands.values()) if (machineKey(entry.input) === machineKey(input)) {
            const before = previous.summary?.categories.find(category => category.categoryId === entry.input.categoryId);
            const after = incoming.categories.find(category => category.categoryId === entry.input.categoryId);
            if (recovered || (before?.revision ?? previous.summary?.revision) !== (after?.revision ?? incoming.revision)) categories.invalidate(entry.input);
        }
        if (pileDemands.has(machineKey(input)) && (recovered
            || (previous.summary?.pileRevision ?? previous.summary?.revision) !== (incoming.pileRevision ?? incoming.revision))) piles.invalidate(input);
        if (recovered || previous.summary?.revision !== incoming.revision) {
            for (const entry of scanDemands.values()) if (machineKey(entry.input) === machineKey(input)) scans.invalidate(entry.input);
        }
        if (recovered || (previous.summary?.itemsRevision ?? previous.summary?.revision) !== (incoming.itemsRevision ?? incoming.revision)) {
            for (const entry of itemDemands.values()) if (machineKey(entry.input) === machineKey(input)) itemLists.invalidate(entry.input);
        }
    };
    const acceptSummary = (input: MachineStorageKey, incoming: HappierStorageSummaryV1) => {
        const previous = summaries.getState(input);
        summaries.publish(input, { kind: 'summary', summary: overlaySummary(input, incoming) });
        refreshChangedDetails(input, previous, incoming);
    };
    const overlaySummary = (input: MachineStorageKey, incoming: HappierStorageSummaryV1) => {
        for (const scan of incoming.wholeDisk.scans) if (scan.status !== 'running') publishScanState(input, scan);
        const queue = pileWrites.get(machineKey(input));
        return queue?.writes.length ? { ...incoming, pile: { ...incoming.pile,
            count: projectPile(input, queue.base).items.length } } : incoming;
    };
    const summaries = createSharedSubscriptionStore<MachineStorageKey, MachineStorageState, Update, MachineStorageClients['summaryClient'], MachineStorageClients['watchClient']>({
        emptyState: EMPTY, createState: () => EMPTY,
        normalizeInput: input => ({ ...input, serverId: input.serverId ?? null, expectedAccountId: input.expectedAccountId ?? null }),
        storeKey: machineKey, defaultSnapshotClient: clients.summaryClient, defaultWatchClient: clients.watchClient,
        retainState: true, watchAfterRefresh: true, shouldWatch: state => state.status === 'ready',
        refresh: async ({ input, state, snapshotClient, signal }): Promise<MachineStorageState> => {
            const result = await snapshotClient({ ...input, signal });
            if (signal?.aborted) return state;
            const current = summaries.getState(input);
            if (!result.ok) return apply(current, failureUpdate(result));
            // Only a newer answer received during this request can supersede it. A new daemon may
            // start its revision at zero, so retained revisions are not a connection-wide floor.
            if (current.summary !== state.summary && current.summary && result.value.revision <= current.summary.revision) return current;
            refreshChangedDetails(input, current, result.value);
            return apply(current, { kind: 'summary', summary: overlaySummary(input, result.value) });
        },
        failRefresh: state => apply(state, { kind: 'error' }), applySnapshot: apply,
        onWatchSnapshot: (input, update, previous) => {
            if (update.kind === 'summary') refreshChangedDetails(input, previous, update.summary);
        },
        watch: async ({ input, state, watchClient, signal }) => {
            const result = await watchClient({ ...input, sinceRevision: state.summary?.revision, signal });
            if (signal?.aborted) return { status: 'unavailable' };
            if (!result.ok) {
                summaries.publish(input, failureUpdate(result));
                return { status: 'unavailable' };
            }
            if (!result.value.changed) return { status: 'idle' };
            const current = summaries.getState(input);
            if (current.summary !== state.summary && current.summary && result.value.summary.revision < current.summary.revision) return { status: 'idle' };
            return { status: 'changed', snapshot: { kind: 'summary', summary: overlaySummary(input, result.value.summary) } };
        },
    });
    const categories = createSharedSubscriptionStore<CategoryReadInput, MachineStorageCategoryState, MachineStorageCategoryListResultV1, MachineStorageClients['categoryClient']>({
        emptyState: EMPTY_CATEGORY, createState: () => EMPTY_CATEGORY,
        normalizeInput: input => ({ ...input, serverId: input.serverId ?? null, expectedAccountId: input.expectedAccountId ?? null }),
        storeKey: categoryKey, defaultSnapshotClient: clients.categoryClient, retainState: true,
        refresh: async ({ input, state, snapshotClient, signal }): Promise<MachineStorageCategoryState> => {
            const { allPages, ...request } = input;
            const result = await readStorageCategoryPages({ ...request, signal }, snapshotClient, allPages === true);
            if (signal?.aborted) return state;
            const current = categories.getState(input);
            if (!result.ok) {
                const { kind: status, ...failure } = failureUpdate(result);
                return retainDeep(current, { status, page: current.page, ...failure });
            }
            if (result.value.categoryId !== input.categoryId) return retainDeep(current, { ...current, status: 'error' });
            const page = reconcileCategory(current.page, result.value);
            return retainDeep(current, { status: 'ready', page });
        },
        failRefresh: state => retainDeep(state, { status: 'error', page: state.page }),
        applySnapshot: (state, page) => retainDeep(state, { status: 'ready', page: reconcileCategory(state.page, page) }),
    });
    const demandCategoryRead = (input: CategoryReadInput, listener: () => void = () => {}) => {
        const key = categoryKey(input);
        const entry = categoryDemands.get(key) ?? { input, count: 0 };
        entry.count++;
        categoryDemands.set(key, entry);
        const releaseCategory = categories.subscribe(input, listener);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            releaseCategory();
            entry.count--;
            if (entry.count === 0 && categoryDemands.get(key) === entry) categoryDemands.delete(key);
        };
    };
    const pileClient = clients.pileClient ?? (async input => (await import('./machineRpc')).fetchMachineStoragePileViaAction(input));
    const pileSetClient = clients.pileSetClient ?? (async input => (await import('./machineRpc')).setMachineStoragePileViaAction(input));
    const piles = createSharedSubscriptionStore<MachineStorageKey, MachineStoragePileState, MachineStoragePileState, typeof pileClient>({
        emptyState: EMPTY_PILE, createState: () => EMPTY_PILE,
        normalizeInput: input => ({ ...input, serverId: input.serverId ?? null, expectedAccountId: input.expectedAccountId ?? null }),
        storeKey: machineKey, defaultSnapshotClient: pileClient, retainState: true,
        refresh: async ({ input, state, snapshotClient, signal }): Promise<MachineStoragePileState> => {
            const response = await snapshotClient({ ...input, signal });
            if (signal?.aborted) return state;
            const current = piles.getState(input);
            if (!response.ok) return retainDeep(current, { ...current, status: failureStatus(response.reason), failure: response });
            const queue = pileWrites.get(machineKey(input));
            if (queue) queue.base = response.value;
            const page = projectPile(input, response.value);
            const report = summaries.getState(input).summary;
            if (report) summaries.publish(input, { kind: 'summary_overlay', summary: { ...report, pile: page.summary } });
            return retainDeep(current, { status: 'ready', page: reconcilePile(current.page, page), pending: !!queue?.writes.length });
        },
        failRefresh: state => retainDeep(state, { ...state, status: 'error' }), applySnapshot: (_state, update) => update,
    });
    const publishPile = (input: MachineStorageKey, base: MachineStoragePileView) => {
        const page = projectPile(input, base);
        const current = piles.getState(input);
        piles.publish(input, retainDeep(current, { ...current, page: reconcilePile(current.page, page), pending: !!pileWrites.get(machineKey(input))?.writes.length }));
        const report = summaries.getState(input).summary;
        if (report) summaries.publish(input, { kind: 'summary_overlay', summary: { ...report, pile: page.summary } });
    };
    const scanClient = clients.scanClient ?? (async input => (await import('./machineRpc')).fetchMachineStorageScanViaAction(input));
    const scans = createSharedSubscriptionStore<MachineStorageScanInput, MachineStorageScanState, MachineStorageScanGetResultV1, typeof scanClient>({
        emptyState: EMPTY_SCAN, createState: () => EMPTY_SCAN, storeKey: scanKey, defaultSnapshotClient: scanClient, retainState: true,
        normalizeInput: input => ({ ...input, serverId: input.serverId ?? null, expectedAccountId: input.expectedAccountId ?? null }),
        refresh: async ({ input, state, snapshotClient, signal }): Promise<MachineStorageScanState> => {
            const response = await snapshotClient({ ...input, signal });
            if (signal?.aborted) return state;
            const current = scans.getState(input);
            const known = summaries.getState(input).summary?.wholeDisk.scans.find(scan => scan.scanId === (response.ok ? response.value.state?.scanId : undefined));
            if (response.ok && current.page?.state?.scanId === response.value.state?.scanId
                && current.page?.state?.status !== 'running' && response.value.state?.status === 'running'
                && known?.status !== 'running') return current;
            return response.ok ? retainDeep(current, { status: 'ready', page: reconcileScan(current.page,
                known && known.status !== 'running' ? projectScanPageState(response.value, known) : response.value) })
                : retainDeep(current, { ...current, status: failureStatus(response.reason), failure: response });
        },
        failRefresh: state => retainDeep(state, { ...state, status: 'error' }),
        applySnapshot: (state, page) => retainDeep(state, { ...state, page: reconcileScan(state.page, page) }),
    });
    function publishScanState(input: MachineStorageKey, scan: DiskScanStateV1): void {
        for (const entry of scanDemands.values()) {
            if (machineKey(entry.input) !== machineKey(input)) continue;
            const page = scans.getState(entry.input).page;
            if (page?.state?.scanId !== scan.scanId) continue;
            scans.publish(entry.input, projectScanPageState(page, scan));
        }
    }
    const itemsClient = clients.itemsClient ?? (async (input: MachineStorageItemsInput) => (await import('./machineRpc')).fetchMachineStorageItemsViaAction(input));
    const itemLists = createSharedSubscriptionStore<MachineStorageItemsInput, MachineStorageItemsState, MachineStorageItemsListResultV1, typeof itemsClient>({
        emptyState: EMPTY_ITEMS, createState: () => EMPTY_ITEMS, storeKey: itemsKey, defaultSnapshotClient: itemsClient, retainState: true,
        normalizeInput: input => ({ ...input, serverId: input.serverId ?? null, expectedAccountId: input.expectedAccountId ?? null }),
        refresh: async ({ input, state, snapshotClient, signal }): Promise<MachineStorageItemsState> => {
            const response = await snapshotClient({ ...input, signal });
            if (signal?.aborted) return state;
            const current = itemLists.getState(input);
            if (!response.ok) {
                const { kind: status, ...failure } = failureUpdate(response);
                return retainDeep(current, { status, page: current.page, ...failure });
            }
            const previous = new Map(current.page?.items.map(item => [item.itemId, item]));
            const page = current.page ? retainDeep(current.page, { ...response.value,
                items: retainDeep(current.page.items, response.value.items.map(item => retainDeep(previous.get(item.itemId), item)!)) }) : response.value;
            return retainDeep(current, { status: 'ready', page });
        },
        failRefresh: state => retainDeep(state, { status: 'error', page: state.page }),
        applySnapshot: (state, page) => retainDeep(state, { status: 'ready', page: retainDeep(state.page, page) }),
    });
    const setReceipt = (input: MachineStorageKey, receipt: MachineStorageReceipt | null) => receipts.set(machineKey(input), receipt);
    /** Explicit cleanup still refreshes retained pages if the summary read is unavailable. */
    const afterEffect = (input: MachineStorageKey) => {
        summaries.invalidate(input);
        for (const entry of categoryDemands.values()) if (machineKey(entry.input) === machineKey(input)) categories.invalidate(entry.input);
        for (const entry of scanDemands.values()) if (machineKey(entry.input) === machineKey(input)) scans.invalidate(entry.input);
        for (const entry of itemDemands.values()) if (machineKey(entry.input) === machineKey(input)) itemLists.invalidate(entry.input);
        piles.invalidate(input);
    };
    const reportPolicyFailure = <T>(input: MachineStorageKey, response: MachineStorageResult<T>) => {
        if (!response.ok && response.reason === 'policy_unavailable') summaries.publish(input, { kind: failureStatus(response.reason) });
    };
    async function effect<I extends MachineStorageKey, T>(input: I, invoke: (input: I) => Promise<MachineStorageResult<T>>) {
        const response = await invoke(input);
        if (response.ok) afterEffect(input);
        else reportPolicyFailure(input, response);
        return response;
    }
    const rpc = () => import('./machineRpc');
    const moveToTrash = (input: MachineStorageTrashMoveInput) => effect(input,
        clients.trashMoveClient ?? (async value => (await rpc()).moveMachineStorageToTrashViaAction(value)));
    async function setPile(input: MachineStoragePileSetInput): Promise<MachineStorageResult<MachineStoragePileResultV1>> {
        const key = machineKey(input);
        if (!piles.getState(input).page) await piles.read(input);
        const page = piles.getState(input).page;
        if (input.signal?.aborted) return { ok: false, reason: 'request_failed' };
        if (!page) {
            const status = piles.getState(input).status;
            const response: MachineStorageResult<MachineStoragePileResultV1> = { ok: false,
                reason: status === 'not_reported' ? 'older_happier' : status === 'policy_unavailable' ? 'policy_unavailable' : 'request_failed' };
            reportPolicyFailure(input, response);
            return response;
        }
        const queue: PileWriteQueue = pileWrites.get(key) ?? { base: page, writes: [], tail: Promise.resolve() };
        const write: PileWrite = { input };
        queue.writes.push(write); pileWrites.set(key, queue); publishPile(input, queue.base);
        const pending = queue.tail.then(() => pileSetClient(input));
        queue.tail = pending.then(() => {}, () => {});
        let response: MachineStorageResult<MachineStoragePileResultV1>;
        try { response = await pending; } catch { response = { ok: false, reason: 'request_failed' }; }
        if (pileWrites.get(key) !== queue) return response;
        queue.writes.splice(queue.writes.indexOf(write), 1);
        if (response.ok) queue.base = response.value;
        publishPile(input, queue.base);
        if (!queue.writes.length) pileWrites.delete(key);
        if (!response.ok && response.reason === 'policy_unavailable') {
            piles.publish(input, retainDeep(piles.getState(input), { ...piles.getState(input), status: failureStatus(response.reason) }));
            reportPolicyFailure(input, response);
        } else summaries.invalidate(input);
        return response;
    }
    const restoreTrash = async (input: MachineStorageTrashRestoreInput): Promise<MachineStorageResult<TrashRestoreResultV1>> => {
        const response = await effect(input, clients.trashRestoreClient ?? (async value => (await rpc()).restoreMachineStorageTrashViaAction(value)));
        if (!response.ok) return response;
        const key = machineKey(input);
        const next = { ...restoreOutcomes.get(key), ...Object.fromEntries(response.value.outcomes.map(outcome => [outcome.entryId, outcome])) };
        restoreOutcomes.set(key, next);
        settleReceipt(input, { kind: 'restore', result: response.value });
        if (response.value.outcomes.some(outcome => outcome.status === 'restored')) machineGuardStore.refreshMachine({
            machineId: input.machineId, serverId: input.serverId ?? null, expectedAccountId: input.expectedAccountId ?? null,
        });
        return response;
    };
    const emptyTrash = async (input: MachineStorageTrashEmptyInput): Promise<MachineStorageResult<TrashEmptyResultV1>> => {
        const response = await effect(input, clients.trashEmptyClient ?? (async value => (await rpc()).emptyMachineStorageTrashViaAction(value)));
        if (response.ok) {
            settleReceipt(input, { kind: 'empty', result: response.value });
            if (response.value.outcomes.some(outcome => outcome.status === 'deleted')) machineGuardStore.refreshMachine({
                machineId: input.machineId, serverId: input.serverId ?? null, expectedAccountId: input.expectedAccountId ?? null,
            });
        }
        return response;
    };
    function settleReceipt(input: MachineStorageKey & Readonly<{ batchId?: string }>, effect: StorageTrashReceiptEffect) {
        const receipt = receipts.get(machineKey(input));
        if (receipt?.kind !== 'applied' || receipt.result.mode !== 'trash') return;
        let trash = receipt.trash ?? createStorageTrashReceipt(receipt.result);
        // Older apply replies omit entry ids. Only an exact batch read can identify those unknown entries.
        if (trash.unknownCount > 0 && input.batchId === receipt.result.batchId) {
            const known = new Set([...trash.remaining.map(entry => entry.entryId),
                ...Object.keys(trash.restoreOutcomes ?? {}), ...Object.keys(trash.emptyOutcomes ?? {})]);
            const identified = [...new Set(effect.result.outcomes.map(outcome => outcome.entryId))].filter(id => !known.has(id));
            trash = { ...trash, remaining: [...trash.remaining, ...identified.map(entryId => ({ entryId }))],
                unknownCount: Math.max(0, trash.unknownCount - identified.length) };
        }
        const next = settleStorageTrashReceipt(trash, effect);
        if (isStorageTrashReceiptSettled(next)) {
            setReceipt(input, next.deletedCount > 0 && next.freedBytesKnown !== false
                ? { kind: 'emptied', count: next.deletedCount, freedBytes: next.freedBytes,
                    ...(next.restoredCount > 0 ? { restoredCount: next.restoredCount } : {}) } : null);
        } else if (next !== receipt.trash) setReceipt(input, { ...receipt, trash: next });
    }
    async function scanEffect<I extends MachineStorageKey>(input: I, invoke: (input: I) => Promise<MachineStorageResult<DiskScanStateV1>>) {
        const response = await invoke(input);
        if (response.ok) {
            // The Action answer is already an authorized scan state. Do not make the mounted view
            // wait for the next summary/watch round trip to discover the scan it just started.
            summaries.invalidate(input);
            publishScanState(input, response.value);
            const summary = summaries.getState(input).summary;
            if (summary) summaries.publish(input, { kind: 'summary_overlay', summary: { ...summary,
                wholeDisk: { ...summary.wholeDisk, scans: [...summary.wholeDisk.scans.filter(scan => scan.scanId !== response.value.scanId), response.value] } } });
            for (const entry of scanDemands.values()) if (machineKey(entry.input) === machineKey(input)) scans.invalidate(entry.input);
        }
        else reportPolicyFailure(input, response);
        return response;
    }
    return {
        getState: (input: MachineStorageKey) => getDemoMachineRead(input)?.storage ?? summaries.getState(input), observe: summaries.observe, getCategory: categories.getState, observeCategory: categories.observe,
        demand(input: MachineStorageKey, listener: () => void = () => {}) { return summaries.subscribe(input, listener); },
        demandCategory(input: MachineStorageCategoryInput, listener: () => void = () => {}) {
            const releaseSummary = summaries.subscribe(input, () => {});
            const releaseCategory = demandCategoryRead(input, listener);
            return () => { releaseCategory(); releaseSummary(); };
        },
        read: summaries.read, readCategory: categories.read,
        getTrashInventory: (input: MachineStorageKey) => categories.getState(trashInventoryInput(input)),
        observeTrashInventory: (input: MachineStorageKey, listener: () => void) => categories.observe(trashInventoryInput(input), listener),
        isTrashInventoryRefreshing: (input: MachineStorageKey) => categories.isRefreshing(trashInventoryInput(input)),
        observeTrashInventoryRefreshing: (input: MachineStorageKey, listener: () => void) => categories.observeRefreshing(trashInventoryInput(input), listener),
        demandTrashInventory: (input: MachineStorageKey) => demandCategoryRead(trashInventoryInput(input)),
        readTrashInventoryOnce: (input: MachineStorageKey) => categories.readOnce(trashInventoryInput(input)),
        retryTrashInventory: (input: MachineStorageKey) => categories.read(trashInventoryInput(input)),
        getScan: scans.getState, observeScan: scans.observe, readScan: scans.read,
        demandScan(input: MachineStorageScanInput, listener: () => void = () => {}) {
            const key = scanKey(input);
            const entry = scanDemands.get(key) ?? { input, count: 0 }; entry.count++; scanDemands.set(key, entry);
            const releaseSummary = summaries.subscribe(input, () => {});
            const releaseScan = scans.subscribe(input, listener);
            let active = true;
            return () => { if (!active) return; active = false; releaseScan(); releaseSummary();
                if (--entry.count === 0) scanDemands.delete(key); };
        },
        retryScan(input: MachineStorageScanInput) { scans.invalidate(input); summaries.invalidate(input); },
        async startScan(input: MachineStorageScanStartInput) {
            const key = machineKey(input);
            scanStartFailures.set(key, null);
            const response = await scanEffect(input, clients.scanStartClient
                ?? (async value => (await import('./machineRpc')).startMachineStorageScanViaAction(value)));
            if (!response.ok && response.reason !== 'policy_unavailable' && response.reason !== 'declined') {
                const { ok: _ok, ...failure } = response;
                scanStartFailures.set(key, { ...failure, reason: response.reason, target: input.target, ...(input.resume ? { resume: true as const } : {}) });
            }
            return response;
        },
        cancelScan(input: MachineStorageScanCancelInput) { return scanEffect(input, clients.scanCancelClient
            ?? (async value => (await import('./machineRpc')).cancelMachineStorageScanViaAction(value))); },
        skipScan(input: MachineStorageScanSkipInput) { return scanEffect(input, clients.scanSkipClient
            ?? (async value => (await import('./machineRpc')).skipMachineStorageScanPathViaAction(value))); },
        getPile: piles.getState, observePile: piles.observe, readPile: piles.read,
        demandPile(input: MachineStorageKey, listener: () => void = () => {}) {
            const key = machineKey(input);
            const entry = pileDemands.get(key) ?? { input, count: 0 }; entry.count += 1; pileDemands.set(key, entry);
            const releaseSummary = summaries.subscribe(input, () => {});
            const releasePile = piles.subscribe(input, listener);
            let active = true;
            return () => { if (!active) return; active = false; releaseSummary(); releasePile();
                entry.count -= 1; if (entry.count === 0) pileDemands.delete(key); };
        },
        setPile,
        getItems: itemLists.getState, observeItems: itemLists.observe,
        demandItems(input: MachineStorageItemsInput, listener: () => void = () => {}) {
            const key = itemsKey(input);
            const entry = itemDemands.get(key) ?? { input, count: 0 }; entry.count++; itemDemands.set(key, entry);
            const releaseSummary = summaries.subscribe(input, () => {});
            const releaseItems = itemLists.subscribe(input, listener);
            let active = true;
            return () => { if (!active) return; active = false; releaseItems(); releaseSummary();
                if (--entry.count === 0) itemDemands.delete(key); };
        },
        retryItems(input: MachineStorageItemsInput) { itemLists.invalidate(input); summaries.invalidate(input); },
        /** The review sheet's fresh check of the pile on the machine (`machines.storage.items.check`). */
        async checkPile(input: MachineStorageCheckInput): Promise<MachineStorageResult<PileReviewV1>> {
            // Served references only: the machine re-reads identity itself (the pile's own refs carry more).
            const response = await (clients.checkClient ?? (async value => (await rpc()).checkMachineStorageItemsViaAction(value)))({ ...input, refs: input.refs.map(toStorageItemRef) });
            reportPolicyFailure(input, response);
            return response;
        },
        /** Move to Trash or Delete now, exactly the reviewed items the person kept ticked; the result is the machine's receipt. */
        async applyPile(input: MachineStorageApplyInput): Promise<MachineStorageResult<PileApplyResultV1>> {
            // Review selects exact operands and is the person's one confirmation of a permanent delete; Action settings still win.
            const { mode, items, ...rest } = input;
            const response = mode === 'trash'
                ? await moveToTrash({ ...rest, items: items.map(item => ({ ...item, claimedVerdict: item.claimedVerdict ?? 'safe' })) })
                : await (clients.deleteNowClient ?? (async value => (await rpc()).deleteMachineStorageNowViaAction(value)))({ ...rest, reviewedByPerson: true, items: items.map(item => ({ ref: item.ref, expect: item.expect })) });
            if (response.ok) { setReceipt(input, { kind: 'applied', result: response.value, at: Date.now(), paths: Object.fromEntries(items.map(item => [item.ref.itemId, item.ref.path])),
                ...(response.value.mode === 'trash' ? { trash: createStorageTrashReceipt(response.value) } : {}) }); if (mode === 'delete') afterEffect(input); }
            else reportPolicyFailure(input, response);
            return response;
        },
        /**
         * The low-disk moment's preparation (STO-23), run from the person's tap on "Free up space": the
         * quickest items the machine verified for that disk, Safe and collectable, go in the pile through
         * the ordinary `pile.set`. Returns how many were added.
         */
        async prepareLowDisk(input: MachineStorageKey & Readonly<{ volumeId: string }>): Promise<number> {
            const { volumeId, ...target } = input;
            const listed = await itemsClient({ ...target, list: 'suggestions', quickestForVolume: volumeId });
            if (!listed.ok) { reportPolicyFailure(input, listed); return 0; }
            const add = listed.value.items.filter(item => storageVerdictStartsTicked(item.verdict) && item.collectable).map(toStorageItemRef);
            if (add.length === 0) return 0;
            const result = await setPile({ ...target, add });
            return result.ok ? add.length : 0;
        },
        getReceipt(input: MachineStorageKey): MachineStorageReceipt | null { return receipts.get(machineKey(input)); },
        observeReceipt(input: MachineStorageKey, listener: () => void) { return receipts.observe(machineKey(input), listener); },
        getRestoreOutcomes(input: MachineStorageKey): MachineStorageRestoreOutcomes { return restoreOutcomes.get(machineKey(input)) ?? EMPTY_RESTORE_OUTCOMES; },
        observeRestoreOutcomes(input: MachineStorageKey, listener: () => void) { return restoreOutcomes.observe(machineKey(input), listener); },
        restoreTrashBeside(input: MachineStorageKey & Readonly<{ entryId: string }>): Promise<MachineStorageResult<TrashRestoreResultV1>> {
            const outcome = restoreOutcomes.get(machineKey(input))?.[input.entryId];
            if (outcome?.status !== 'refused' || outcome.reason?.code !== 'destination_occupied') return Promise.resolve({ ok: false, reason: 'request_failed' });
            const { entryId, ...scope } = input;
            return restoreTrash({ ...scope, entryIds: [entryId], beside: true });
        },
        getScanStartFailure(input: MachineStorageKey): MachineStorageScanStartFailure | null { return scanStartFailures.get(machineKey(input)); },
        observeScanStartFailure(input: MachineStorageKey, listener: () => void) { return scanStartFailures.observe(machineKey(input), listener); },
        dismissReceipt(input: MachineStorageKey) { setReceipt(input, null); },
        /** Undo on the result: Put back that batch. */
        async undoReceipt(input: MachineStorageKey): Promise<MachineStorageResult<TrashRestoreResultV1>> {
            const receipt = receipts.get(machineKey(input));
            if (receipt?.kind !== 'applied' || receipt.result.mode !== 'trash') return { ok: false, reason: 'request_failed' };
            const response = await restoreTrash({ ...input, batchId: receipt.result.batchId });
            return response;
        },
        /** Empty now on the result: delete that batch from the Trash; the space is back. */
        async emptyReceipt(input: MachineStorageReadInput): Promise<MachineStorageResult<TrashEmptyResultV1>> {
            const receipt = receipts.get(machineKey(input));
            if (receipt?.kind !== 'applied' || receipt.result.mode !== 'trash') return { ok: false, reason: 'request_failed' };
            return emptyTrash({ ...input, batchId: receipt.result.batchId });
        },
        moveToTrash, restoreTrash, emptyTrash,
        /** Protected folders are the machine's resources policy; the policy store re-reads the metadata, storage re-reads its tiers. */
        setProtectedFolder(input: MachineStorageKey & Readonly<{ path: string; protect: boolean }>): Promise<MachineStorageResult<MachineResourcesPolicyMutationResultV1>> {
            const { protect, ...rest } = input;
            return effect(rest, async value => protect ? (await rpc()).addMachineStorageProtectedFolderViaAction(value) : (await rpc()).removeMachineStorageProtectedFolderViaAction(value));
        },
        retry(input: MachineStorageKey) { summaries.invalidate(input); },
        retryCategory(input: MachineStorageCategoryInput) { categories.invalidate(input); summaries.invalidate(input); },
        async sizeAgain(input: MachineStorageRefreshInput): Promise<MachineStorageState> {
            const previous = summaries.getState(input).summary;
            const result = await clients.refreshClient(input);
            if (!input.signal?.aborted) {
                const current = summaries.getState(input).summary;
                if (result.ok) {
                    if (!(current !== previous && current && result.value.revision < current.revision)) acceptSummary(input, result.value);
                } else summaries.publish(input, failureUpdate(result));
            }
            return summaries.getState(input);
        },
        daemonStateChanged(input: MachineStorageKey, version: number | null | undefined) {
            const key = machineKey(input);
            if (daemonVersions.has(key) && daemonVersions.get(key) === version) return;
            daemonVersions.set(key, version);
            const status = summaries.getState(input).status;
            if (status === 'not_reported' || status === 'error' || status === 'policy_unavailable') summaries.invalidate(input);
            for (const entry of categoryDemands.values()) if (machineKey(entry.input) === key && categories.getState(entry.input).status !== 'ready') categories.invalidate(entry.input);
            for (const entry of scanDemands.values()) if (machineKey(entry.input) === key && scans.getState(entry.input).status !== 'ready') scans.invalidate(entry.input);
        },
        reset() { summaries.reset(); categories.reset(); piles.reset(); scans.reset(); itemLists.reset(); categoryDemands.clear(); pileDemands.clear(); scanDemands.clear(); itemDemands.clear(); pileWrites.clear(); daemonVersions.clear(); receipts.clear(); restoreOutcomes.clear(); scanStartFailures.clear(); },
    };
}

export type MachineStorageStore = ReturnType<typeof createMachineStorageStore>;
export const machineStorageStore = createMachineStorageStore({
    summaryClient: async input => (await import('./machineRpc')).fetchMachineStorageSummaryViaAction(input),
    categoryClient: async input => (await import('./machineRpc')).fetchMachineStorageCategoryViaAction(input),
    refreshClient: async input => (await import('./machineRpc')).refreshMachineStorageSizeViaAction(input),
    watchClient: async input => (await import('./machineRpc')).watchMachineStorageViaMachineRpc(input),
});
