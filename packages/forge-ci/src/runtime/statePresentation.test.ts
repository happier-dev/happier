import { createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForgeCiActionInputSchemasV1, type ForgeCiOperationIdV1, type ForgeCiRunV1, type ForgeCiStateV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk';
import type { PluginDynamicResourceInvocationOptionsV1 } from '@happier-dev/plugin-sdk/resources';
import { createForgeCiAdapterV1 } from './adapter.js';
import { createForgeCiReadsV1 } from './reads.js';
import { createForgeCiBranchCountsV1, projectForgeCiBranchCountsV1 } from './statePresentation.js';

const repository = { kind: 'github', deployment: 'https://github.com', repository: 'owner/project' } as const;
const state = (phase: ForgeCiStateV1['phase'], outcomeBucket: ForgeCiStateV1['outcomeBucket']): ForgeCiStateV1 => {
    if (phase === 'unknown') return { phase, outcomeBucket, nativeLabel: phase, outcome: 'unknown' };
    if (phase === 'completed') return { phase, outcomeBucket, nativeLabel: phase, outcome: outcomeBucket === 'failed' ? 'failure' : 'success' };
    return { phase, outcomeBucket, nativeLabel: phase, outcome: null };
};
const run = (id: string, workflow: string | undefined, phase: ForgeCiRunV1['state']['phase'], bucket: ForgeCiRunV1['state']['outcomeBucket']): ForgeCiRunV1 => ({
    ref: { v: 1, repository, runId: id }, createdAtMs: Number(id),
    ...(workflow ? { workflow: { id: workflow } } : {}),
    state: state(phase, bucket),
});
const page = (rows: readonly ForgeCiRunV1[]) => ({ rows, omittedRowCount: 0, projectionTruncated: false, continuation: 'older-provider-page', incomplete: null });
function resourceOptions(signal: AbortSignal): PluginDynamicResourceInvocationOptionsV1 {
    return createTestResourceInvocationContext({
        signal, context: { kind: 'global' },
    });
}
afterEach(() => vi.useRealTimers());

describe('one recent branch count producer', () => {
    it('does zero bucket classification for metadata-only pages and reads only changed keyed facts', () => {
        const cost = { phase: 0, bucket: 0, workflow: 0 };
        const measured = (value: ForgeCiRunV1): ForgeCiRunV1 => {
            const admittedState = value.state;
            const workflowId = value.workflow?.id;
            return { ...value, state: { ...admittedState,
                get phase() { cost.phase++; return admittedState.phase; },
                get outcomeBucket() { cost.bucket++; return admittedState.outcomeBucket; },
            }, ...(workflowId ? { workflow: { get id() { cost.workflow++; return workflowId; } } } : {}) };
        };
        const rows = Array.from({ length: 1000 }, (_, index) => measured(run(String(index + 1), `workflow-${index}`, 'completed', 'passed')));
        const first = projectForgeCiBranchCountsV1(null, page(rows));
        expect(first.value).toEqual({ running: 0, failed: 0 });
        expect(cost.phase).toBeGreaterThan(0);
        cost.phase = cost.bucket = cost.workflow = 0;
        const metadataRows = rows.map(value => ({ ...value, title: 'presentation changed', webUrl: 'https://forge.example.test/run' }));
        expect(projectForgeCiBranchCountsV1(first, page(metadataRows))).toBe(first);
        expect(cost).toEqual({ phase: 0, bucket: 0, workflow: 0 });

        const changed = measured(run('501', 'workflow-500', 'running', 'pending'));
        const changedRows = metadataRows.map(value => value.ref.runId === '501' ? { ...value, state: changed.state } : value);
        const active = projectForgeCiBranchCountsV1(first, page(changedRows));
        expect(active.value).toEqual({ running: 1, failed: 0 });
        expect(cost).toEqual({ phase: 1, bucket: 1, workflow: 0 });
        cost.phase = cost.bucket = cost.workflow = 0;
        expect(projectForgeCiBranchCountsV1(active, page([...changedRows].reverse())).value).toBe(active.value);
        expect(cost).toEqual({ phase: 0, bucket: 0, workflow: 0 });
    });

    it('updates newest-workflow order, workflow membership and coverage without losing independent unknowns', () => {
        const newest = run('3', 'a', 'queued', 'pending');
        const older = run('2', 'a', 'completed', 'failed');
        const other = run('1', 'b', 'completed', 'failed');
        const initial = projectForgeCiBranchCountsV1(null, page([newest, older, other]));
        expect(initial.value).toEqual({ running: 1, failed: 1 });
        const samePair = projectForgeCiBranchCountsV1(initial, page([{ ...newest, state: state('running', 'pending') }, older, other]));
        expect(samePair.value).toBe(initial.value);
        const joined = { ...other, workflow: { id: 'a' } };
        const sameWorkflow = projectForgeCiBranchCountsV1(samePair, page([newest, older, joined]));
        expect(sameWorkflow.value).toEqual({ running: 1, failed: 0 });
        const reordered = projectForgeCiBranchCountsV1(sameWorkflow, page([older, newest, joined]));
        expect(reordered.value).toEqual({ running: 1, failed: 1 });
        const omitted = projectForgeCiBranchCountsV1(reordered, { ...page([older, newest, joined]), omittedRowCount: 1 });
        expect(omitted.value).toEqual({ running: null, failed: null });
        const restored = projectForgeCiBranchCountsV1(omitted, page([older, newest, joined]));
        expect(restored.value).toEqual({ running: 1, failed: 1 });
        const unknownRunning = projectForgeCiBranchCountsV1(restored, page([older, { ...newest, state: state('unknown', 'unknown') }, joined]));
        expect(unknownRunning.value).toEqual({ running: null, failed: 1 });
        const unknownFailed = projectForgeCiBranchCountsV1(unknownRunning, page([{ ...older, state: state('completed', 'unknown') }, newest, joined]));
        expect(unknownFailed.value).toEqual({ running: 1, failed: null });
        expect(projectForgeCiBranchCountsV1(unknownFailed, { ...page([older, newest, joined]), projectionTruncated: true }).value)
            .toEqual({ running: null, failed: null });
        // Removing the newest row restores the next workflow outcome; removing
        // the full population cannot retain a removed run or its baseline.
        expect(projectForgeCiBranchCountsV1(restored, page([newest, joined])).value).toEqual({ running: 1, failed: 0 });
        expect(projectForgeCiBranchCountsV1(restored, page([])).value).toEqual({ running: 0, failed: 0 });
        expect(projectForgeCiBranchCountsV1(restored, null).value).toEqual({ running: null, failed: null });
    });
    it('counts all known nonterminal runs and only the newest native workflow outcome, retaining equal pairs', () => {
        const rows = [run('9', 'a', 'queued', 'pending'), run('8', 'a', 'completed', 'failed'), run('7', 'b', 'waiting', 'pending'), run('6', 'c', 'completed', 'failed')];
        const first = projectForgeCiBranchCountsV1(null, page(rows));
        expect(first.value).toEqual({ running: 2, failed: 1 });
        const metadata = projectForgeCiBranchCountsV1(first, page(rows.map(value => ({ ...value, title: 'new presentation' }))));
        expect(metadata).toBe(first);
        const neutral = projectForgeCiBranchCountsV1(first, page([run('10', 'c', 'completed', 'neutral'), ...rows]));
        expect(neutral.value).toEqual({ running: 2, failed: 0 });
    });

    it('keeps independently known counts and never treats incomplete evidence as zero', () => {
        const missingWorkflow = projectForgeCiBranchCountsV1(null, page([run('1', undefined, 'completed', 'failed')]));
        expect(missingWorkflow.value).toEqual({ running: 0, failed: null });
        const unknownPhase = projectForgeCiBranchCountsV1(null, page([run('2', 'a', 'unknown', 'failed')]));
        expect(unknownPhase.value).toEqual({ running: null, failed: 1 });
        const incomplete = projectForgeCiBranchCountsV1(null, { ...page([]), omittedRowCount: 1 });
        expect(incomplete.value).toEqual({ running: null, failed: null });
        // Provider page continuation defines this recent population, not incompleteness.
        expect(projectForgeCiBranchCountsV1(null, page([])).value).toEqual({ running: 0, failed: 0 });
        // The native page owner also uses `pagination` when a follow-up Link
        // cannot be walked. The current response body is still the population.
        expect(projectForgeCiBranchCountsV1(null, {
            ...page([run('3', 'b', 'completed', 'failed')]), incomplete: 'pagination',
        }).value).toEqual({ running: 0, failed: 1 });
    });

    it('binds SDK read/observe to the same exact query and badge-only waiting liveness with one atomic invalidation', async () => {
        vi.useFakeTimers();
        let rows = [run('1', 'a', 'waiting', 'pending')];
        let requests = 0;
        const actionRefs = Object.fromEntries(Object.keys(ForgeCiActionInputSchemasV1).map(key => [key, key === 'listRuns' ? { pluginId: 'fixture.forge', localId: key } : null])) as Readonly<Record<ForgeCiOperationIdV1, PluginContributionRef | null>>;
        const adapter = createForgeCiAdapterV1({ actionRefs, activeRunPollIntervalMs: 3000, invoke: async () => { requests++; return { kind: 'value', value: page(structuredClone(rows)) }; } });
        const reads = createForgeCiReadsV1({ adapter, scopeKey: 'exact-authority' });
        const resource = createForgeCiBranchCountsV1({ acquire: () => ({ reads, input: { repository, filters: { branch: 'main' } } }) });
        const abort = new AbortController();
        const options = resourceOptions(abort.signal);
        const invalidate = vi.fn();
        const observer = await resource.observe(invalidate, options);
        expect(JSON.parse(String(await resource.read(options)))).toEqual({ running: 1, failed: 0 });
        expect(requests).toBe(1);
        const counts = reads.acquireBranchCounts({ repository, filters: { branch: 'main' } });
        const countChanged = vi.fn();
        const unsubscribe = counts.subscribeValue(countChanged);
        invalidate.mockClear();
        rows = rows.map(value => ({ ...value, title: 'metadata only' }));
        await vi.advanceTimersByTimeAsync(3000);
        expect(invalidate).not.toHaveBeenCalled();
        expect(countChanged).not.toHaveBeenCalled();
        rows = [run('1', 'a', 'queued', 'pending')];
        await vi.advanceTimersByTimeAsync(3000);
        expect(invalidate).not.toHaveBeenCalled();
        expect(countChanged).not.toHaveBeenCalled();
        rows = [run('1', 'a', 'completed', 'failed')];
        await vi.advanceTimersByTimeAsync(3000);
        expect(invalidate).toHaveBeenCalledTimes(1);
        expect(countChanged).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(await resource.read(options)))).toEqual({ running: 0, failed: 1 });
        const settledRequests = requests;
        await vi.advanceTimersByTimeAsync(300_000);
        expect(requests).toBe(settledRequests);
        unsubscribe(); counts.release(); observer.dispose(); abort.abort(); reads.retire();
    });

    it('does not acquire an already aborted Resource lifetime', async () => {
        const acquire = vi.fn(() => null);
        const resource = createForgeCiBranchCountsV1({ acquire });
        const abort = new AbortController(); abort.abort();
        const options = resourceOptions(abort.signal);
        (await resource.observe(vi.fn(), options)).dispose();
        expect(JSON.parse(String(await resource.read(options)))).toEqual({ running: null, failed: null });
        expect(acquire).not.toHaveBeenCalled();
    });

    it('rejects watch establishment when native acquisition fails instead of reporting a live observer', async () => {
        const failure = new Error('native admission unavailable');
        // Native acquisition is the external Action/admission boundary supplied by the forge plugin.
        const resource = createForgeCiBranchCountsV1({ acquire: async () => { throw failure; } });
        const invalidate = vi.fn();
        const options = resourceOptions(new AbortController().signal);
        await expect(Promise.resolve(resource.observe(invalidate, options))).rejects.toBe(failure);
        expect(invalidate).not.toHaveBeenCalled();
    });
});
