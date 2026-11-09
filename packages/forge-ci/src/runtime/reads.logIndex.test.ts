import { describe, expect, it } from 'vitest';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk';
import { ForgeCiActionInputSchemasV1, type ForgeCiLogV1, type ForgeCiOperationIdV1, type ForgeCiStepV1 } from '@happier-dev/triage-protocol/ci/v1';
import { createForgeCiAdapterV1 } from './adapter.js';
import { createForgeCiReadsV1 } from './reads.js';

const repository = { kind: 'github', deployment: 'https://github.com', repository: 'owner/project' } as const;
const job = { selection: { kind: 'run', run: { v: 1, repository, runId: '42' } }, jobId: 'job' } as const;
type AvailableLog = Extract<ForgeCiLogV1, { kind: 'available' }>;
const log = (text: string): Extract<AvailableLog, { text: string }> => ({ kind: 'available', job, logId: 'native-log', text, startLine: 1, startByte: 0, complete: true, continuation: null });
function controller() {
    let requests = 0;
    let currentLog: ForgeCiLogV1 = log('a\nb\nc');
    const actionRefs = Object.fromEntries(Object.keys(ForgeCiActionInputSchemasV1).map(key => [key, { pluginId: 'fixture.forge', localId: key }])) as Readonly<Record<ForgeCiOperationIdV1, PluginContributionRef | null>>;
    const adapter = createForgeCiAdapterV1({ actionRefs, invoke: async () => { requests++; return { kind: 'value', value: currentLog }; } });
    return { reads: createForgeCiReadsV1({ adapter, scopeKey: 'account:credential:origin' }), requests: () => requests,
        setLog: (value: ForgeCiLogV1) => { currentLog = value; } };
}

describe('read-controller-owned admitted log index', () => {
    it('keeps index/tokens through equal native observations and status-only step arrivals, rebuilding only a changed line', () => {
        const { reads } = controller();
        const step: ForgeCiStepV1 = { id: 's2', name: 'step', state: { phase: 'running', outcome: null, outcomeBucket: 'pending', nativeLabel: 'running' }, startedAtMs: 0 };
        const source = log(Array.from({ length: 1000 }, (_, index) => `line ${index}`).join('\n'));
        const first = reads.indexLog({ log: source, steps: [step] })!;
        expect(first.work.decodedLines).toBe(1000);
        expect(reads.indexLog({ log: structuredClone(source), steps: [{ ...step, state: { phase: 'completed', outcome: 'success', outcomeBucket: 'passed', nativeLabel: 'success' } }] })).toBe(first);
        const changed = reads.indexLog({ log: log(source.text.replace('line 500', 'LINE 500')), steps: [step] })!;
        expect(changed.work.decodedLines).toBe(1);
        expect(changed.work.tokenizedLines).toBe(1);
        expect(changed.lines[499]).toBe(first.lines[499]);
        expect(changed.lines[501]).toBe(first.lines[501]);
        expect(changed.lines[500]).not.toBe(first.lines[500]);
        reads.retire();
        expect(reads.indexLog({ log: source, steps: [step] })).toBeNull();
    });

    it('retains compatible covered ranges across subset navigation and joins carrier pages through the shared merger', () => {
        const { reads } = controller();
        const first = reads.indexLog({ log: log('a\nb\nc') })!;
        const subset = { ...log('c'), startLine: 3, startByte: 4, complete: false };
        expect(reads.indexLog({ log: subset })).toBe(first);
        expect(reads.indexLog({ log: null })).toBeNull();
        expect(reads.indexLog({ log: log('a\nb\nc') })).toBe(first);
        const prefix = { ...log('a\n'), logId: 'paged', complete: false, continuation: 'next' };
        const prefixIndex = reads.indexLog({ log: prefix })!;
        const end = reads.indexLog({ log: { ...prefix, text: 'b\nc', startLine: 2, startByte: 2, complete: true, continuation: null } })!;
        expect(end.complete).toBe(true);
        expect(end.plainText).toBe('a\nb\nc');
        expect(end.lines[0]).toBe(prefixIndex.lines[0]);
        expect(end.work.decodedLines).toBe(2);
        reads.retire();
    });

    it('retracts expired or malformed native projections and never merges conflicting bytes into retained ranges', () => {
        const { reads } = controller();
        const source = log('a\nb\nc');
        const first = reads.indexLog({ log: source })!;
        expect(reads.indexLog({ log: { kind: 'expired', job } })).toBeNull();
        const afterExpiry = reads.indexLog({ log: source })!;
        expect(afterExpiry).not.toBe(first);
        const conflictingSubset = reads.indexLog({ log: { ...log('B'), startLine: 2, startByte: 2, complete: false } })!;
        expect(conflictingSubset.lines.map(line => line.number)).toEqual([2]);
        expect(conflictingSubset.complete).toBe(false);
        expect(reads.indexLog({ log: { ...log('c'), startLine: 7, startByte: 2, complete: false } })).toBeNull();
        reads.retire();
    });

    it('keeps same-turn same-job replacement continuous, then retires its last released body and index', async () => {
        const { reads, requests } = controller();
        const input = { repository, runId: '42', jobId: 'job', selection: { kind: 'all' } } as const;
        const first = reads.acquire('readJobLog', input);
        await first.refresh();
        const body = first.getValue();
        const index = reads.indexLog({ log: body })!;
        first.release();
        const returned = reads.acquire('readJobLog', input);
        expect(requests()).toBe(1);
        expect(returned.getValue()).toBe(body);
        expect(reads.indexLog({ log: returned.getValue() })).toBe(index);
        returned.setActive(false); returned.setActive(true);
        expect(requests()).toBe(1);
        await returned.refresh();
        expect(requests()).toBe(2);
        returned.release();
        await Promise.resolve();
        expect(reads.getLogIndex(job)).toBeNull();
        expect(returned.getValue()).toBeNull();
        reads.invalidate('readJobLog', input);
        expect(returned.getValue()).toBeNull();
        const reloaded = reads.acquire('readJobLog', input);
        await reloaded.refresh();
        expect(requests()).toBe(3);
        expect(reads.indexLog({ log: reloaded.getValue() })).not.toBe(index);
        reloaded.release(); reads.retire();
    });

    it('retains zero abandoned job bodies and indexes after browsing the twelve megabyte-log workload', async () => {
        const { reads, setLog, requests } = controller();
        const released = [];
        const jobs = Array.from({ length: 12 }, (_, i) => ({ ...job, jobId: `job-${i}` }));
        for (const current of jobs) {
            setLog({ ...log('x'.repeat(1_048_576)), job: current });
            const lease = reads.acquire('readJobLog', { repository, runId: '42', jobId: current.jobId, selection: { kind: 'all' } });
            await lease.refresh();
            expect(reads.indexLog({ log: lease.getValue() })?.plainText.length).toBe(1_048_576);
            lease.release();
            released.push(lease);
            await Promise.resolve();
        }
        expect(requests()).toBe(12);
        expect(released.filter(lease => lease.getValue() !== null)).toHaveLength(0);
        expect(jobs.filter(ref => reads.getLogIndex(ref) !== null)).toHaveLength(0);
        setLog({ ...log('new body'), job: jobs[0]! });
        const reopened = reads.acquire('readJobLog', { repository, runId: '42', jobId: jobs[0]!.jobId, selection: { kind: 'all' } });
        await reopened.refresh();
        expect(requests()).toBe(13);
        expect(reopened.getValue()).toMatchObject({ text: 'new body' });
        reopened.release(); reads.retire();
    });

    it('retracts every retained projection of a job when an admitted read reports expiry', async () => {
        const { reads, setLog } = controller();
        const target = { repository, runId: '42', jobId: 'job' } as const;
        const full = reads.acquire('readJobLog', { ...target, selection: { kind: 'all' } });
        const tail = reads.acquire('readJobLog', { ...target, selection: { kind: 'tail', lines: 1 } });
        await Promise.all([full.refresh(), tail.refresh()]);
        const original = reads.indexLog({ log: full.getValue() });
        setLog({ kind: 'expired', job });
        await tail.refresh();
        expect(full.getValue()).toEqual({ kind: 'expired', job });
        expect(reads.indexLog({ log: full.getValue() })).toBeNull();
        setLog(log('a\nb\nc'));
        await full.refresh();
        expect(reads.indexLog({ log: full.getValue() })).not.toBe(original);
        full.release(); tail.release(); reads.retire();
    });

    it('keeps the same native job demanded through implicit and explicit attempt queries until both release', async () => {
        const { reads, setLog } = controller();
        const selected = { ...job, selection: { kind: 'attempt', attempt: { run: job.selection.run, attemptId: '2' } } } as const;
        setLog({ ...log('native attempt'), job: selected });
        const input = { repository, runId: '42', jobId: job.jobId, selection: { kind: 'all' } } as const;
        const implicit = reads.acquire('readJobLog', input);
        const explicit = reads.acquire('readJobLog', { ...input, attempt: '2' });
        await Promise.all([implicit.refresh(), explicit.refresh()]);
        const index = reads.indexLog({ log: explicit.getValue() });
        implicit.release();
        await Promise.resolve();
        expect(reads.getLogIndex(selected)).toBe(index);
        expect(explicit.getValue()).not.toBeNull();
        explicit.release();
        await Promise.resolve();
        expect([implicit, explicit].filter(lease => lease.getValue() !== null)).toHaveLength(0);
        expect(reads.getLogIndex(selected)).toBeNull();
        reads.retire();
    });
});
