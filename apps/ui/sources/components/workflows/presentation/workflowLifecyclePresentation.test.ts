import { describe, expect, it, vi } from 'vitest';

import {
    WORKFLOW_INVOCATION_LIFECYCLES_V1,
    WORKFLOW_RUN_STATES_V1,
    type WorkflowInvocationLifecycleV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

import {
    WORKFLOW_ATTENTION_LIFECYCLES,
    describeWorkflowInvocationAttempt,
    describeWorkflowInvocationLifecycle,
    describeWorkflowRunState,
    summarizeWorkflowInvocationCoverage,
    isWorkflowAttentionInvocation,
} from './workflowLifecyclePresentation';
import { createWorkflowInvocationIndexFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';

/**
 * The one neutral managed-lifecycle presenter.
 *
 * UX §3.4 is explicit that the invocation lifecycle is its own closed contract,
 * that one owner maps each value to label, icon and semantic colour, and that
 * colour is never the sole carrier. These cases exist to refute exactly those
 * three claims.
 */
describe('describeWorkflowInvocationLifecycle', () => {
    it('keeps an interrupted condition structural while its failed child owns attention (FIN M10)', () => {
        expect(describeWorkflowInvocationLifecycle('needs_attention', { blockKind: 'if' })).toMatchObject({
            lifecycle: 'needs_attention', label: 'workflows.runState.interrupted', attention: false,
        });
        expect(describeWorkflowInvocationLifecycle('waiting_for_review', { blockKind: 'step' })).toMatchObject({
            attention: true,
        });
        expect(describeWorkflowInvocationLifecycle('failed', { blockKind: 'step' })).toMatchObject({
            label: 'workflows.invocationState.failed', attention: false,
        });
    });
    it('withdraws held attention as soon as the canonical Stop receipt is accepted', () => {
        expect(isWorkflowAttentionInvocation('waiting_for_review', 'executable', 'running', true)).toBe(false);
        expect(isWorkflowAttentionInvocation('waiting_for_review', 'executable', 'running', false)).toBe(true);
        expect(summarizeWorkflowInvocationCoverage([createWorkflowInvocationIndexFixture({ id: 'held', lifecycle: 'waiting_for_review' })], {
            kindsByInvocationId: new Map([['held', 'executable']]), historyComplete: true,
            runState: 'running', cancelRequested: true,
        }).observedLeafCounts.attention).toBe(0);
    });
    it('presents every canonical Run state, including an unsettled review wait', () => {
        for (const state of WORKFLOW_RUN_STATES_V1) {
            expect(describeWorkflowRunState(state)).toMatchObject({ state, label: state === 'waiting_for_review'
                ? 'workStatus.buckets.needs_you' : `workflows.runState.${state}` });
        }
        expect(describeWorkflowRunState('waiting_for_review')).toMatchObject({ terminal: false, variant: 'attention' });
    });
    it('says Needs you, in the attention tone, for a live Run that waits on the person (DESIGN-13)', () => {
        // A list row shows one word in amber; "Running" in amber says work is fine and urgent at once.
        expect(describeWorkflowRunState('running', { inAttentionWindow: true })).toMatchObject({
            label: 'workStatus.buckets.needs_you', variant: 'attention' });
        expect(describeWorkflowRunState('claimed', { inAttentionWindow: true }).label).toBe('workStatus.buckets.needs_you');
        // A held Run uses the same short attention word even before window membership arrives.
        expect(describeWorkflowRunState('waiting_for_review').label).toBe('workStatus.buckets.needs_you');
        expect(describeWorkflowRunState('waiting_for_review', { inAttentionWindow: true }).label)
            .toBe('workStatus.buckets.needs_you');
        expect(describeWorkflowRunState('failed', { inAttentionWindow: true }).label).toBe('workflows.runState.failed');
        // Interrupted is already the attention word, and says why the person is needed; the row and the
        // Run page header name it the same way.
        expect(describeWorkflowRunState('interrupted', { inAttentionWindow: true })).toMatchObject({
            label: 'workflows.runState.interrupted', variant: 'attention' });
        // An explicit composed word (the Run page headline) stays the caller's.
        expect(describeWorkflowRunState('running', { inAttentionWindow: true, word: 'Running' }).label).toBe('Running');
    });
    it('covers every canonical lifecycle the Protocol declares', () => {
        for (const lifecycle of WORKFLOW_INVOCATION_LIFECYCLES_V1) {
            const presentation = describeWorkflowInvocationLifecycle(lifecycle);
            expect(presentation.lifecycle).toBe(lifecycle);
            expect(presentation.label).toBe(lifecycle === 'cancel_requested'
                ? 'workflows.run.stopping' : `workflows.invocationState.${lifecycle}`);
        }
    });

    it('never carries a lifecycle by colour alone', () => {
        // Healthy states share a neutral tone. Their word and marker together
        // must distinguish them without relying on colour.
        const seen = new Map<string, WorkflowInvocationLifecycleV1>();
        for (const lifecycle of WORKFLOW_INVOCATION_LIFECYCLES_V1) {
            const presentation = describeWorkflowInvocationLifecycle(lifecycle);
            const key = `${presentation.label}\0${presentation.marker.kind}\0${
                presentation.marker.kind === 'icon' ? presentation.marker.icon : 'activity'
            }`;
            expect(seen.get(key)).toBeUndefined();
            seen.set(key, lifecycle);
        }
        expect(seen.size).toBe(WORKFLOW_INVOCATION_LIFECYCLES_V1.length);
    });

    it('names a held Wait-for-you step "Waiting for you", keeping "Waiting for your review" for review holds', () => {
        expect(describeWorkflowInvocationLifecycle('waiting_for_review', { blockKind: 'wait' })).toMatchObject({
            label: 'workflows.review.waitTitle', variant: 'attention', attention: true,
        });
        expect(describeWorkflowInvocationLifecycle('waiting_for_review', { blockKind: 'step' }).label)
            .toBe('workflows.invocationState.waiting_for_review');
        expect(describeWorkflowInvocationLifecycle('completed', { blockKind: 'wait' }).label)
            .toBe('workflows.invocationState.completed');
    });

    it('agrees with the server attention predicate rather than inventing a second one', () => {
        const attention = WORKFLOW_INVOCATION_LIFECYCLES_V1
            .filter((lifecycle) => describeWorkflowInvocationLifecycle(lifecycle).attention);
        expect([...attention].sort()).toEqual([...WORKFLOW_ATTENTION_LIFECYCLES].sort());
    });

    it('lets only a Run-wide pending Stop be inherited by unsettled steps, keeping a standalone step Stop its own', () => {
        expect(describeWorkflowInvocationLifecycle('cancel_requested', { runStopPending: true }).inheritsRunStop).toBe(true);
        expect(describeWorkflowInvocationLifecycle('running', { runStopPending: true }).inheritsRunStop).toBe(true);
        expect(describeWorkflowInvocationLifecycle('completed', { runStopPending: true }).inheritsRunStop).toBe(false);
        expect(describeWorkflowInvocationLifecycle('cancel_requested', { runStopPending: false }).inheritsRunStop).toBe(false);
        expect(describeWorkflowInvocationLifecycle('cancel_requested').inheritsRunStop).toBe(false);
    });

    it('marks only settled lifecycles terminal, so a stopping row is not read as stopped', () => {
        expect(describeWorkflowInvocationLifecycle('cancel_requested').terminal).toBe(false);
        expect(describeWorkflowInvocationLifecycle('cancelled').terminal).toBe(true);
        expect(describeWorkflowInvocationLifecycle('completed').terminal).toBe(true);
        expect(describeWorkflowInvocationLifecycle('failed').terminal).toBe(true);
        expect(describeWorkflowInvocationLifecycle('running').terminal).toBe(false);
    });

    it('shows in-flight work with live feedback and settled work with a static marker', () => {
        expect(describeWorkflowInvocationLifecycle('running').marker.kind).toBe('activity');
        expect(describeWorkflowInvocationLifecycle('admitting').marker.kind).toBe('activity');
        expect(describeWorkflowInvocationLifecycle('completed').marker).toEqual({
            kind: 'icon',
            icon: 'check-circle',
        });
        expect(describeWorkflowInvocationLifecycle('failed').marker).toEqual({
            kind: 'icon',
            icon: 'x-circle',
        });
    });
});

/**
 * The one attempt formatter.
 *
 * The index counts physical attempts from zero as a canonical decimal string;
 * people count from one. Activity rows, Flow occurrences, the selected detail
 * and their accessible names all read this owner, so a retried step is
 * "Attempt 2" everywhere instead of "1" on one surface and "2" on another.
 */
describe('describeWorkflowInvocationAttempt', () => {
    it('reads a zero-based counter as a one-based attempt without parsing it to a JS number', () => {
        expect(describeWorkflowInvocationAttempt('1')).toEqual({
            label: 'workflows.run.attempt:{"attempt":"2"}',
            retried: true,
        });
        // 2^53 + 1 is exactly where a `Number` would silently round.
        expect(describeWorkflowInvocationAttempt('9007199254740993').label)
            .toBe('workflows.run.attempt:{"attempt":"9007199254740994"}');
    });

    it('names the first attempt as attempt 1 and does not call it a retry', () => {
        expect(describeWorkflowInvocationAttempt('0')).toEqual({
            label: 'workflows.run.attempt:{"attempt":"1"}',
            retried: false,
        });
    });
});

describe('summarizeWorkflowInvocationCoverage', () => {
    it('counts proven executable current slots, not structural rows or historical attempts', () => {
        const rows = [
            createWorkflowInvocationIndexFixture({ id: 'root', parentRecordId: null, lifecycle: 'completed' }),
            createWorkflowInvocationIndexFixture({ id: 'body', parentRecordId: 'root', memberOrdinal: '0', lifecycle: 'completed' }),
            createWorkflowInvocationIndexFixture({ id: 'old', parentRecordId: 'body', memberOrdinal: '0', attempt: '0', lifecycle: 'failed' }),
            createWorkflowInvocationIndexFixture({ id: 'current', parentRecordId: 'body', memberOrdinal: '0', attempt: '9007199254740993', lifecycle: 'completed' }),
            createWorkflowInvocationIndexFixture({ id: 'older', parentRecordId: 'body', memberOrdinal: '0', attempt: '9007199254740992', lifecycle: 'failed' }),
            createWorkflowInvocationIndexFixture({ id: 'action', parentRecordId: 'body', memberOrdinal: '1', lifecycle: 'completed' }),
            createWorkflowInvocationIndexFixture({ id: 'wait', parentRecordId: 'body', memberOrdinal: '2', lifecycle: 'waiting_for_approval' }),
        ];
        expect(summarizeWorkflowInvocationCoverage(rows, {
            kindsByInvocationId: new Map([
                ['root', 'structural'], ['body', 'structural'],
                ['old', 'executable'], ['current', 'executable'], ['older', 'executable'],
                ['action', 'executable'], ['wait', 'executable'],
            ]),
            historyComplete: true,
        })).toEqual({
            observedLeafCounts: { completed: 2, failed: 0, attention: 1 },
            coverage: 'complete', knownFailure: false,
        });
    });

    it('keeps positive failure evidence while missing pages or classification stay unknown', () => {
        const rows = [
            createWorkflowInvocationIndexFixture({ id: 'failed', parentRecordId: 'root', memberOrdinal: '0', lifecycle: 'failed' }),
            createWorkflowInvocationIndexFixture({ id: 'unopened', parentRecordId: 'root', memberOrdinal: '1', lifecycle: 'completed' }),
        ];
        const evidence = { kindsByInvocationId: new Map([['failed', 'executable'] as const]), historyComplete: false };
        expect(summarizeWorkflowInvocationCoverage(rows, evidence)).toEqual({
            observedLeafCounts: { completed: 0, failed: 1, attention: 0 },
            coverage: 'partial', knownFailure: true,
        });
        expect(summarizeWorkflowInvocationCoverage(rows, { ...evidence, historyComplete: true }).coverage).toBe('partial');
        expect(summarizeWorkflowInvocationCoverage([], { kindsByInvocationId: new Map(), historyComplete: false, runState: 'failed' }).knownFailure).toBe(true);
        expect(summarizeWorkflowInvocationCoverage([], { kindsByInvocationId: new Map(), historyComplete: false, knownFailure: true }).knownFailure).toBe(true);
    });
});
