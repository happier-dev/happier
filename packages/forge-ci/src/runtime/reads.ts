import type { ForgeCiActionInputByOperationV1, ForgeCiActionResultByOperationV1, ForgeCiJobRefV1, ForgeCiLogV1, ForgeCiRunRefV1, ForgeCiStepV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import type { ForgeCiAdapterV1 } from './adapter.js';
import { projectForgeCiBranchCountsV1, type ForgeCiBranchCountsProjectionV1, type ForgeCiBranchCountsV1 } from './statePresentation.js';
import { forgeCiJobKeyV1, forgeCiRunKeyV1 } from './identity.js';
import { buildForgeCiLogIndexV1, type ForgeCiLogIndexV1 } from './logs/index.js';
import { mergeForgeCiLogPagesV1 } from './logs/page.js';
import { createForgeCiPagedReadV1, type ForgeCiPagedReadLeaseV1, type ForgeCiPagedReadOperationV1 } from './paging.js';

export type ForgeCiReadOperationV1 = 'listWorkflows' | 'readWorkflow' | 'listRuns' | 'readRun' | 'listJobs' | 'readJob' | 'readJobLog' | 'listArtifacts' | 'listAnnotations' | 'readTrigger' | 'listEnvironments' | 'listDeployments' | 'readDeploymentHistory' | 'readFailureContext';
type Value<T> = T extends Readonly<{ kind: 'value'; value: infer V }> ? V : never;
export type ForgeCiReadValueV1<K extends ForgeCiReadOperationV1> = Value<ForgeCiActionResultByOperationV1[K]>;
export type ForgeCiReadSnapshotV1<K extends ForgeCiReadOperationV1> = Readonly<{
    value: ForgeCiReadValueV1<K> | null; pending: boolean; failure: TriageSourceFailureV1 | null; checkedAtMs: number | null; retired: boolean;
}>;
export type ForgeCiReadDemandV1 = Readonly<{
    active?: boolean;
    liveness?: 'detail' | 'branchCounts';
    /** This borrower's current transport within the controller's admitted authority. */
    adapter?: ForgeCiAdapterV1;
    /** Existing renderer lifetime; cancellation releases this borrower's demand. */
    signal?: AbortSignal;
}>;
export type ForgeCiReadLeaseV1<K extends ForgeCiReadOperationV1> = Readonly<{
    getValue(): ForgeCiReadValueV1<K> | null;
    subscribeValue(listener: () => void): () => void;
    getSnapshot(): ForgeCiReadSnapshotV1<K>;
    subscribe(listener: () => void): () => void;
    refresh(): Promise<void>;
    setActive(active: boolean): void;
    release(): void;
}>;
export type ForgeCiReadsV1 = Readonly<{
    acquire<K extends ForgeCiReadOperationV1>(operation: K, input: ForgeCiActionInputByOperationV1[K], demand?: ForgeCiReadDemandV1): ForgeCiReadLeaseV1<K>;
    acquirePaged<K extends ForgeCiPagedReadOperationV1>(operation: K, input: ForgeCiActionInputByOperationV1[K], demand?: ForgeCiReadDemandV1): ForgeCiPagedReadLeaseV1<K>;
    acquireBranchCounts(input: ForgeCiActionInputByOperationV1['listRuns'], demand?: Omit<ForgeCiReadDemandV1, 'liveness'>): Omit<ForgeCiReadLeaseV1<'listRuns'>, 'getValue'> & Readonly<{ getValue(): ForgeCiBranchCountsV1 }>;
    indexLog(input: Readonly<{ log: ForgeCiLogV1 | null; steps?: readonly ForgeCiStepV1[]; source?: ForgeCiLogV1 }>): ForgeCiLogIndexV1 | null;
    /** Existing exact-job evidence only; ambiguous log identities and retired authority are unavailable. */
    getLogIndex(job: ForgeCiJobRefV1): ForgeCiLogIndexV1 | null;
    invalidate<K extends ForgeCiReadOperationV1>(operation?: K, input?: ForgeCiActionInputByOperationV1[K]): void;
    retire(): void;
}>;

const record = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value);
// This encodes small exact query operands and native refs, never response windows.
function queryKey(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(queryKey).join(',')}]`;
    if (record(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${queryKey(value[key])}`).join(',')}}`;
    return JSON.stringify(value) ?? 'undefined';
}
export function forgeCiReadQueryKeyV1<K extends ForgeCiReadOperationV1>(operation: K, input: ForgeCiActionInputByOperationV1[K]): string {
    const { validator: _validator, ...query } = input as Readonly<Record<string, unknown>>;
    return `${operation}:${queryKey(query)}`;
}
function entityKey(value: unknown): string | null {
    if (!record(value)) return null;
    if (record(value.ref) && typeof value.ref.jobId === 'string') return `job:${forgeCiJobKeyV1(value.ref as ForgeCiJobRefV1)}`;
    if (record(value.ref) && typeof value.ref.runId === 'string') return `run:${forgeCiRunKeyV1(value.ref as ForgeCiRunRefV1)}`;
    if (record(value.ref)) return `ref:${queryKey(value.ref)}`;
    if (typeof value.id === 'string') return `id:${value.id}`;
    // Native input names identify trigger definitions, not CI jobs or steps.
    if (typeof value.name === 'string' && typeof value.type === 'string') return `input:${value.name}`;
    return null;
}

/** Reconcile admitted fields while constructing the next producer value. */
function reconcile(previous: unknown, incoming: unknown): unknown {
    if (previous === incoming) return previous;
    if (Array.isArray(incoming)) {
        if (!Array.isArray(previous)) return incoming;
        const keyed = new Map(previous.flatMap(value => { const key = entityKey(value); return key === null ? [] : [[key, value] as const]; }));
        let unchanged = previous.length === incoming.length;
        const next = incoming.map((value, index) => {
            const key = entityKey(value);
            const result = reconcile(key === null ? previous[index] : keyed.get(key), value);
            if (result !== previous[index]) unchanged = false;
            return result;
        });
        return unchanged ? previous : next;
    }
    if (!record(previous) || !record(incoming)) return incoming;
    const keys = Object.keys(incoming);
    let unchanged = keys.length === Object.keys(previous).length;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
        result[key] = reconcile(previous[key], incoming[key]);
        if (result[key] !== previous[key]) unchanged = false;
    }
    return unchanged ? previous : result;
}

/** Policy for the incumbent paged-panel reducer; paging ownership stays there. */
export function reconcileForgeCiRowsV1<T>(previous: readonly T[], incoming: readonly T[], { replacing, observedRows }: Readonly<{ replacing: boolean; observedRows?: readonly T[] }>): readonly T[] {
    if (observedRows !== undefined) {
        // The walk's baseline holds the latest admitted entity facts. Only the
        // page that changed may replace them; retained peer pages supply order.
        const latest = new Map(previous.flatMap(value => { const key = entityKey(value); return key === null ? [] : [[key, value] as const]; }));
        for (const row of observedRows) {
            const key = entityKey(row);
            if (key !== null) latest.set(key, reconcile(latest.get(key), row) as T);
        }
        const seen = new Set<string>();
        const rows: T[] = [];
        for (const row of incoming) {
            const key = entityKey(row);
            if (key !== null) {
                if (seen.has(key)) continue;
                seen.add(key);
            }
            rows.push(key === null ? row : latest.get(key) ?? row);
        }
        return rows.length === previous.length && rows.every((row, index) => row === previous[index]) ? previous : rows;
    }
    const rows = reconcile(previous, incoming) as readonly T[];
    return replacing ? rows : incoming.length === 0 ? previous : [...previous, ...rows];
}

type Envelope = Readonly<{ kind: 'value'; value: unknown; validator?: string }> | Readonly<{ kind: 'notModified'; validator?: string }> | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>;
type Snapshot = Readonly<{ value: unknown; pending: boolean; failure: TriageSourceFailureV1 | null; checkedAtMs: number | null; retired: boolean }>;
type Demand = { active: boolean; liveness: 'detail' | 'branchCounts'; adapter: ForgeCiAdapterV1 };
type Entry = {
    operation: ForgeCiReadOperationV1; input: Readonly<Record<string, unknown>>; snapshot: Snapshot; validator: string | undefined;
    demands: Set<Demand>; semantic: Set<() => void>; presentation: Set<() => void>;
    counts: ForgeCiBranchCountsProjectionV1; countListeners: Set<() => void>;
    abort: AbortController | undefined; request: Promise<void> | undefined; timer: ReturnType<typeof setTimeout> | undefined;
    transport: Demand | undefined;
};
type IndexedLog = Readonly<{ index: ForgeCiLogIndexV1; lastObservation: Extract<ForgeCiLogV1, { kind: 'available' }>; source: ForgeCiLogV1 }>;
function phaseEligible(value: unknown, badge: boolean): boolean {
    if (!record(value)) return false;
    if (Array.isArray(value.rows)) return value.rows.some(row => phaseEligible(row, badge));
    if (!record(value.state)) return false;
    return value.state.phase === 'queued' || value.state.phase === 'running' || (badge && value.state.phase === 'waiting');
}

export function createForgeCiReadsV1({ adapter, scopeKey }: Readonly<{ adapter: ForgeCiAdapterV1; scopeKey: string }>): ForgeCiReadsV1 {
    const entries = new Map<string, Entry>();
    const logIndexes = new Map<string, Map<string, IndexedLog>>();
    let retired = false;
    let authorityFailure: TriageSourceFailureV1 | null = null;
    const active = (entry: Entry) => !retired && authorityFailure === null && [...entry.demands].some(demand => demand.active);
    const transport = (entry: Entry) => [...entry.demands].find(demand => demand.active);
    const retainedImmutableLog = (entry: Entry) => entry.operation === 'readJobLog'
        && entry.snapshot.failure === null && record(entry.snapshot.value) && entry.snapshot.value.kind === 'available';
    const retractJobIndexes = (job: ForgeCiJobRefV1) => { logIndexes.delete(forgeCiJobKeyV1(job)); };
    const publish = (entry: Entry, snapshot: Snapshot) => {
        const changed = entry.snapshot.value !== snapshot.value;
        if (changed && entry.operation === 'readJobLog') {
            const previous = entry.snapshot.value as ForgeCiLogV1 | null;
            const incoming = snapshot.value as ForgeCiLogV1 | null;
            if (previous?.kind === 'available' && incoming?.kind === 'available'
                && previous.logId === incoming.logId && forgeCiJobKeyV1(previous.job) === forgeCiJobKeyV1(incoming.job)) {
                const identities = logIndexes.get(forgeCiJobKeyV1(previous.job));
                const indexed = identities?.get(previous.logId);
                if (identities && indexed?.source === previous) {
                    // Replace only an already-indexed source at actual admission.
                    // Readers keep a truthful prefix while an exact tail is pending.
                    const index = buildForgeCiLogIndexV1({ log: incoming, baseline: indexed.index, steps: indexed.index.steps });
                    identities.set(incoming.logId, { index, lastObservation: incoming, source: incoming });
                }
            }
        }
        const previousCounts = entry.counts;
        if (entry.operation === 'listRuns' && changed) entry.counts = projectForgeCiBranchCountsV1(entry.counts, snapshot.value as ForgeCiReadValueV1<'listRuns'> | null);
        entry.snapshot = snapshot;
        if (changed) for (const listener of entry.semantic) listener();
        if (previousCounts.value !== entry.counts.value) for (const listener of entry.countListeners) listener();
        for (const listener of entry.presentation) listener();
    };
    const stop = (entry: Entry) => {
        clearTimeout(entry.timer); entry.timer = undefined;
        entry.abort?.abort(); entry.abort = undefined;
        entry.request = undefined;
        entry.transport = undefined;
        if (entry.snapshot.pending) publish(entry, { ...entry.snapshot, pending: false });
    };
    const retractPeerLogBodies = (source: Entry, log: Exclude<ForgeCiLogV1, { kind: 'available' }>) => {
        const jobKey = forgeCiJobKeyV1(log.job);
        for (const peer of entries.values()) {
            if (peer === source || peer.operation !== 'readJobLog' || peer.snapshot.value === null) continue;
            const previous = peer.snapshot.value as ForgeCiLogV1;
            if (forgeCiJobKeyV1(previous.job) !== jobKey) continue;
            stop(peer);
            publish(peer, { ...peer.snapshot, value: log, pending: false, failure: null, checkedAtMs: Date.now() });
        }
    };
    const schedule = (entry: Entry) => {
        clearTimeout(entry.timer); entry.timer = undefined;
        if (!active(entry) || entry.snapshot.pending) return;
        const badge = [...entry.demands].some(demand => demand.active && demand.liveness === 'branchCounts');
        const detailOperation = ['listRuns', 'readRun', 'listJobs', 'readJob'].includes(entry.operation);
        if (!detailOperation || !phaseEligible(entry.snapshot.value, badge)) return;
        const failure = entry.snapshot.failure;
        if (failure && (failure.class !== 'rateLimit' || failure.retryNotBeforeMs === undefined)) return;
        // Provider backoff delays this query's existing active-demand timer. No
        // failure creates liveness, and a missing retry deadline stays manual.
        const retryDelay = (failure?.retryNotBeforeMs ?? 0) - Date.now();
        const delay = retryDelay > 0 ? retryDelay : transport(entry)!.adapter.activeRunPollIntervalMs;
        entry.timer = setTimeout(() => { entry.timer = undefined; void refresh(entry); }, delay);
    };
    function refresh(entry: Entry): Promise<void> {
        if (!active(entry)) return Promise.resolve();
        if (entry.request) return entry.request;
        if ((entry.snapshot.failure?.retryNotBeforeMs ?? 0) > Date.now()) {
            schedule(entry);
            return Promise.resolve();
        }
        clearTimeout(entry.timer); entry.timer = undefined;
        const abort = new AbortController(); entry.abort = abort;
        const borrower = transport(entry)!; entry.transport = borrower;
        publish(entry, { ...entry.snapshot, pending: true, failure: null });
        const invoke = borrower.adapter[entry.operation] as (input: unknown, options: Readonly<{ signal: AbortSignal }>) => Promise<Envelope>;
        const perform = async () => {
            try {
                let response = await invoke({ ...entry.input, ...(entry.validator === undefined ? {} : { validator: entry.validator }) }, { signal: abort.signal });
                if (abort.signal.aborted || retired) return;
                if (response.kind === 'notModified' && entry.snapshot.value === null) {
                    response = await invoke(entry.input, { signal: abort.signal });
                    if (abort.signal.aborted || retired) return;
                }
                // Native work is settled before result listeners may release its
                // borrower. Only a genuinely in-flight transport needs handoff.
                entry.transport = undefined;
                if (response.kind === 'value') {
                    entry.validator = response.validator;
                    if (entry.operation === 'readJobLog') {
                        const log = response.value as ForgeCiLogV1;
                        if (log.kind !== 'available') { retractJobIndexes(log.job); retractPeerLogBodies(entry, log); }
                    }
                    publish(entry, { value: reconcile(entry.snapshot.value, response.value), pending: false, failure: null, checkedAtMs: Date.now(), retired: false });
                } else if (response.kind === 'notModified' && entry.snapshot.value !== null) {
                    entry.validator = response.validator ?? entry.validator;
                    publish(entry, { ...entry.snapshot, pending: false, failure: null, checkedAtMs: Date.now() });
                } else {
                    const failure = response.kind === 'unavailable' ? response.failure : { class: 'unsupportedContract' as const, code: 'conditional_body_unavailable' };
                    if (failure.class === 'authentication') {
                        // Park future demand; already admitted peer work and its
                        // retained facts belong to their own request lifetime.
                        authorityFailure = failure;
                        for (const peer of entries.values()) {
                            clearTimeout(peer.timer); peer.timer = undefined;
                        }
                        publish(entry, { ...entry.snapshot, pending: false, failure });
                    } else publish(entry, { ...entry.snapshot, pending: false, failure });
                }
            } catch {
                if (!abort.signal.aborted && !retired) {
                    entry.transport = undefined;
                    publish(entry, { ...entry.snapshot, pending: false, failure: { class: 'transient', code: 'ci_read_failed' } });
                }
            }
        };
        const request = perform().finally(() => {
            if (entry.abort !== abort) return;
            if (entry.request === request) entry.request = undefined;
            entry.abort = undefined;
            entry.transport = undefined;
            schedule(entry);
        });
        entry.request = request;
        return request;
    }
    function acquireExact<K extends ForgeCiReadOperationV1>(operation: K, input: ForgeCiActionInputByOperationV1[K], options: ForgeCiReadDemandV1 = {}): ForgeCiReadLeaseV1<K> {
        const { validator: _validator, ...query } = input as Readonly<Record<string, unknown>>;
        const key = `${scopeKey}:${operation}:${queryKey(query)}`;
        let entry = entries.get(key);
        if (!entry) {
            entry = { operation, input: query, snapshot: { value: null, pending: false, failure: authorityFailure, checkedAtMs: null, retired }, demands: new Set(), semantic: new Set(), presentation: new Set(), counts: projectForgeCiBranchCountsV1(null, null), countListeners: new Set(), validator: undefined, abort: undefined, request: undefined, timer: undefined, transport: undefined };
            entries.set(key, entry);
        }
        const owned = entry;
        const wasActive = active(owned);
        const demand = { active: options.active !== false && options.signal?.aborted !== true, liveness: options.liveness ?? 'detail', adapter: options.adapter ?? adapter };
        owned.demands.add(demand);
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            options.signal?.removeEventListener('abort', release);
            owned.demands.delete(demand);
            if (!active(owned)) stop(owned);
            else if (owned.transport === demand) { stop(owned); void refresh(owned); }
            else schedule(owned);
        };
        options.signal?.addEventListener('abort', release, { once: true });
        if (options.signal?.aborted) release();
        if (!retired && demand.active && !wasActive && !retainedImmutableLog(owned)) void refresh(owned);
        else if (demand.active && owned.timer === undefined && !owned.snapshot.pending) schedule(owned);
        return {
            getValue: () => owned.snapshot.value as ForgeCiReadValueV1<K> | null,
            getSnapshot: () => owned.snapshot as ForgeCiReadSnapshotV1<K>,
            subscribeValue: listener => { owned.semantic.add(listener); return () => owned.semantic.delete(listener); },
            subscribe: listener => { owned.presentation.add(listener); return () => owned.presentation.delete(listener); },
            refresh: () => released ? Promise.resolve() : refresh(owned),
            setActive(next) {
                if (released || retired || next === demand.active) return;
                demand.active = next;
                if (!active(owned)) stop(owned);
                else if (!next && owned.transport === demand) { stop(owned); void refresh(owned); }
                else if (next && !retainedImmutableLog(owned)) void refresh(owned);
                else schedule(owned);
            },
            release,
        };
    }
    function completeLog(log: ForgeCiLogV1 | null): Extract<ForgeCiLogV1, { kind: 'available' }> | null {
        if (log?.kind !== 'available') return null;
        const retained = logIndexes.get(forgeCiJobKeyV1(log.job))?.get(log.logId);
        // An indexed replacement supersedes an older exact entry's proof, even
        // when that entry once held a complete native tail for this same log id.
        if (retained !== undefined && retained.source !== log) return null;
        if ('text' in log && log.complete && log.continuation === null && log.startByte === 0 && log.startLine === 1) return log;
        // The walk admitted this exact first observation. Equal responses keep
        // its reconciled identity; changed cursors cannot borrow the old suffix.
        return retained?.source === log && retained.index.complete && retained.index.continuation === null ? retained.index.log : null;
    }
    const controller: ForgeCiReadsV1 = {
        acquirePaged(operation, input, demand = {}) {
            return createForgeCiPagedReadV1(controller, operation, input, demand, reconcileForgeCiRowsV1);
        },
        acquire(operation, input, options = {}) {
            if (operation === 'readJobLog' && !retired) {
                const logInput = input as ForgeCiActionInputByOperationV1['readJobLog'];
                if (logInput.selection.kind === 'tail' && logInput.cursor === undefined) {
                    for (const candidate of entries.values()) {
                        if (candidate.operation !== 'readJobLog' || candidate.input.cursor !== undefined
                            || queryKey(candidate.input.repository) !== queryKey(logInput.repository)
                            || candidate.input.runId !== logInput.runId || candidate.input.jobId !== logInput.jobId
                            || candidate.input.attempt !== logInput.attempt) continue;
                        const log = candidate.snapshot.value as ForgeCiLogV1 | null;
                        const covered = completeLog(log);
                        if (candidate.snapshot.failure !== null || covered === null) continue;
                        let source = acquireExact('readJobLog', candidate.input as ForgeCiActionInputByOperationV1['readJobLog'], options);
                        let projecting = true;
                        let active = options.active !== false;
                        let handbackNeedsRefresh = false;
                        let snapshot = { ...source.getSnapshot(), value: covered as ForgeCiLogV1 | null };
                        const semantic = new Set<() => void>();
                        const presentation = new Set<() => void>();
                        let unsubscribe: () => void = () => {};
                        const refreshHandback = () => {
                            if (!active || !handbackNeedsRefresh) return;
                            handbackNeedsRefresh = false;
                            void source.refresh();
                        };
                        const update = () => {
                            let value = source.getValue();
                            if (projecting && value?.kind === 'available') {
                                const complete = completeLog(value);
                                if (complete !== null) value = complete;
                                else {
                                    const exact = entries.get(`${scopeKey}:${forgeCiReadQueryKeyV1('readJobLog', logInput)}`);
                                    projecting = false;
                                    if (exact !== candidate) {
                                        // Changed source bytes no longer prove a retained
                                        // exact tail body. Retract only that invalid body;
                                        // preserve its request, failure and provider backoff.
                                        if (exact && (exact.snapshot.value as ForgeCiLogV1 | null)?.kind === 'available') {
                                            exact.validator = undefined;
                                            publish(exact, { ...exact.snapshot, value: null });
                                            void refresh(exact);
                                        }
                                        unsubscribe(); source.release();
                                        source = acquireExact('readJobLog', logInput, { ...options, active });
                                        unsubscribe = source.subscribe(update);
                                        handbackNeedsRefresh = true;
                                        refreshHandback();
                                        value = source.getValue();
                                    }
                                }
                            }
                            const changed = snapshot.value !== value;
                            snapshot = { ...source.getSnapshot(), value };
                            if (changed) for (const listener of semantic) listener();
                            for (const listener of presentation) listener();
                        };
                        unsubscribe = source.subscribe(update);
                        // The complete canonical index covers the requested tail.
                        // Borrow its source lifetime instead of creating another query.
                        return {
                            getValue: () => snapshot.value, getSnapshot: () => snapshot,
                            subscribeValue: (listener: () => void) => { semantic.add(listener); return () => semantic.delete(listener); },
                            subscribe: (listener: () => void) => { presentation.add(listener); return () => presentation.delete(listener); },
                            refresh: () => source.refresh(),
                            setActive: (next: boolean) => { active = next; source.setActive(next); refreshHandback(); },
                            release: () => { active = false; handbackNeedsRefresh = false; unsubscribe(); semantic.clear(); presentation.clear(); source.release(); },
                        } as ForgeCiReadLeaseV1<typeof operation>;
                    }
                }
            }
            if (operation === 'readJob' && !retired) {
                const jobInput = input as ForgeCiActionInputByOperationV1['readJob'];
                for (const candidate of entries.values()) {
                    if (candidate.operation !== 'listJobs' || queryKey(candidate.input.repository) !== queryKey(jobInput.repository)) continue;
                    const page = candidate.snapshot.value as ForgeCiReadValueV1<'listJobs'> | null;
                    if (!page?.rows.some(row => row.ref.jobId === jobInput.jobId)) continue;
                    const source = controller.acquire('listJobs', candidate.input as ForgeCiActionInputByOperationV1['listJobs'], options);
                    const selected = () => source.getValue()?.rows.find(row => row.ref.jobId === jobInput.jobId) ?? null;
                    let snapshot = { ...source.getSnapshot(), value: selected() };
                    const semantic = new Set<() => void>();
                    const presentation = new Set<() => void>();
                    const unsubscribe = source.subscribe(() => {
                        const value = selected();
                        const changed = snapshot.value !== value;
                        snapshot = { ...source.getSnapshot(), value };
                        if (changed) for (const listener of semantic) listener();
                        for (const listener of presentation) listener();
                    });
                    // This typed projection borrows the jobs-list producer, including
                    // its activity, refresh and cancellation. It has no job poller.
                    return {
                        getValue: () => snapshot.value,
                        getSnapshot: () => snapshot,
                        subscribeValue: (listener: () => void) => { semantic.add(listener); return () => semantic.delete(listener); },
                        subscribe: (listener: () => void) => { presentation.add(listener); return () => presentation.delete(listener); },
                        refresh: source.refresh, setActive: source.setActive,
                        release: () => { unsubscribe(); semantic.clear(); presentation.clear(); source.release(); },
                    } as ForgeCiReadLeaseV1<typeof operation>;
                }
            }
            return acquireExact(operation, input, options);
        },
        acquireBranchCounts(input, options) {
            const lease = controller.acquire('listRuns', input, { ...options, liveness: 'branchCounts' });
            const { validator: _validator, ...query } = input;
            const entry = entries.get(`${scopeKey}:listRuns:${queryKey(query)}`)!;
            return { ...lease, getValue: () => entry.counts.value, subscribeValue: listener => { entry.countListeners.add(listener); return () => entry.countListeners.delete(listener); } };
        },
        indexLog({ log, steps, source }) {
            if (retired || log === null) return null;
            if (log.kind !== 'available') { retractJobIndexes(log.job); return null; }
            const key = forgeCiJobKeyV1(log.job);
            const identities = logIndexes.get(key) ?? new Map<string, IndexedLog>();
            const retained = identities.get(log.logId);
            const baseline = retained?.index;
            const canonical = baseline?.log === log || source === log && retained?.source === log
                && baseline?.complete === true && baseline.continuation === null;
            // A changed first observation carries new opaque source provenance,
            // even when its visible prefix bytes match the completed old walk.
            const changedSource = source !== undefined && retained !== undefined && source !== retained.source && !canonical;
            let admitted = log;
            if (!changedSource && baseline && (retained?.lastObservation === log || canonical)) admitted = baseline.log;
            else if (!changedSource && baseline) {
                const merged = mergeForgeCiLogPagesV1({ previous: baseline.log, page: log });
                if (merged.kind === 'value' && merged.value.kind === 'available') admitted = merged.value;
                else if (merged.kind === 'unavailable' && merged.failure.code !== 'log_page_content_mismatch') {
                    identities.delete(log.logId);
                    if (identities.size === 0) logIndexes.delete(key);
                    return null;
                }
                // Conflicting source bytes replace the old observation. The index
                // builder can still retain equal lines, but no old ranges are merged.
            }
            const index = buildForgeCiLogIndexV1({ log: admitted, ...(steps === undefined ? {} : { steps }), ...(baseline === undefined ? {} : { baseline }) });
            identities.set(log.logId, { index, lastObservation: canonical && retained ? retained.lastObservation : log,
                source: canonical && retained ? retained.source : source ?? retained?.source ?? log });
            logIndexes.set(key, identities);
            return index;
        },
        getLogIndex(job) {
            if (retired) return null;
            const identities = logIndexes.get(forgeCiJobKeyV1(job));
            return identities?.size === 1 ? identities.values().next().value?.index ?? null : null;
        },
        invalidate(operation, input) {
            if (operation === undefined || operation === 'readJobLog') {
                const target = input as ForgeCiActionInputByOperationV1['readJobLog'] | undefined;
                const matches = (logInput: Readonly<Record<string, unknown>>) => target === undefined
                    || queryKey(logInput.repository) === queryKey(target.repository)
                        && logInput.runId === target.runId && logInput.jobId === target.jobId
                        && (target.attempt === undefined || logInput.attempt === target.attempt);
                for (const [key, identities] of logIndexes) {
                    const index = identities.values().next().value?.index;
                    if (!index) continue;
                    const selection = index.job.selection;
                    const run = selection.kind === 'run' ? selection.run : selection.attempt.run;
                    if (matches({ repository: run.repository, runId: run.runId, jobId: index.job.jobId,
                        ...(selection.kind === 'attempt' ? { attempt: selection.attempt.attemptId } : {}) })) logIndexes.delete(key);
                }
                for (const entry of entries.values()) if (entry.operation === 'readJobLog' && matches(entry.input)) {
                    stop(entry);
                    publish(entry, { ...entry.snapshot, value: null, failure: null });
                    void refresh(entry);
                }
                if (operation === 'readJobLog') return;
            }
            if (operation !== undefined && input !== undefined) {
                const entry = entries.get(`${scopeKey}:${forgeCiReadQueryKeyV1(operation, input)}`);
                if (entry) void refresh(entry);
                return;
            }
            for (const entry of entries.values()) if (operation === undefined || entry.operation === operation) void refresh(entry);
        },
        retire() {
            if (retired) return;
            retired = true;
            for (const entry of entries.values()) {
                stop(entry); entry.validator = undefined;
                publish(entry, { value: null, pending: false, failure: null, checkedAtMs: null, retired: true });
            }
            entries.clear();
            logIndexes.clear();
        },
    };
    return controller;
}
