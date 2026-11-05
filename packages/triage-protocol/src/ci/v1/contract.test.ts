import { describe, expect, it } from 'vitest';
import { ForgeCiStateV1Schema } from './state.js';
import { ForgeCiRunV1Schema } from './runs.js';
import { ForgeCiJobV1Schema } from './jobs.js';
import { ForgeCiLogSelectionV1Schema, ForgeCiExcerptRequestV1Schema, ForgeCiLogV1Schema } from './logs.js';
import { ForgeCiMountedIntentInputV1Schema, ForgeCiMountedIntentResultV1Schema } from './mountedIntent.js';
import { ForgeCiSelectionV1Schema } from './identity.js';
import { createForgeCiConformanceVectorsV1 } from '../testing/v1/index.js';

describe('CI executable V1 contract', () => {
    it('carries declared native step precision without changing the native endpoints', () => {
        const job = createForgeCiConformanceVectorsV1().github.job;
        if (job.steps.kind !== 'available') throw new Error('Conformance job must include steps');
        const value = { ...job, steps: { kind: 'available', values: job.steps.values.map(step => ({ ...step, timestampPrecision: 'second' })) } };
        expect(ForgeCiJobV1Schema.parse(value)).toEqual(value);
        expect(ForgeCiJobV1Schema.safeParse({ ...value, steps: { kind: 'available', values: [{ ...value.steps.values[0], timestampPrecision: 'minute' }] } }).success).toBe(false);
    });

    it('preserves provider startup failure and stale outcomes', () => {
        expect(ForgeCiStateV1Schema.parse({ phase: 'completed', outcome: 'startup_failure', nativeLabel: 'startup_failure', outcomeBucket: 'failed' }).outcome).toBe('startup_failure');
        expect(ForgeCiStateV1Schema.parse({ phase: 'completed', outcome: 'stale', nativeLabel: 'stale', outcomeBucket: 'neutral' }).outcome).toBe('stale');
    });

    it('does not turn terminal outcomes into nonterminal state', () => {
        expect(ForgeCiStateV1Schema.parse({ phase: 'running', outcome: null, nativeLabel: 'running', outcomeBucket: 'pending' })).toMatchObject({ phase: 'running', outcome: null });
        expect(ForgeCiStateV1Schema.safeParse({ phase: 'running', outcome: 'success', nativeLabel: 'running', outcomeBucket: 'pending' }).success).toBe(false);
    });

    it('retains native attempt selection while accepting no-attempt and no-step providers', () => {
        const vectors = createForgeCiConformanceVectorsV1();
        expect(vectors.github.job.ref.selection).toEqual({ kind: 'attempt', attempt: { run: vectors.github.run.ref, attemptId: '2', number: 2 } });
        expect(vectors.gitlab.job.steps.kind).toBe('unsupported');
        expect(ForgeCiSelectionV1Schema.safeParse({ kind: 'run', run: vectors.github.run.ref, attempt: { run: vectors.github.run.ref, attemptId: '2' } }).success).toBe(false);
        // Native run rows can prove workflow identity without a workflow metadata read.
        expect(ForgeCiRunV1Schema.parse({ ...vectors.github.run, workflow: { id: 'workflow-1' } }).workflow?.id).toBe('workflow-1');
    });

    it('keeps pending and unsupported logs distinct from available original evidence', () => {
        const job = createForgeCiConformanceVectorsV1().github.job.ref;
        expect(ForgeCiLogV1Schema.parse({ kind: 'pending', job })).toEqual({ kind: 'pending', job });
        expect(ForgeCiLogV1Schema.safeParse({ kind: 'pending', job, text: '' }).success).toBe(false);
        const available = { kind: 'available', job, logId: 'native-log-1', startLine: 21, startByte: 300, complete: false, continuation: 'provider-cursor' };
        expect(ForgeCiLogV1Schema.parse({ ...available, text: 'original text' })).toMatchObject({ startLine: 21, startByte: 300, text: 'original text', complete: false });
        expect(ForgeCiLogV1Schema.safeParse({ ...available, text: '', fragments: [] }).success).toBe(false);
        expect(ForgeCiLogV1Schema.safeParse({ ...available, fragments: [{ text: 'line', startLine: 0, startByte: 300 }] }).success).toBe(false);
    });

    it('mounted operands use one closed addressed envelope without stale or read values on refusal', () => {
        expect(ForgeCiMountedIntentInputV1Schema.parse({ mountId: 'mount', operation: { kind: 'setTimestampsVisible', visible: false } })).toEqual({ mountId: 'mount', operation: { kind: 'setTimestampsVisible', visible: false } });
        expect(ForgeCiMountedIntentInputV1Schema.safeParse({ mountId: 'mount', intent: { kind: 'setTimestampsVisible', visible: false } }).success).toBe(false);
        expect(ForgeCiMountedIntentInputV1Schema.safeParse({ mountId: 'mount', operation: { kind: 'refresh' } }).success).toBe(false);
        expect(ForgeCiMountedIntentResultV1Schema.safeParse({ status: 'stale_surface' }).success).toBe(false);
        expect(ForgeCiMountedIntentResultV1Schema.safeParse({ status: 'unavailable', value: {} }).success).toBe(false);
    });

});
