import { describe, expect, it } from 'vitest';

import type { ExecutionRunPublicState, ScmDiffSummaryGenerateInput, ScmDiffSummaryGenerateSuccess } from '@happier-dev/protocol';

import {
    applyScmDiffSummaryEvent,
    createInitialScmDiffSummaryState,
    selectScmDiffSummaryViewModel,
} from './state';

const input = {
    cwd: '/repo',
    source: { kind: 'turnCheckpoint' },
    turnId: 'turn_1',
    checkpointReceiptId: 'receipt_1',
} satisfies ScmDiffSummaryGenerateInput;

const finalSummary = {
    success: true,
    summaryMarkdown: '## Summary\n\nUpdated checkpoint projection.',
    sourceKey: 'turn:turn_1:receipt_1',
    checkpointReceiptId: 'receipt_1',
    metadata: {
        source: { kind: 'turnCheckpoint' },
        sourceKey: 'turn:turn_1:receipt_1',
        turnId: 'turn_1',
        checkpointReceiptId: 'receipt_1',
    },
    truncation: { reason: 'diffBytes', droppedFiles: 2 },
    risks: ['Shared worktree attribution.'],
    testImpact: 'Run protocol tests.',
    suggestedPrBody: 'Summarizes checkpoint projection changes.',
} satisfies ScmDiffSummaryGenerateSuccess;

function runningRun(runId = 'run_1'): ExecutionRunPublicState {
    return {
        runId,
        callId: `call_${runId}`,
        sidechainId: `sidechain_${runId}`,
        intent: 'scm_diff_summary',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'streaming',
        status: 'running',
        startedAtMs: 100,
    };
}

describe('SCM diff summary state', () => {
    it('exposes streaming progress and final structured summary fields for a request key', () => {
        let state = createInitialScmDiffSummaryState();
        state = applyScmDiffSummaryEvent(state, {
            type: 'request_started',
            key: 'summary-key',
            sessionId: 'session_1',
            actionId: 'scm.diffSummary.generate',
            input,
            runId: 'run_1',
            callId: 'call_1',
            sidechainId: 'sidechain_1',
            requestedAtMs: 100,
            intent: 'generate',
        });

        state = applyScmDiffSummaryEvent(state, {
            type: 'run_snapshot',
            key: 'summary-key',
            run: runningRun(),
            progressMarkdown: 'Reading checkpoint diff...',
            observedAtMs: 120,
        });

        expect(selectScmDiffSummaryViewModel(state, 'summary-key')).toMatchObject({
            status: 'running',
            executionRunId: 'run_1',
            streamingMarkdown: 'Reading checkpoint diff...',
            summaryMarkdown: null,
            isShowingLastKnownSummary: false,
        });

        state = applyScmDiffSummaryEvent(state, {
            type: 'run_snapshot',
            key: 'summary-key',
            run: { ...runningRun(), status: 'succeeded', finishedAtMs: 200 },
            structuredOutput: finalSummary,
            observedAtMs: 200,
        });

        expect(selectScmDiffSummaryViewModel(state, 'summary-key')).toMatchObject({
            status: 'succeeded',
            executionRunId: 'run_1',
            summaryMarkdown: finalSummary.summaryMarkdown,
            isPartial: true,
            truncation: finalSummary.truncation,
            risks: finalSummary.risks,
            testImpact: finalSummary.testImpact,
            suggestedPrBody: finalSummary.suggestedPrBody,
            canRetry: true,
        });
    });

    it('preserves last-known summary while regenerate is in flight', () => {
        let state = createInitialScmDiffSummaryState();
        state = applyScmDiffSummaryEvent(state, {
            type: 'request_started',
            key: 'summary-key',
            sessionId: 'session_1',
            actionId: 'scm.diffSummary.generate',
            input,
            runId: 'run_1',
            callId: 'call_1',
            sidechainId: 'sidechain_1',
            requestedAtMs: 100,
            intent: 'generate',
        });
        state = applyScmDiffSummaryEvent(state, {
            type: 'run_snapshot',
            key: 'summary-key',
            run: { ...runningRun(), status: 'succeeded', finishedAtMs: 200 },
            structuredOutput: finalSummary,
            observedAtMs: 200,
        });

        state = applyScmDiffSummaryEvent(state, {
            type: 'request_started',
            key: 'summary-key',
            sessionId: 'session_1',
            actionId: 'scm.diffSummary.generate',
            input,
            runId: 'run_2',
            callId: 'call_2',
            sidechainId: 'sidechain_2',
            requestedAtMs: 300,
            intent: 'regenerate',
        });

        expect(selectScmDiffSummaryViewModel(state, 'summary-key')).toMatchObject({
            status: 'starting',
            executionRunId: 'run_2',
            summaryMarkdown: finalSummary.summaryMarkdown,
            isShowingLastKnownSummary: true,
            pendingIntent: 'regenerate',
            retryAttempt: 0,
        });
    });

    it('marks failed requests retryable without clearing last-known summary', () => {
        let state = createInitialScmDiffSummaryState();
        state = applyScmDiffSummaryEvent(state, {
            type: 'request_started',
            key: 'summary-key',
            sessionId: 'session_1',
            actionId: 'scm.diffSummary.generate',
            input,
            runId: 'run_1',
            callId: 'call_1',
            sidechainId: 'sidechain_1',
            requestedAtMs: 100,
            intent: 'generate',
        });
        state = applyScmDiffSummaryEvent(state, {
            type: 'run_snapshot',
            key: 'summary-key',
            run: { ...runningRun(), status: 'succeeded', finishedAtMs: 200 },
            structuredOutput: finalSummary,
            observedAtMs: 200,
        });

        state = applyScmDiffSummaryEvent(state, {
            type: 'request_failed',
            key: 'summary-key',
            sessionId: 'session_1',
            actionId: 'scm.diffSummary.generate',
            input,
            error: 'Model unavailable',
            errorCode: 'MODEL_UNAVAILABLE',
            failedAtMs: 400,
            intent: 'regenerate',
        });

        expect(selectScmDiffSummaryViewModel(state, 'summary-key')).toMatchObject({
            status: 'failed',
            summaryMarkdown: finalSummary.summaryMarkdown,
            isShowingLastKnownSummary: true,
            canRetry: true,
            retryAttempt: 1,
            error: { message: 'Model unavailable', code: 'MODEL_UNAVAILABLE' },
        });
    });
});
