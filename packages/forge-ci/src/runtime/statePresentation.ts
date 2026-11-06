import type { PluginDynamicResourceInvocationOptionsV1, PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import type { ForgeCiActionInputByOperationV1, ForgeCiRunV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { TriagePagedPanelPageV1 } from '@happier-dev/triage-protocol/v1';
import type { ForgeCiReadsV1 } from './reads.js';
import { forgeCiRunKeyV1 } from './identity.js';

export type ForgeCiBranchCountsV1 = Readonly<{ running: number | null; failed: number | null }>;
export type ForgeCiBranchCountsProjectionV1 = Readonly<{
    value: ForgeCiBranchCountsV1;
    coverage: Readonly<{ running: boolean; failed: boolean }>;
    /** Internal producer baseline; never serialized into the count Resource. */
    population: CountBaseline;
}>;
type RunPage = TriagePagedPanelPageV1<ForgeCiRunV1, 'pagination' | 'provider_ceiling'>;
type CountRunFacts = Readonly<{
    key: string;
    state: ForgeCiRunV1['state'];
    workflow: ForgeCiRunV1['workflow'];
    phase: ForgeCiRunV1['state']['phase'];
    bucket: ForgeCiRunV1['state']['outcomeBucket'];
    workflowId: string | null;
}>;
type CountBaseline = Readonly<{
    rows: readonly CountRunFacts[];
    byKey: ReadonlyMap<string, CountRunFacts>;
    complete: boolean;
}>;
/** The already-admitted newest provider page is the entire named population. */
export function projectForgeCiBranchCountsV1(previous: ForgeCiBranchCountsProjectionV1 | null, page: RunPage | null): ForgeCiBranchCountsProjectionV1 {
    const baseline = previous?.population;
    const rows = page?.rows ?? [];
    // `incomplete` and continuation describe history outside this response.
    // The native pager marks an unusable follow-up Link as `pagination`, too;
    // that does not make any row in this deliberately bounded window missing.
    const complete = page !== null && page.omittedRowCount === 0 && !page.projectionTruncated;
    let changed = !baseline || baseline.complete !== complete || baseline.rows.length !== rows.length;
    let nextRows: CountRunFacts[] | undefined = baseline
        ? baseline.rows.length === rows.length ? undefined : baseline.rows.slice(0, rows.length)
        : [];
    for (const [index, run] of rows.entries()) {
        const key = forgeCiRunKeyV1(run.ref);
        const prior = baseline?.byKey.get(key);
        const state = run.state;
        const workflow = run.workflow;
        // The admitted run reconciler retains unchanged nested values. A new
        // title/URL does not make phase, outcome or workflow membership new.
        const phase = prior?.state === state ? prior.phase : state.phase;
        const bucket = prior?.state === state ? prior.bucket : state.outcomeBucket;
        const workflowId = prior && prior.workflow === workflow ? prior.workflowId : workflow?.id ?? null;
        const facts = prior && prior.state === state && prior.workflow === workflow ? prior
            : { key, state, workflow, phase, bucket, workflowId };
        if (!prior || prior.phase !== phase || prior.bucket !== bucket || prior.workflowId !== workflowId
            || baseline?.rows[index]?.key !== key) changed = true;
        if (baseline?.rows[index] !== facts) {
            nextRows ??= baseline ? baseline.rows.slice() : [];
            nextRows[index] = facts;
        }
    }
    if (nextRows && nextRows.length !== rows.length) nextRows.length = rows.length;
    const facts = nextRows ?? baseline?.rows ?? [];
    const nextBaseline = { rows: facts,
        byKey: nextRows ? new Map(facts.map(run => [run.key, run])) : baseline?.byKey ?? new Map<string, CountRunFacts>(), complete };
    if (!changed && previous) {
        // Source references can change without changing any count facts. Keep
        // that latest baseline while preserving the atomic public pair.
        return nextRows ? { ...previous, population: nextBaseline } : previous;
    }
    let running = 0;
    let failed = 0;
    let runningKnown = complete;
    let failedKnown = runningKnown;
    const workflows = new Set<string>();
    for (const run of facts) {
        if (run.phase === 'unknown') runningKnown = false;
        else if (run.phase !== 'completed') running++;
        if (run.workflowId === null) { failedKnown = false; continue; }
        // Native pages are newest first. A newer queued/neutral/passed result
        // therefore clears an older failure without another workflow read.
        if (workflows.has(run.workflowId)) continue;
        workflows.add(run.workflowId);
        if (run.bucket === 'unknown') failedKnown = false;
        else if (run.bucket === 'failed') failed++;
    }
    const runningValue = runningKnown ? running : null;
    const failedValue = failedKnown ? failed : null;
    const value = previous && previous.value.running === runningValue && previous.value.failed === failedValue
        ? previous.value : { running: runningValue, failed: failedValue };
    const coverage = previous && previous.coverage.running === runningKnown && previous.coverage.failed === failedKnown
        ? previous.coverage : { running: runningKnown, failed: failedKnown };
    return { value, coverage, population: nextBaseline };
}

export type ForgeCiBranchCountsBindingV1 = Readonly<{
    reads: ForgeCiReadsV1;
    /** Native acquisition supplies the newest maximum-size branch/optional HEAD page. */
    input: ForgeCiActionInputByOperationV1['listRuns'];
}>;
export type ForgeCiBranchCountsOptionsV1 = Readonly<{
    acquire(options: PluginDynamicResourceInvocationOptionsV1): ForgeCiBranchCountsBindingV1 | null | Promise<ForgeCiBranchCountsBindingV1 | null>;
}>;

/** One SDK Resource, using the read controller's admitted projection and timer. */
export function createForgeCiBranchCountsV1({ acquire }: ForgeCiBranchCountsOptionsV1): PluginDynamicResourceRuntime {
    return {
        async read(options) {
            if (options.signal.aborted) return JSON.stringify({ running: null, failed: null });
            const binding = await acquire(options);
            if (binding === null || options.signal.aborted) return JSON.stringify({ running: null, failed: null });
            const lease = binding.reads.acquireBranchCounts(binding.input);
            try {
                if (lease.getSnapshot().pending) await new Promise<void>(resolve => {
                    const done = () => { unsubscribe(); options.signal.removeEventListener('abort', done); resolve(); };
                    const unsubscribe = lease.subscribe(() => { if (!lease.getSnapshot().pending) done(); });
                    options.signal.addEventListener('abort', done, { once: true });
                    if (!lease.getSnapshot().pending || options.signal.aborted) done();
                });
                const failure = lease.getSnapshot().failure;
                if (failure && !options.signal.aborted) throw Object.assign(new Error(failure.code), { failure });
                return JSON.stringify(options.signal.aborted ? { running: null, failed: null } : lease.getValue());
            } finally { lease.release(); }
        },
        async observe(invalidate, options) {
            let disposed = false;
            let release: (() => void) | undefined;
            const dispose = () => { if (disposed) return; disposed = true; release?.(); options.signal.removeEventListener('abort', dispose); };
            if (options.signal.aborted) return { dispose };
            options.signal.addEventListener('abort', dispose, { once: true });
            try {
                const binding = await acquire(options);
                if (binding === null || disposed || options.signal.aborted) return { dispose };
                const lease = binding.reads.acquireBranchCounts(binding.input);
                let value = lease.getValue();
                let failure = lease.getSnapshot().failure;
                let retired = lease.getSnapshot().retired;
                const unsubscribe = lease.subscribe(() => {
                    const snapshot = lease.getSnapshot();
                    const changed = value !== lease.getValue() || failure !== snapshot.failure || retired !== snapshot.retired;
                    value = lease.getValue(); failure = snapshot.failure; retired = snapshot.retired;
                    if (changed) invalidate();
                });
                release = () => { unsubscribe(); lease.release(); };
            } catch (error) {
                dispose();
                throw error;
            }
            return { dispose };
        },
    };
}
