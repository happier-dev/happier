import type { MachineVitalsSnapshotV1, MachineVitalsWatchResultV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import type { MachineVitalsHistoryV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';
import type { MachineVitalsHostFactsV1, MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { appendMachineVitalsSeriesV1, projectMachineVitalsSeriesV1, projectMachineResourceSummaryV1, type MachineResourceSummaryV1, type MachineResourceAttentionV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@happier-dev/protocol/rpcErrors';
import { projectMachineDaemonRpcFailure, type MachineDaemonRpcFailure } from '../machineDaemonRpcErrors';

import { createSharedSubscriptionStore, type SharedSubscriptionWatchOutcome } from '@/sync/runtime/subscriptions/sharedSubscriptionStore';
import { subscribeMachineRpcRecovery } from '@/sync/runtime/orchestration/serverScopedRpc/subscribeMachineRpcRecovery';
import { isMachineResourceStateStale } from './machineResourceAvailability';
export { isMachineResourceStateStale } from './machineResourceAvailability';
import type {
    MachineResourceKey, MachineVitalsView, MachineVitalsRange, MachineResourceRpcResult,
    MachineVitalsReadInput, MachineVitalsHistoryReadInput, MachineVitalsWatchInput,
} from './machineRpc';
import { retainDeep } from '@/sync/domains/state/structuralSharing';

export type MachineResourceState = Readonly<{
    status: 'loading' | 'ready' | 'slow' | 'error' | 'not_reported';
    snapshot: MachineVitalsSnapshotV1 | null;
    summary: MachineResourceSummaryV1 | null;
    /** Already-published static facts, scoped like the held samples; never a second read. */
    host?: MachineVitalsHostFactsV1;
    /** Cadence-derived freshness last observed at a read/watch answer; no client clock loop. */
    stale: boolean;
    samples: readonly MachineVitalsSampleV1[];
    /** The admitted Action/RPC refusal, retained without replacing its stable state category. */
    errorCode?: string;
    failure?: MachineDaemonRpcFailure;
}>;
export type MachineResourceStoreInput = MachineResourceKey & Readonly<{ view: MachineVitalsView }>;
export type MachineResourceHistoryState = Readonly<{ status: MachineResourceState['status']; history: MachineVitalsHistoryV1 | null; errorCode?: string; failure?: MachineDaemonRpcFailure }>;
export type MachineResourceClients = Readonly<{
    snapshotClient: (input: MachineVitalsReadInput) => Promise<MachineResourceRpcResult<MachineVitalsSnapshotV1>>;
    watchClient: (input: MachineVitalsWatchInput) => Promise<MachineResourceRpcResult<MachineVitalsWatchResultV1>>;
    historyClient: (input: MachineVitalsHistoryReadInput) => Promise<MachineResourceRpcResult<MachineVitalsHistoryV1>>;
}>;

export const EMPTY_MACHINE_RESOURCE_STATE: MachineResourceState = { status: 'loading', snapshot: null, summary: null, stale: false, samples: [] };
export const EMPTY_MACHINE_RESOURCE_HISTORY_STATE: MachineResourceHistoryState = { status: 'loading', history: null };
const NOT_REPORTED_STATE: MachineResourceState = { ...EMPTY_MACHINE_RESOURCE_STATE, status: 'not_reported' };
const NOT_REPORTED_HISTORY_STATE: MachineResourceHistoryState = { ...EMPTY_MACHINE_RESOURCE_HISTORY_STATE, status: 'not_reported' };

type ResourceUpdate =
    | Readonly<{ kind: 'snapshot'; snapshot: MachineVitalsSnapshotV1 }>
    | Readonly<{ kind: 'samples'; samples: readonly MachineVitalsSampleV1[]; retainDetails?: boolean }>
    | Readonly<{ kind: 'published_attention'; attention: MachineResourceAttentionV1 }>
    | Readonly<{ kind: 'published_host'; host: MachineVitalsHostFactsV1 | undefined }>
    | Readonly<{ kind: 'freshness' }>
    | Readonly<{ kind: 'slow' | 'error' | 'not_reported'; errorCode?: string; failure?: MachineDaemonRpcFailure }>;
type HistoryInput = Omit<MachineVitalsHistoryReadInput, 'signal'>;

function machineKey(input: MachineResourceKey): string { return JSON.stringify([input.serverId ?? null, input.expectedAccountId ?? null, input.machineId]); }
function historyKey(input: HistoryInput): string { return JSON.stringify([machineKey(input), input.serviceId ?? null, input.range]); }
/** Children have already been reconciled; a changed live tail must never be deep-walked here. */
function retainState<T extends object>(previous: T, next: T): T {
    const keys = Object.keys(next) as (keyof T)[];
    return keys.every(key => previous[key] === next[key])
        && (Object.keys(previous) as (keyof T)[]).every(key => previous[key] === next[key]) ? previous : next;
}

function retainSample(previous: MachineVitalsSampleV1 | null, next: MachineVitalsSampleV1, retainDetails = false): MachineVitalsSampleV1 {
    if (!previous) return next;
    if (retainDetails) next = {
        ...previous, ...next,
        ...(previous.limits?.inotify && !next.limits?.inotify
            ? { limits: { ...next.limits, inotify: previous.limits.inotify } } : {}),
    };
    return retainDeep(previous, {
        ...next,
        cpu: retainDeep(previous.cpu, next.cpu),
        memory: retainDeep(previous.memory, next.memory),
        disk: retainDeep(previous.disk, next.disk),
        network: retainDeep(previous.network, next.network),
    });
}

function retainSeries(previous: MachineVitalsSnapshotV1['series5m'] | undefined, next: MachineVitalsSnapshotV1['series5m'], sampledAt: number): MachineVitalsSnapshotV1['series5m'] {
    const projected = projectMachineVitalsSeriesV1(next, sampledAt);
    const points = (old: typeof next.cpu, incoming: typeof next.cpu) => {
        const byTime = new Map(old.map(point => [point.t, point]));
        return retainDeep(old, incoming.map(point => {
            const existing = byTime.get(point.t);
            return existing && existing.y === point.y ? existing : point;
        }));
    };
    const series = {
        cpu: points(previous?.cpu ?? [], projected.cpu), memory: points(previous?.memory ?? [], projected.memory),
        networkRx: points(previous?.networkRx ?? [], projected.networkRx), networkTx: points(previous?.networkTx ?? [], projected.networkTx),
    };
    return previous ? retainDeep(previous, series) : series;
}

function appendSamples(previous: readonly MachineVitalsSampleV1[], incoming: readonly MachineVitalsSampleV1[]): readonly MachineVitalsSampleV1[] {
    let result = previous;
    for (const sample of incoming) {
        if (sample === result.at(-1)) continue;
        // The Overview's longest live range is one hour; older data comes from range reads.
        result = [...result.filter(point => point.sampledAt >= sample.sampledAt - 3_600_000), sample];
    }
    return result;
}

function applySnapshot(state: MachineResourceState, incoming: MachineVitalsSnapshotV1, now: number, retainDetails = false): MachineResourceState {
    const previous = state.snapshot;
    if (incoming.state === 'unavailable' && !incoming.sample && previous?.sample) {
        incoming = { ...incoming, sample: previous.sample, series5m: previous.series5m,
            ...(previous.attention && !incoming.attention ? { attention: previous.attention } : {}) };
    }
    const sample = incoming.sample ? retainSample(previous?.sample ?? null, incoming.sample, retainDetails) : null;
    const series5m = sample ? retainSeries(previous?.series5m, incoming.series5m, sample.sampledAt) : incoming.series5m;
    const snapshot = previous ? retainState(previous, {
        ...incoming, sample,
        series5m,
        ...(incoming.attention ? { attention: retainDeep(previous.attention, incoming.attention) } : {}),
    }) : { ...incoming, sample, series5m };
    const projected = projectMachineResourceSummaryV1(snapshot, state.host);
    const summary = state.summary && projected ? retainDeep(state.summary, {
        ...projected,
        // Missing samples stay gaps in history; the figure keeps the last measurement.
        cpu: retainDeep(state.summary.cpu, { ...projected.cpu, busyPct: projected.cpu.busyPct ?? state.summary.cpu.busyPct }),
        memory: retainDeep(state.summary.memory, { ...projected.memory, series: retainDeep(state.summary.memory.series, projected.memory.series) }),
        disk: retainDeep(state.summary.disk, projected.disk), network: retainDeep(state.summary.network, projected.network),
    }) : projected;
    const next: MachineResourceState = { status: 'ready', snapshot, summary, host: state.host, stale: false, samples: sample ? appendSamples(state.samples, [sample]) : state.samples };
    return retainState(state, { ...next, stale: isMachineResourceStateStale(next, now) });
}

function applyUpdate(state: MachineResourceState, update: ResourceUpdate, now: number): MachineResourceState {
    if (update.kind === 'snapshot') return applySnapshot(state, update.snapshot, now);
    if (update.kind === 'published_host') {
        const host = retainDeep(state.host, update.host);
        if (host === state.host) return state;
        const withHost = { ...state, host };
        if (!state.snapshot) return withHost;
        const reprojected = applySnapshot(withHost, state.snapshot, now);
        return { ...reprojected, status: state.status, ...(state.errorCode ? { errorCode: state.errorCode } : {}), ...(state.failure ? { failure: state.failure } : {}) };
    }
    if (update.kind === 'freshness') {
        const stale = isMachineResourceStateStale(state, now);
        if (state.status === 'slow' || state.status === 'error') {
            const { errorCode: _previousErrorCode, failure: _previousFailure, ...retained } = state;
            return { ...retained, status: 'ready', stale };
        }
        return state.stale === stale ? state : { ...state, stale };
    }
    if (update.kind === 'published_attention') {
        if (!state.snapshot) return state;
        const attention = retainDeep(state.snapshot.attention, update.attention);
        if (attention === state.snapshot.attention) return state;
        const reprojected = applySnapshot(state, { ...state.snapshot, attention }, now);
        return { ...reprojected, status: state.status, ...(state.errorCode ? { errorCode: state.errorCode } : {}), ...(state.failure ? { failure: state.failure } : {}) };
    }
    if (update.kind !== 'samples') {
        const { errorCode: _previousErrorCode, failure: _previousFailure, ...retained } = state;
        return retainState(state, { ...(update.kind === 'not_reported' ? NOT_REPORTED_STATE : retained), status: update.kind,
            stale: update.kind === 'not_reported' ? false : isMachineResourceStateStale(state, now),
            ...(update.errorCode ? { errorCode: update.errorCode } : {}), ...(update.failure ? { failure: retainDeep(state.failure, update.failure) } : {}) });
    }
    if (!state.snapshot) return state;
    let result = state;
    for (const incoming of update.samples) {
        const previous = result.snapshot!;
        // Memory is one reader-owned observation, including its optional composition.
        // Only independent extras can outlive another view's newer sample.
        const sample = retainSample(previous.sample, incoming, update.retainDetails);
        if (sample.sampledAt === previous.sample?.sampledAt) {
            result = applySnapshot(result, { ...previous, state: 'reporting', reason: undefined, sample }, now);
            continue;
        }
        result = applySnapshot(result, {
            ...previous, state: 'reporting', reason: undefined, sample,
            series5m: appendMachineVitalsSeriesV1(previous.series5m, previous.sample, [sample]),
        }, now);
    }
    return result;
}

export function createMachineResourceStore(clients: MachineResourceClients, nowMs: () => number = Date.now) {
    const unsupported = new Set<string>();
    const daemonVersions = new Map<string, number | null | undefined>();
    // One static publication per Machine, including before observation begins.
    const publishedHosts = new Map<string, MachineVitalsHostFactsV1>();
    // These are live consumer/read demands, never retained snapshots or a second transport owner.
    const views = new Map<string, { summary: number; overview: number }>();
    const serviceHistoryDemands = new Map<string, Map<string, { input: HistoryInput; count: number }>>();
    function invalidateHistories(input: MachineResourceKey) {
        for (const range of ['1h', '24h', '7d'] as const) histories.invalidate({ ...input, range });
        for (const demand of serviceHistoryDemands.get(machineKey(input))?.values() ?? []) histories.invalidate(demand.input);
    }
    const strongestView = (counts: { overview: number }): MachineVitalsView => counts.overview > 0 ? 'overview' : 'summary';
    function acquireView(input: MachineResourceStoreInput): () => void {
        const key = machineKey(input);
        const previous = views.get(key);
        const counts = previous ?? { summary: 0, overview: 0 };
        const before = previous ? strongestView(previous) : undefined;
        counts[input.view]++;
        views.set(key, counts);
        const selected = strongestView(counts);
        if (before !== selected) store.reconfigure({ ...input, view: selected });
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (views.get(key) !== counts) return;
            const before = strongestView(counts);
            counts[input.view]--;
            if (counts.summary === 0 && counts.overview === 0) { views.delete(key); return; }
            const selected = strongestView(counts);
            if (before !== selected) store.reconfigure({ ...input, view: selected });
        };
    }
    const markUnsupported = (input: MachineResourceKey, failure: MachineDaemonRpcFailure) => {
        unsupported.add(machineKey(input));
        store.publish({ ...input, view: 'summary' }, { kind: 'not_reported', failure, errorCode: failure.errorCode });
    };
    const store = createSharedSubscriptionStore<
        MachineResourceStoreInput, MachineResourceState, ResourceUpdate,
        MachineResourceClients['snapshotClient'], MachineResourceClients['watchClient']
    >({
        emptyState: EMPTY_MACHINE_RESOURCE_STATE, createState: () => EMPTY_MACHINE_RESOURCE_STATE,
        normalizeInput: input => ({ ...input, serverId: input.serverId ?? null }),
        storeKey: machineKey,
        defaultSnapshotClient: clients.snapshotClient, defaultWatchClient: clients.watchClient,
        retainState: true, watchAfterRefresh: true,
        subscribeRecovery: subscribeMachineRpcRecovery,
        shouldWatch: state => !state.failure?.recovery && (state.status === 'ready' || state.status === 'slow'
            || (state.status === 'error' && state.errorCode === MACHINE_RPC_TIMEOUT_ERROR_CODE)) && state.snapshot?.state === 'reporting',
        refresh: async ({ input, state, snapshotClient, signal }): Promise<MachineResourceState> => {
            if (unsupported.has(machineKey(input))) return retainState(state, { ...state, status: 'not_reported' });
            if (!daemonVersions.has(machineKey(input)) && input.daemonStateVersion !== undefined) daemonVersions.set(machineKey(input), input.daemonStateVersion);
            const result = await snapshotClient({ ...input, signal });
            if (signal?.aborted) return state;
            const held = getHeldState(input);
            const host = publishedHosts.get(machineKey(input));
            const current = held.host === host ? held : { ...held, host };
            if (result.ok) {
                // A push accepted while this read was in flight owns the newer
                // observation. Wall timestamps cannot order replies after a clock step.
                if (current.snapshot?.sample !== state.snapshot?.sample) return current;
                return applySnapshot(current, result.value, nowMs(), input.view === 'summary');
            }
            if (result.reason === 'older_happier') markUnsupported(input, result);
            return applyUpdate(current, { kind: result.reason === 'older_happier' ? 'not_reported' : 'error',
                failure: result, ...(result.errorCode ? { errorCode: result.errorCode } : {}) }, nowMs());
        },
        failRefresh: (_state, input) => applyUpdate(getHeldState(input), { kind: 'error' }, nowMs()),
        applySnapshot: (state, update) => applyUpdate(state, update, nowMs()),
        onWatchSnapshot: (input, update, previous) => {
            if (update.kind !== 'samples') return;
            const previousAt = previous.snapshot?.sample?.sampledAt ?? 0;
            const newestAt = update.samples.reduce((latest, sample) => Math.max(latest, sample.sampledAt), previousAt);
            if (input.view === 'overview' && Math.floor(newestAt / 60_000) > Math.floor(previousAt / 60_000)) {
                // History buckets and today totals are daemon-owned; only demanded ranges refresh.
                invalidateHistories(input);
            }
        },
        watch: ({ input, state, watchClient, signal }) => {
            let markDispatched!: () => void;
            const dispatched = new Promise<void>(resolve => { markDispatched = resolve; });
            const outcome = (async (): Promise<SharedSubscriptionWatchOutcome<ResourceUpdate>> => {
                if (unsupported.has(machineKey(input))) return { status: 'unavailable' };
                const result = await watchClient({ ...input,
                    ...(state.snapshot?.sample ? { sinceSampledAt: state.snapshot.sample.sampledAt } : {}), signal, onDispatched: markDispatched })
                    .catch(projectMachineDaemonRpcFailure);
                if (signal?.aborted) return { status: 'unavailable' };
                if (!result.ok) {
                    if (result.reason === 'older_happier') {
                        markUnsupported(input, result);
                        return { status: 'unavailable' };
                    }
                    const current = getHeldState(input);
                    const kind = current.status === 'slow' || current.status === 'error' ? 'error' : 'slow';
                    const update: ResourceUpdate = { kind, failure: result, ...('errorCode' in result && result.errorCode ? { errorCode: result.errorCode } : {}) };
                    // The state predicate owns re-arming: deadlines keep their existing
                    // transport cadence, other failures await recovery or explicit Retry.
                    // A failed reply is not a successful publication/recovery wake.
                    return { status: 'changed', snapshot: update };
                }
                return { status: 'changed', snapshot: result.value.changed
                    ? { kind: 'samples', samples: result.value.samples, retainDetails: input.view === 'summary' } : { kind: 'freshness' } };
            })();
            // Failure/cancellation before dispatch must also release publication; the existing
            // transport deadline and demand lifecycle remain the recovery boundaries.
            void outcome.then(markDispatched, markDispatched);
            return { dispatched, outcome };
        },
    });
    const histories = createSharedSubscriptionStore<HistoryInput, MachineResourceHistoryState, MachineVitalsHistoryV1, MachineResourceClients['historyClient']>({
        emptyState: EMPTY_MACHINE_RESOURCE_HISTORY_STATE, createState: () => EMPTY_MACHINE_RESOURCE_HISTORY_STATE,
        normalizeInput: input => ({ ...input, serverId: input.serverId ?? null }),
        storeKey: historyKey,
        defaultSnapshotClient: clients.historyClient, retainState: true,
        refresh: async ({ input, state, snapshotClient, signal }) => {
            if (unsupported.has(machineKey(input))) return state.status === 'not_reported' ? state : NOT_REPORTED_HISTORY_STATE;
            if (!daemonVersions.has(machineKey(input)) && input.daemonStateVersion !== undefined) daemonVersions.set(machineKey(input), input.daemonStateVersion);
            const result = await snapshotClient({ ...input, signal });
            if (signal?.aborted) return state;
            if (result.ok) return retainState(state, { status: 'ready', history: retainDeep(state.history, result.value) });
            if (result.reason === 'older_happier') markUnsupported(input, result);
            const { errorCode: _previousErrorCode, failure: _previousFailure, ...retained } = state;
            return retainState(state, { ...(result.reason === 'older_happier' ? NOT_REPORTED_HISTORY_STATE : retained), status: result.reason === 'older_happier' ? 'not_reported' : 'error',
                failure: retainDeep(state.failure, result), ...(result.errorCode ? { errorCode: result.errorCode } : {}) });
        },
        failRefresh: state => {
            const { errorCode: _previousErrorCode, failure: _previousFailure, ...retained } = state;
            return retainState(state, { ...retained, status: 'error' });
        },
        applySnapshot: (state, history) => retainState(state, { status: 'ready', history: retainDeep(state.history, history) }),
    });
    function getHeldState(input: MachineResourceStoreInput): MachineResourceState {
        return store.getState(input);
    }
    async function readForView(input: MachineResourceStoreInput, retry = false): Promise<void> {
        const release = acquireView(input);
        try {
            if (retry) store.invalidate(input);
            await store.read(input, { nowMs });
        } finally { release(); }
    }
    return {
        getState: getHeldState,
        isRefreshing: store.isRefreshing,
        observeRefreshing: store.observeRefreshing,
        observe: store.observe,
        setPublishedAttention(input: MachineResourceKey, attention: MachineResourceAttentionV1) {
            store.publish({ ...input, view: 'summary' }, { kind: 'published_attention', attention });
        },
        setPublishedHost(input: MachineResourceKey, host: MachineVitalsHostFactsV1 | undefined) {
            const key = machineKey(input);
            const previous = publishedHosts.get(key);
            const next = retainDeep(previous, host);
            if (next === previous) return;
            if (next) publishedHosts.set(key, next);
            else publishedHosts.delete(key);
            store.publish({ ...input, view: 'summary' }, { kind: 'published_host', host: next });
        },
        demand(input: MachineResourceStoreInput, listener: () => void = () => {}) {
            const releaseView = acquireView(input);
            const release = store.subscribe(input, listener, { nowMs });
            return () => { release(); releaseView(); };
        },
        read(input: MachineResourceStoreInput) { return readForView(input); },
        retry(input: MachineResourceStoreInput) { return readForView(input, true); },
        getHistory(input: HistoryInput): MachineResourceHistoryState {
            const state = histories.getState(input);
            return unsupported.has(machineKey(input)) && state.status !== 'not_reported' ? NOT_REPORTED_HISTORY_STATE : state;
        },
        observeHistory: histories.observe,
        demandHistory(input: HistoryInput, listener: () => void = () => {}) {
            const release = histories.subscribe(input, listener, { nowMs });
            if (input.serviceId === undefined) return release;
            const machine = machineKey(input);
            const demands = serviceHistoryDemands.get(machine) ?? new Map<string, { input: HistoryInput; count: number }>();
            serviceHistoryDemands.set(machine, demands);
            const key = historyKey(input);
            const demand = demands.get(key) ?? { input, count: 0 };
            demand.count++;
            demands.set(key, demand);
            let released = false;
            return () => {
                if (released) return;
                released = true;
                release();
                if (--demand.count > 0) return;
                demands.delete(key);
                if (demands.size === 0 && serviceHistoryDemands.get(machine) === demands) serviceHistoryDemands.delete(machine);
            };
        },
        readHistory(input: HistoryInput) { return histories.read(input, { nowMs }); },
        retryHistory(input: HistoryInput) { histories.invalidate(input); return histories.read(input, { nowMs }); },
        daemonStateChanged(input: MachineResourceKey, version: number | null | undefined) {
            // A reader that does not know the daemon version (a meter's demand keyed by Machine alone) reports
            // nothing: an absent version is not a change, so it never makes the next real report look like one.
            if (version === undefined) return;
            const key = machineKey(input);
            if (daemonVersions.has(key) && daemonVersions.get(key) === version) return;
            daemonVersions.set(key, version);
            const wasUnsupported = unsupported.delete(key);
            const state = store.getState({ ...input, view: 'summary' });
            if (wasUnsupported || state.status === 'error' || state.stale || state.snapshot?.state === 'unavailable') {
                store.invalidate({ ...input, view: 'summary' });
            }
            if (wasUnsupported) {
                invalidateHistories(input);
            }
        },
        reset() { store.reset(); histories.reset(); unsupported.clear(); daemonVersions.clear(); publishedHosts.clear(); views.clear(); serviceHistoryDemands.clear(); },
    };
}

export type MachineResourceStore = ReturnType<typeof createMachineResourceStore>;
export const machineResourceStore = createMachineResourceStore({
    snapshotClient: async input => (await import('./machineRpc')).fetchMachineVitalsViaMachineRpc(input),
    watchClient: async input => (await import('./machineRpc')).watchMachineVitalsViaMachineRpc(input),
    historyClient: async input => (await import('./machineRpc')).fetchMachineVitalsHistoryViaMachineRpc(input),
});
