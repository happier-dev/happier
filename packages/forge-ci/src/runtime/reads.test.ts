import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue, PluginContributionRef } from '@happier-dev/plugin-sdk';
import {
    ForgeCiActionInputSchemasV1,
    type ForgeCiActionResultByOperationV1,
    type ForgeCiJobV1,
    type ForgeCiOperationIdV1,
    type ForgeCiRunV1,
    type ForgeCiStateV1,
} from '@happier-dev/triage-protocol/ci/v1';
import { createForgeCiAdapterV1 } from './adapter.js';
import { createForgeCiReadsV1, type ForgeCiReadLeaseV1 } from './reads.js';

const repository = { kind: 'github', deployment: 'https://github.com', repository: 'owner/project' } as const;
const runRef = { v: 1, repository, runId: '42' } as const;
const selection = { kind: 'run', run: runRef } as const;
const state = (phase: ForgeCiStateV1['phase'] = 'completed'): ForgeCiStateV1 => {
    if (phase === 'completed') return { phase, nativeLabel: phase, outcome: 'success', outcomeBucket: 'passed' };
    if (phase === 'unknown') return { phase, nativeLabel: phase, outcome: 'unknown', outcomeBucket: 'unknown' };
    return { phase, nativeLabel: phase, outcome: null, outcomeBucket: 'pending' };
};
const job = (id: string): ForgeCiJobV1 => ({
    ref: { selection, jobId: id }, name: 'same display name', state: state(),
    steps: { kind: 'available', values: ['2', '7'].map(id => ({ id, name: 'step', state: state() })) },
});
const run = (phase: ForgeCiStateV1['phase']): ForgeCiRunV1 => ({ ref: runRef, state: state(phase) });
const page = <T>(rows: readonly T[]) => ({ rows, omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null });

function boundary<K extends ForgeCiOperationIdV1>(operation: K, respond: (input: JsonValue, signal?: AbortSignal) => Promise<unknown> | unknown) {
    const calls: { input: JsonValue; signal?: AbortSignal }[] = [];
    const actionRefs = Object.fromEntries(Object.keys(ForgeCiActionInputSchemasV1).map(key => [key, key === operation ? { pluginId: 'fixture.forge', localId: key } : null])) as Readonly<Record<ForgeCiOperationIdV1, PluginContributionRef | null>>;
    const adapter = createForgeCiAdapterV1({
        actionRefs, activeRunPollIntervalMs: 3000,
        // Ordinary Action invocation is the external system boundary. The adapter,
        // schemas and controller remain real beneath it.
        invoke: async (_action, input, options) => {
            calls.push({ input, signal: options?.signal });
            return respond(input, options?.signal);
        },
    });
    return { adapter, calls, reads: createForgeCiReadsV1({ adapter, scopeKey: 'account:credential:origin' }) };
}

afterEach(() => vi.useRealTimers());

describe('exact CI read demand', () => {
    it('walks a valid jobs continuation only on explicit demand and preserves exact selection and retained row identity', async () => {
        const selectedAttempt = { kind: 'attempt', attempt: { run: runRef, attemptId: '2' } } as const;
        const firstJob = { ...job('first'), ref: { selection: selectedAttempt, jobId: 'first' } };
        const laterJob = { ...job('later'), ref: { selection: selectedAttempt, jobId: 'later' } };
        const { reads, calls } = boundary('listJobs', input => {
            const query = ForgeCiActionInputSchemasV1.listJobs.parse(input);
            return { kind: 'value', value: { ...page([query.cursor ? laterJob : firstJob]), continuation: query.cursor ? null : 'next-exact-page' } };
        });
        expect(reads).toHaveProperty('acquirePaged', expect.any(Function));
        const walk = reads.acquirePaged('listJobs', { repository, runId: '42', attempt: '2' });
        await walk.refresh();
        expect(calls).toHaveLength(1);
        expect(walk.getValue()?.continuation).toBe('next-exact-page');
        const retained = walk.getValue()!.rows[0];
        await walk.loadMore();
        expect(calls.map(call => call.input)).toEqual([
            { repository, runId: '42', attempt: '2' },
            { repository, runId: '42', attempt: '2', cursor: 'next-exact-page' },
        ]);
        expect(walk.getValue()?.rows.map(row => row.ref.jobId)).toEqual(['first', 'later']);
        expect(walk.getValue()?.rows[0]).toBe(retained);
        expect(walk.getValue()?.continuation).toBeNull();
        expect(walk.getValue()?.incomplete).toBeNull();
        await walk.loadMore();
        expect(calls).toHaveLength(2);
        walk.release(); reads.retire();
    });

    it('retains rows after a failed later page, retries that same cursor, and resets the walk on Refresh', async () => {
        let fail = true;
        const { reads, calls } = boundary('listJobs', input => {
            const query = ForgeCiActionInputSchemasV1.listJobs.parse(input);
            if (query.cursor && fail) return { kind: 'unavailable', failure: { class: 'transient', code: 'later_page_failed' } };
            return { kind: 'value', value: { ...page([job(query.cursor ? 'later' : 'first')]), continuation: query.cursor ? null : 'next' } };
        });
        const walk = reads.acquirePaged('listJobs', { repository, runId: '42' });
        await walk.refresh();
        const first = walk.getValue()!.rows[0];
        await walk.loadMore();
        expect(walk.getValue()?.rows).toEqual([first]);
        expect(walk.getSnapshot().failure?.code).toBe('later_page_failed');
        expect(walk.getValue()?.continuation).toBe('next');
        fail = false;
        await walk.loadMore();
        expect(walk.getValue()?.rows.map(row => row.ref.jobId)).toEqual(['first', 'later']);
        expect(walk.getValue()?.rows[0]).toBe(first);
        expect(calls.slice(1).map(call => call.input)).toEqual([
            { repository, runId: '42', cursor: 'next' }, { repository, runId: '42', cursor: 'next' },
        ]);
        await walk.refresh();
        expect(walk.getValue()?.rows).toEqual([first]);
        expect(walk.getValue()?.continuation).toBe('next');
        expect(walk.getSnapshot().failure).toBeNull();
        expect(calls).toHaveLength(4);
        walk.release(); reads.retire();
    });

    it('retains two demanded pages when first-page Refresh fails, then appends without skipping the second page', async () => {
        let failFirst = false;
        const { reads, calls } = boundary('listJobs', input => {
            const query = ForgeCiActionInputSchemasV1.listJobs.parse(input);
            if (!query.cursor && failFirst) return { kind: 'unavailable', failure: { class: 'transient', code: 'first_refresh_failed' } };
            const id = query.cursor === 'page-3' ? 'third' : query.cursor ? 'second' : 'first';
            return { kind: 'value', value: { ...page([job(id)]), continuation: id === 'third' ? null : id === 'second' ? 'page-3' : 'page-2' } };
        });
        const walk = reads.acquirePaged('listJobs', { repository, runId: '42' });
        await walk.refresh();
        await walk.loadMore();
        const retained = walk.getValue()!;
        failFirst = true;
        await walk.refresh();
        expect(walk.getValue()).toBe(retained);
        expect(walk.getSnapshot().failure?.code).toBe('first_refresh_failed');
        await walk.loadMore();
        expect(calls.at(-1)?.input).toEqual({ repository, runId: '42', cursor: 'page-3' });
        expect(walk.getValue()?.rows.map(row => row.ref.jobId)).toEqual(['first', 'second', 'third']);
        expect(walk.getValue()?.rows[1]).toBe(retained.rows[1]);
        expect(walk.getSnapshot().failure?.code).toBe('first_refresh_failed');
        walk.release(); reads.retire();
    });

    it('preserves demanded later pages when the shared first query receives changed job facts', async () => {
        let name = 'first observation';
        const firstPage = Array.from({ length: 1000 }, (_, index) => job(String(index)));
        const { reads } = boundary('listJobs', input => {
            const query = ForgeCiActionInputSchemasV1.listJobs.parse(input);
            return { kind: 'value', value: { ...page(query.cursor ? [job('later')] : firstPage.map((row, index) => index === 0 ? { ...row, name } : row)), continuation: query.cursor ? null : 'page-2' } };
        });
        const walk = reads.acquirePaged('listJobs', { repository, runId: '42' });
        await walk.refresh();
        await walk.loadMore();
        const before = walk.getValue()!;
        const later = before.rows.at(-1);
        let publications = 0;
        walk.subscribeValue(() => { publications++; });
        const peer = reads.acquire('listJobs', { repository, runId: '42' });
        await peer.refresh();
        expect(walk.getValue()).toBe(before);
        expect(publications).toBe(0);
        name = 'changed fact';
        await peer.refresh();
        expect(walk.getValue()?.rows).toHaveLength(1001);
        expect(walk.getValue()?.rows[0]?.name).toBe('changed fact');
        expect(walk.getValue()?.rows[500]).toBe(before.rows[500]);
        expect(walk.getValue()?.rows.at(-1)).toBe(later);
        expect(publications).toBe(1);
        peer.release(); walk.release(); reads.retire();
    });

    it('keeps overlapping native pages unique and retains facts from the newly admitted page without extra reads', async () => {
        let firstName = 'initial first-page fact';
        const { reads, calls } = boundary('listJobs', input => {
            const query = ForgeCiActionInputSchemasV1.listJobs.parse(input);
            const rows = query.cursor
                ? [{ ...job('overlap'), name: 'later-page fact' }, job('last')]
                : [job('first'), { ...job('overlap'), name: firstName }];
            return { kind: 'value', value: { ...page(rows), continuation: query.cursor ? null : 'page-2' } };
        });
        const walk = reads.acquirePaged('listJobs', { repository, runId: '42' });
        await walk.refresh();
        await walk.loadMore();
        expect(walk.getValue()?.rows.map(row => row.ref.jobId)).toEqual(['first', 'overlap', 'last']);
        expect(walk.getValue()?.rows[1]?.name).toBe('later-page fact');
        expect(calls).toHaveLength(2);
        const last = walk.getValue()!.rows[2];
        const peer = reads.acquire('listJobs', { repository, runId: '42' });
        firstName = 'new first-page fact';
        await peer.refresh();
        expect(walk.getValue()?.rows.map(row => row.ref.jobId)).toEqual(['first', 'overlap', 'last']);
        expect(walk.getValue()?.rows[1]?.name).toBe('new first-page fact');
        expect(walk.getValue()?.rows[2]).toBe(last);
        expect(calls).toHaveLength(3);
        peer.release(); walk.release(); reads.retire();
    });

    it('merges demanded log pages into one original index and aborts an abandoned continuation', async () => {
        let finish: ((value: unknown) => void) | undefined;
        const target = job('log-job').ref;
        const { reads, calls } = boundary('readJobLog', input => {
            const query = ForgeCiActionInputSchemasV1.readJobLog.parse(input);
            if (query.cursor === 'last') return new Promise(resolve => { finish = resolve; });
            return { kind: 'value', value: { kind: 'available', job: target, logId: 'paged',
                text: query.cursor ? 'second\n' : 'first\n', startLine: query.cursor ? 2 : 1, startByte: query.cursor ? 6 : 0,
                complete: false, continuation: query.cursor ? 'last' : 'next' } };
        });
        const walk = reads.acquirePaged('readJobLog', { repository, runId: '42', jobId: target.jobId, selection: { kind: 'all' } });
        await walk.refresh();
        const initial = walk.indexLog()!;
        expect(calls).toHaveLength(1);
        await walk.loadMore();
        const next = walk.indexLog()!;
        expect(next.plainText).toBe('first\nsecond');
        expect(next.lines[0]).toBe(initial.lines[0]);
        expect(next.complete).toBe(false);
        expect(next.continuation).toBe('last');
        const pending = walk.loadMore();
        expect(calls).toHaveLength(3);
        walk.release();
        expect(calls[2]!.signal?.aborted).toBe(true);
        finish?.({ kind: 'value', value: { kind: 'available', job: target, logId: 'paged', text: 'late', startLine: 3, startByte: 13, complete: true, continuation: null } });
        await pending;
        expect(walk.getValue()).toBeNull();
        reads.retire();
    });

    it('borrows a retained complete job log for an explicit tail without another native read or index', async () => {
        const target = job('log-job').ref;
        const { reads, calls } = boundary('readJobLog', () => ({ kind: 'value', value: {
            kind: 'available', job: target, logId: 'immutable', text: 'first\nlast\n', startLine: 1, startByte: 0, complete: true, continuation: null,
        } }));
        const full = reads.acquire('readJobLog', { repository, runId: '42', jobId: target.jobId, selection: { kind: 'all' } });
        await full.refresh();
        const index = reads.indexLog({ log: full.getValue() });
        expect(reads.getLogIndex(target)).toBe(index);
        expect(reads.getLogIndex({ ...target, jobId: 'another-job' })).toBeNull();
        expect(reads.getLogIndex({ ...target, selection: { kind: 'attempt', attempt: { run: runRef, attemptId: 'other' } } })).toBeNull();
        const tail = reads.acquire('readJobLog', { repository, runId: '42', jobId: target.jobId, selection: { kind: 'tail', lines: 1 } });
        expect(calls).toHaveLength(1);
        expect(reads.indexLog({ log: tail.getValue() })).toBe(index);
        const admitted = full.getValue();
        if (admitted?.kind !== 'available') throw new Error('Complete log did not settle');
        reads.indexLog({ log: { ...admitted, logId: 'another-admitted-identity' } });
        expect(reads.getLogIndex(target)).toBeNull();
        expect(reads.indexLog({ log: admitted })).toBe(index);
        tail.release(); full.release(); reads.retire();
        expect(reads.getLogIndex(target)).toBeNull();
    });

    it.each(['none', 'suffix', 'whole', 'whole-active-peer'] as const)('borrows completed log pages but refreshes changed suffix provenance on demand (retained tail: %s)', async retainedTail => {
        const targetJob = job('log-job');
        const target = targetJob.ref;
        const steps = targetJob.steps.kind === 'available' ? targetJob.steps.values : [];
        const whole = retainedTail === 'whole' || retainedTail === 'whole-active-peer';
        const activePeer = retainedTail === 'whole-active-peer';
        let retainedPeer: ForgeCiReadLeaseV1<'readJobLog'> | undefined;
        let finishTail: (() => void) | undefined;
        let replacement = false;
        const { reads, calls } = boundary('readJobLog', input => {
            const query = ForgeCiActionInputSchemasV1.readJobLog.parse(input);
            if (replacement) {
                const response = { kind: 'value', value: { kind: 'available', job: target, logId: 'paged-complete',
                    text: query.selection.kind === 'tail' ? 'new last\n' : 'first\n', startLine: query.selection.kind === 'tail' ? 2 : 1,
                    startByte: query.selection.kind === 'tail' ? 6 : 0, complete: false,
                    continuation: query.selection.kind === 'tail' ? null : 'replacement-next' } };
                if (activePeer && query.selection.kind === 'tail') return new Promise(resolve => { finishTail = () => resolve(response); });
                return response;
            }
            if (query.selection.kind === 'tail' && query.selection.lines === 200) return { kind: 'value', value: { kind: 'available', job: target, logId: 'paged-complete',
                text: 'first\nlast\n', startLine: 1, startByte: 0, complete: true, continuation: null } };
            if (query.selection.kind === 'tail') return { kind: 'value', value: { kind: 'available', job: target, logId: 'paged-complete',
                text: 'last\n', startLine: 2, startByte: 6, complete: false, continuation: null } };
            return { kind: 'value', value: { kind: 'available', job: target, logId: 'paged-complete',
                text: query.cursor ? 'last\n' : 'first\n', startLine: query.cursor ? 2 : 1, startByte: query.cursor ? 6 : 0,
                complete: Boolean(query.cursor), continuation: query.cursor ? null : 'next' } };
        });
        if (retainedTail !== 'none') {
            const previous = reads.acquirePaged('readJobLog', { repository, runId: '42', jobId: target.jobId, selection: { kind: 'tail', lines: whole ? 200 : 1 } });
            await previous.refresh();
            previous.indexLog(steps);
            if (activePeer) retainedPeer = previous;
            else previous.release();
        }
        const initialCalls = calls.length;
        const walk = reads.acquirePaged('readJobLog', { repository, runId: '42', jobId: target.jobId, selection: { kind: 'all' } });
        await walk.refresh();
        walk.indexLog(steps);
        await walk.loadMore();
        const index = walk.indexLog(steps)!;
        expect(index.complete).toBe(true);
        expect(calls).toHaveLength(initialCalls + 2);
        const tailLines = whole ? 200 : 1;
        const tail = reads.acquirePaged('readJobLog', { repository, runId: '42', jobId: target.jobId, selection: { kind: 'tail', lines: tailLines } });
        expect(calls).toHaveLength(initialCalls + 2);
        expect(tail.indexLog(steps)).toBe(index);
        await walk.refresh();
        expect(calls).toHaveLength(initialCalls + 3);
        expect(tail.indexLog(steps)).toBe(index);
        tail.setActive(false);
        replacement = true;
        await walk.refresh();
        expect(calls).toHaveLength(initialCalls + 4 + Number(activePeer));
        const admittedReplacement = reads.getLogIndex(target);
        expect(admittedReplacement?.complete).toBe(false);
        expect(admittedReplacement?.plainText).toBe('first');
        expect(admittedReplacement?.steps).toBe(index.steps);
        if (activePeer) {
            expect(retainedPeer!.getValue()).toBeNull();
            expect(retainedPeer!.getSnapshot().pending).toBe(true);
        }
        const replaced = walk.indexLog(steps)!;
        expect(replaced).toBe(admittedReplacement);
        expect(replaced.complete).toBe(false);
        expect(replaced.continuation).toBe('replacement-next');
        expect(replaced.plainText).toBe('first');
        expect(reads.getLogIndex(target)).toBe(replaced);
        const newlyDemanded = reads.acquirePaged('readJobLog', { repository, runId: '42', jobId: target.jobId, selection: { kind: 'tail', lines: 100 } }, { active: false });
        expect(newlyDemanded.getValue()).toBeNull();
        expect(calls).toHaveLength(initialCalls + 4 + Number(activePeer));
        newlyDemanded.release();
        tail.setActive(true);
        expect(calls).toHaveLength(initialCalls + 5);
        expect(tail.getSnapshot().pending).toBe(true);
        if (whole) {
            expect(tail.getValue()).toBeNull();
            expect(tail.indexLog(steps)).toBeNull();
            expect(reads.getLogIndex(target)).toBe(replaced);
        }
        finishTail?.();
        await tail.refresh();
        const changed = tail.indexLog(steps)!;
        expect(changed.plainText).toBe('new last');
        expect(changed.complete).toBe(false);
        expect(tail.getValue()?.continuation).toBeNull();
        expect(ForgeCiActionInputSchemasV1.readJobLog.parse(calls.at(-1)!.input).selection).toEqual({ kind: 'tail', lines: tailLines });
        tail.release(); retainedPeer?.release(); walk.release(); reads.retire();
    });

    it.each(['complete', 'incomplete', 'suffix', 'cursor'] as const)('reuses an admitted native tail only with whole-log initial-query coverage (%s)', async coverage => {
        const target = job('log-job').ref;
        const { reads, calls } = boundary('readJobLog', () => ({ kind: 'value', value: {
            kind: 'available', job: target, logId: `tail-${coverage}`,
            text: coverage === 'suffix' ? 'last\n' : coverage === 'incomplete' ? 'first\n' : 'first\nlast\n',
            startLine: coverage === 'suffix' ? 2 : 1, startByte: coverage === 'suffix' ? 6 : 0,
            complete: coverage !== 'incomplete', continuation: coverage === 'incomplete' ? 'next' : null,
        } }));
        const source = reads.acquirePaged('readJobLog', { repository, runId: '42', jobId: target.jobId,
            selection: { kind: 'tail', lines: 200 }, ...(coverage === 'cursor' ? { cursor: 'existing-position' } : {}) });
        await source.refresh();
        const index = source.indexLog()!;
        expect(index.complete).toBe(coverage === 'complete' || coverage === 'cursor');
        expect(calls).toHaveLength(1);
        const narrower = reads.acquirePaged('readJobLog', { repository, runId: '42', jobId: target.jobId, selection: { kind: 'tail', lines: 100 } });
        if (coverage === 'complete') {
            expect(calls).toHaveLength(1);
            expect(narrower.indexLog()).toBe(index);
            const wider = reads.acquirePaged('readJobLog', { repository, runId: '42', jobId: target.jobId, selection: { kind: 'tail', lines: 300 } });
            expect(calls).toHaveLength(1);
            expect(wider.indexLog()).toBe(index);
            wider.release();
        } else {
            expect(calls).toHaveLength(2);
            await narrower.refresh();
        }
        narrower.release(); source.release(); reads.retire();
    });

    it('proves retained tail coverage without traversing the already admitted log suffix', async () => {
        const target = job('log-job').ref;
        const suffix = 'suffix\n'.repeat(100_000);
        const { reads, calls } = boundary('readJobLog', input => {
            const query = ForgeCiActionInputSchemasV1.readJobLog.parse(input);
            return { kind: 'value', value: { kind: 'available', job: target, logId: 'large-retained',
                text: query.cursor ? suffix : 'first\n', startLine: query.cursor ? 2 : 1, startByte: query.cursor ? 6 : 0,
                complete: Boolean(query.cursor), continuation: query.cursor ? null : 'next' } };
        });
        const walk = reads.acquirePaged('readJobLog', { repository, runId: '42', jobId: target.jobId, selection: { kind: 'all' } });
        await walk.refresh();
        walk.indexLog();
        await walk.loadMore();
        const index = walk.indexLog()!;
        expect(index.lines).toHaveLength(100_001);
        expect(index.complete).toBe(true);
        // Count the real platform encoder without replacing its implementation.
        // Revalidating even the old first page is unnecessary for a held source.
        const encoded = vi.spyOn(TextEncoder.prototype, 'encode');
        try {
            expect(reads.getLogIndex(target)).toBe(index);
            const tail = reads.acquirePaged('readJobLog', { repository, runId: '42', jobId: target.jobId, selection: { kind: 'tail', lines: 1 } });
            const wider = reads.acquirePaged('readJobLog', { repository, runId: '42', jobId: target.jobId, selection: { kind: 'tail', lines: 100 } });
            expect(calls).toHaveLength(2);
            expect(tail.getValue()).toBe(index.log);
            expect(wider.getValue()).toBe(index.log);
            expect(tail.indexLog()).toBe(index);
            expect(wider.indexLog()).toBe(index);
            expect(walk.indexLog()).toBe(index);
            expect(encoded).not.toHaveBeenCalled();
            await walk.refresh();
            expect(calls).toHaveLength(3);
            expect(tail.getValue()).toBe(index.log);
            expect(wider.getValue()).toBe(index.log);
            expect(tail.indexLog()).toBe(index);
            expect(wider.indexLog()).toBe(index);
            expect(walk.indexLog()).toBe(index);
            expect(encoded).not.toHaveBeenCalled();
            wider.release(); tail.release();
        } finally { encoded.mockRestore(); walk.release(); reads.retire(); }
    });

    it.each(['release', 'signal'] as const)('moves in-flight transport to a surviving borrower via %s and uses it for fresh queries', async retirement => {
        const lifetime = new AbortController();
        let finishFirst: ((value: unknown) => void) | undefined;
        const creator = boundary('readRun', () => new Promise(resolve => { finishFirst = resolve; }));
        const peer = boundary('readRun', input => ({ kind: 'value', value: { ...run('completed'), ref: {
            ...runRef, runId: (input as { runId: string }).runId,
        } } }));
        const first = creator.reads.acquire('readRun', { repository, runId: '42' }, { adapter: creator.adapter, signal: lifetime.signal });
        const second = creator.reads.acquire('readRun', { repository, runId: '42' }, { adapter: peer.adapter });
        expect(creator.calls).toHaveLength(1);
        expect(peer.calls).toHaveLength(0);
        if (retirement === 'release') first.release();
        else lifetime.abort();
        expect(creator.calls[0]!.signal?.aborted).toBe(true);
        expect(peer.calls).toHaveLength(1);
        await second.refresh();
        expect(second.getValue()?.ref.runId).toBe('42');
        const selected = creator.reads.acquire('readRun', { repository, runId: '43' }, { adapter: peer.adapter });
        await selected.refresh();
        expect(selected.getValue()?.ref.runId).toBe('43');
        expect(creator.calls).toHaveLength(1);
        expect(peer.calls).toHaveLength(2);
        finishFirst?.({ kind: 'value', value: { ...run('completed'), title: 'retired creator' } });
        await Promise.resolve();
        expect(second.getValue()).not.toHaveProperty('title');
        second.release(); selected.release(); creator.reads.retire(); peer.reads.retire();
    });

    it('coalesces equivalent mounts and preserves keyed rows, nested steps and semantic subscriptions across equal 200s', async () => {
        let jobs = Array.from({ length: 1000 }, (_, index) => job(String(index)));
        const { reads, calls } = boundary('listJobs', () => ({ kind: 'value', value: page(structuredClone(jobs)) }));
        const first = reads.acquire('listJobs', { repository, runId: '42' });
        const second = reads.acquire('listJobs', { runId: '42', repository });
        await Promise.all([first.refresh(), second.refresh()]);
        expect(calls).toHaveLength(1);
        const before = first.getValue()!;
        const semantic = vi.fn();
        const presentation = vi.fn();
        first.subscribeValue(semantic);
        first.subscribe(presentation);
        await first.refresh();
        expect(first.getValue()).toBe(before);
        expect(second.getValue()).toBe(before);
        expect(semantic).not.toHaveBeenCalled();
        expect(presentation).toHaveBeenCalled();
        jobs = jobs.map((value, index) => index === 7 ? { ...value, name: 'changed' } : value);
        jobs = [jobs[7]!, ...jobs.slice(0, 7), ...jobs.slice(8)];
        await first.refresh();
        const changed = first.getValue()!;
        expect(changed.rows[0]).not.toBe(before.rows[7]);
        expect(changed.rows[0]!.steps).toBe(before.rows[7]!.steps);
        expect(changed.rows[1]).toBe(before.rows[0]);
        expect(changed.rows[999]).toBe(before.rows[999]);
        expect(semantic).toHaveBeenCalledTimes(1);
        first.release(); second.release(); reads.retire();
    });

    it('uses exact-query validators, retains 304 bodies and recovers a body-less 304 only once', async () => {
        const replies: ForgeCiActionResultByOperationV1['listRuns'][] = [
            { kind: 'notModified', validator: 'orphan' },
            { kind: 'value', value: page([run('completed')]), validator: 'etag' },
            { kind: 'notModified', validator: 'etag' },
            { kind: 'notModified' }, { kind: 'notModified' },
        ];
        const { reads, calls } = boundary('listRuns', () => replies.shift());
        const query = reads.acquire('listRuns', { repository, filters: { branch: 'main' } });
        await query.refresh();
        expect(calls).toHaveLength(2);
        expect(calls[1]!.input).not.toHaveProperty('validator');
        const retained = query.getValue();
        await query.refresh();
        expect(calls[2]!.input).toHaveProperty('validator', 'etag');
        expect(query.getValue()).toBe(retained);
        const other = reads.acquire('listRuns', { repository, filters: { branch: 'other' } });
        await other.refresh();
        expect(calls).toHaveLength(5);
        expect(calls[3]!.input).not.toHaveProperty('validator');
        expect(other.getValue()).toBeNull();
        expect(other.getSnapshot().failure).not.toBeNull();
        query.release(); other.release(); reads.retire();
    });

    it.each(['completed', 'waiting', 'unknown'] as const)('parks %s detail with zero recurring reads', async phase => {
        vi.useFakeTimers();
        const { reads, calls } = boundary('readRun', () => ({ kind: 'value', value: run(phase) }));
        const lease = reads.acquire('readRun', { repository, runId: '42' });
        await lease.refresh();
        await vi.advanceTimersByTimeAsync(300_000);
        expect(calls).toHaveLength(1);
        lease.release(); reads.retire();
    });

    it('activates badge-only waiting liveness on an already admitted parked detail query', async () => {
        vi.useFakeTimers();
        const { reads, calls } = boundary('listRuns', () => ({ kind: 'value', value: page([run('waiting')]) }));
        const input = { repository, filters: { branch: 'main' } };
        const detail = reads.acquire('listRuns', input);
        await detail.refresh();
        await vi.advanceTimersByTimeAsync(3000);
        expect(calls).toHaveLength(1);
        const counts = reads.acquireBranchCounts(input);
        await vi.advanceTimersByTimeAsync(3000);
        expect(calls).toHaveLength(2);
        counts.release();
        await vi.advanceTimersByTimeAsync(300_000);
        expect(calls).toHaveLength(2);
        detail.release(); reads.retire();
    });

    it('retains the conditional baseline with no idle work after final lease release, then re-enters once', async () => {
        vi.useFakeTimers();
        let round = 0;
        const { reads, calls } = boundary('readRun', () => ++round === 1
            ? { kind: 'value', value: run('running'), validator: 'retained' }
            : { kind: 'notModified', validator: 'retained' });
        const first = reads.acquire('readRun', { repository, runId: '42' });
        await first.refresh();
        const retained = first.getValue();
        first.release();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(calls).toHaveLength(1);
        const returned = reads.acquire('readRun', { repository, runId: '42' });
        const peer = reads.acquire('readRun', { repository, runId: '42' });
        expect(returned.getValue()).toBe(retained);
        await returned.refresh();
        expect(calls).toHaveLength(2);
        expect(calls[1]!.input).toHaveProperty('validator', 'retained');
        expect(returned.getValue()).toBe(retained);
        expect(peer.getValue()).toBe(retained);
        returned.release(); peer.release();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(calls).toHaveLength(2);
        reads.retire();
    });

    it('polls visible active detail without overlap, stops after failure, and conditionally re-enters once', async () => {
        vi.useFakeTimers();
        let settle: ((result: unknown) => void) | undefined;
        let round = 0;
        const { reads, calls } = boundary('readRun', () => ++round === 1
            ? { kind: 'value', value: run('running'), validator: 'active' }
            : new Promise(resolve => { settle = resolve; }));
        const lease = reads.acquire('readRun', { repository, runId: '42' });
        await lease.refresh();
        await vi.advanceTimersByTimeAsync(3000);
        expect(calls).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(calls).toHaveLength(2);
        settle!({ kind: 'unavailable', failure: { class: 'transient', code: 'offline' } });
        await vi.advanceTimersByTimeAsync(300_000);
        expect(calls).toHaveLength(2);
        expect(lease.getValue()).not.toBeNull();
        expect(lease.getSnapshot().failure).toMatchObject({ code: 'offline' });
        lease.setActive(false);
        lease.setActive(true);
        expect(calls).toHaveLength(3);
        lease.release(); reads.retire();
    });

    it('reuses already admitted jobs without singleton reads', async () => {
        const { reads, calls } = boundary('listJobs', () => ({ kind: 'value', value: page([job('1'), job('2')]) }));
        const list = reads.acquire('listJobs', { repository, runId: '42' });
        await list.refresh();
        const selected = reads.acquire('readJob', { repository, jobId: '2' });
        expect(selected.getValue()).toBe(list.getValue()!.rows[1]);
        expect(calls).toHaveLength(1);
        list.release(); selected.release(); reads.retire();
    });

    it('resumes one conditional active read at the provider deadline, including after early Refresh', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        let round = 0;
        const { reads, calls } = boundary('readRun', () => ++round === 1
            ? { kind: 'value', value: run('running'), validator: 'active' }
            : round === 2
                ? { kind: 'unavailable', failure: { class: 'rateLimit', code: 'provider_throttled', retryNotBeforeMs: 10_000 } }
                : { kind: 'value', value: run('completed'), validator: 'settled' });
        const lease = reads.acquire('readRun', { repository, runId: '42' });
        await lease.refresh();
        const retained = lease.getValue();
        await vi.advanceTimersByTimeAsync(3000);
        expect(calls).toHaveLength(2);
        expect(lease.getValue()).toBe(retained);
        expect(lease.getSnapshot().failure?.class).toBe('rateLimit');
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(2000);
        await Promise.all([lease.refresh(), lease.refresh()]);
        expect(calls).toHaveLength(2);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(4999);
        expect(calls).toHaveLength(2);
        await lease.refresh();
        expect(calls).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls).toHaveLength(3);
        expect(calls[2]!.input).toHaveProperty('validator', 'active');
        expect(lease.getValue()?.state.phase).toBe('completed');
        expect(lease.getSnapshot().failure).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(calls).toHaveLength(3);
        lease.release(); reads.retire();
    });

    it('honors an extended provider backoff without a cadence retry or duplicate wakeup', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        let round = 0;
        const { reads, calls } = boundary('readRun', () => ++round === 1
            ? { kind: 'value', value: run('running') }
            : round < 4
                ? { kind: 'unavailable', failure: { class: 'rateLimit', code: 'provider_throttled', retryNotBeforeMs: round === 2 ? 10_000 : 20_000 } }
                : { kind: 'value', value: run('completed') });
        const lease = reads.acquire('readRun', { repository, runId: '42' });
        await lease.refresh();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(calls).toHaveLength(3);
        expect(lease.getSnapshot().failure?.retryNotBeforeMs).toBe(20_000);
        expect(vi.getTimerCount()).toBe(1);
        await lease.refresh();
        await vi.advanceTimersByTimeAsync(9999);
        expect(calls).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls).toHaveLength(4);
        expect(vi.getTimerCount()).toBe(0);
        lease.release(); reads.retire();
    });

    it('resumes an active job but never invents active demand for an unobserved run', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        let round = 0;
        const activeJob = { ...job('7'), state: state('running') };
        const running = boundary('readJob', () => ++round === 1
            ? { kind: 'value', value: activeJob }
            : round === 2
                ? { kind: 'unavailable', failure: { class: 'rateLimit', code: 'provider_throttled', retryNotBeforeMs: 10_000 } }
                : { kind: 'value', value: job('7') });
        const unknown = boundary('readRun', () => ({ kind: 'unavailable', failure: { class: 'rateLimit', code: 'provider_throttled', retryNotBeforeMs: 10_000 } }));
        const lease = running.reads.acquire('readJob', { repository, jobId: '7' });
        const unobserved = unknown.reads.acquire('readRun', { repository, runId: '42' });
        await Promise.all([lease.refresh(), unobserved.refresh()]);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(running.calls).toHaveLength(3);
        expect(unknown.calls).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
        lease.release(); unobserved.release(); running.reads.retire(); unknown.reads.retire();
    });

    it.each(['hidden', 'released', 'retired'] as const)('cancels a provider-deadline wakeup when demand is %s', async inactive => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        let round = 0;
        const { reads, calls } = boundary('readRun', () => ++round === 1
            ? { kind: 'value', value: run('running') }
            : { kind: 'unavailable', failure: { class: 'rateLimit', code: 'provider_throttled', retryNotBeforeMs: 10_000 } });
        const lease = reads.acquire('readRun', { repository, runId: '42' });
        await lease.refresh();
        await vi.advanceTimersByTimeAsync(3000);
        expect(vi.getTimerCount()).toBe(1);
        if (inactive === 'hidden') lease.setActive(false);
        else if (inactive === 'released') lease.release();
        else reads.retire();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(calls).toHaveLength(2);
        lease.release(); reads.retire();
    });

    it.each(['completed', 'waiting', 'unknown', 'no-deadline'] as const)('keeps %s demand parked after rate limiting', async phase => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        let round = 0;
        const { reads, calls } = boundary('readRun', () => ++round === 1
            ? { kind: 'value', value: run(phase === 'no-deadline' ? 'running' : phase) }
            : { kind: 'unavailable', failure: { class: 'rateLimit', code: 'provider_throttled', ...(phase === 'no-deadline' ? {} : { retryNotBeforeMs: 10_000 }) } });
        const lease = reads.acquire('readRun', { repository, runId: '42' });
        await lease.refresh();
        await lease.refresh();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(calls).toHaveLength(2);
        await lease.refresh();
        expect(calls).toHaveLength(3);
        lease.release(); reads.retire();
    });

    it.each(['queued', 'waiting'] as const)('resumes presented %s badge demand at the provider deadline', async phase => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        let round = 0;
        const { reads, calls } = boundary('listRuns', () => ++round === 1
            ? { kind: 'value', value: page([run(phase)]) }
            : round === 2
                ? { kind: 'unavailable', failure: { class: 'rateLimit', code: 'provider_throttled', retryNotBeforeMs: 10_000 } }
                : { kind: 'value', value: page([run('completed')]) });
        const counts = reads.acquireBranchCounts({ repository, filters: { branch: 'main' } });
        await counts.refresh();
        await vi.advanceTimersByTimeAsync(9999);
        expect(calls).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls).toHaveLength(3);
        expect(counts.getValue().running).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        counts.release(); reads.retire();
    });

    it('aborts hidden reads and drops late hidden/retired replies', async () => {
        let settle: ((result: unknown) => void) | undefined;
        const pending = boundary('readRun', () => new Promise(resolve => { settle = resolve; }));
        const lease = pending.reads.acquire('readRun', { repository, runId: '42' });
        const finished = lease.refresh();
        lease.setActive(false);
        expect(pending.calls[0]!.signal?.aborted).toBe(true);
        settle!({ kind: 'value', value: run('running') });
        await finished;
        expect(lease.getValue()).toBeNull();
        pending.reads.retire();
        expect(lease.getSnapshot().retired).toBe(true);
        lease.release();
    });

    it('suspends the admitted authority after authentication refusal without retrying peer reads', async () => {
        vi.useFakeTimers();
        let response: unknown = { kind: 'value', value: run('running') };
        const { reads, calls } = boundary('readRun', () => response);
        const target = job('log-job').ref;
        const index = reads.indexLog({ log: { kind: 'available', job: target, logId: 'authority-log',
            text: 'retained', startLine: 1, startByte: 0, complete: true, continuation: null } });
        expect(reads.getLogIndex(target)).toBe(index);
        const first = reads.acquire('readRun', { repository, runId: '42' });
        await first.refresh();
        const second = reads.acquire('readRun', { repository, runId: '43' });
        await second.refresh();
        response = { kind: 'unavailable', failure: { class: 'authentication', code: 'expired' } };
        await first.refresh();
        const before = calls.length;
        expect(reads.getLogIndex(target)).toBe(index);
        await second.refresh();
        await vi.advanceTimersByTimeAsync(300_000);
        expect(calls).toHaveLength(before);
        expect(second.getSnapshot().failure).toBeNull();
        expect(second.getValue()).not.toBeNull();
        reads.retire();
        expect(second.getValue()).toBeNull();
        first.release(); second.release();
    });

    it('parks future admissions after authentication failure while an admitted peer finishes', async () => {
        let finishPeer!: (result: unknown) => void;
        const { reads, calls } = boundary('readRun', input => {
            const query = ForgeCiActionInputSchemasV1.readRun.parse(input);
            return query.runId === '43'
                ? new Promise(resolve => { finishPeer = resolve; })
                : { kind: 'unavailable', failure: { class: 'authentication', code: 'expired' } };
        });
        const peer = reads.acquire('readRun', { repository, runId: '43' });
        const pending = peer.refresh();
        const rejected = reads.acquire('readRun', { repository, runId: '42' });
        await rejected.refresh();
        const abortedByPeerFailure = calls[0]!.signal?.aborted;
        finishPeer({ kind: 'value', value: { ...run('completed'), ref: { ...runRef, runId: '43' } } });
        await pending;
        expect(abortedByPeerFailure).toBe(false);
        expect(peer.getValue()?.ref.runId).toBe('43');
        expect(peer.getSnapshot().failure).toBeNull();
        const next = reads.acquire('readRun', { repository, runId: '44' });
        await next.refresh();
        expect(calls).toHaveLength(2);
        expect(next.getSnapshot().failure).toMatchObject({ class: 'authentication' });
        peer.release(); rejected.release(); next.release(); reads.retire();
    });
});
