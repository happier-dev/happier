import { describe, expect, it } from 'vitest';

import type { ExecutionRunPublicState, ScmComparison, ScmDiffSummaryGenerateInput, ScmDiffSummaryGenerateSuccess } from '@happier-dev/protocol';
import { buildScmComparisonSourceKey } from '@happier-dev/protocol/scm';

import {
    applyScmDiffSummaryEvent,
    buildScmDiffSummaryRequestKey,
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
    it('keeps generation requests for distinct retained comparisons separate even when their selector is the same', () => {
        const source = { kind: 'branch' as const, head: 'HEAD', base: 'main' };
        const first = buildScmDiffSummaryRequestKey({ sessionId: 'session_1', input: { cwd: '/repo', source, comparisonId: 'a'.repeat(64) } });
        const second = buildScmDiffSummaryRequestKey({ sessionId: 'session_1', input: { cwd: '/repo', source, comparisonId: 'b'.repeat(64) } });
        expect(first).not.toBe(second);
    });
    const comparison = {
        id: 'comparison_1', source: input.source, repository: { rootPath: '/repo' },
        endpoints: { before: 'blob_before', after: 'blob_after' },
        inventory: { state: 'complete', reasons: [], files: [{
            path: 'src/a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
            evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-before\n+after' },
            occurrences: [{ id: 'change_1', alias: 'c1', path: 'src/a.ts', position: 0,
                before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }],
        }] },
    } satisfies ScmComparison;
    const pending = {
        success: true, sourceKey: comparison.id, metadata: { source: input.source, sourceKey: comparison.id },
        comparison, requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'pending' } },
        analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: ['change_1'] },
        runId: 'run_1', resultId: 'result_1', revision: 0,
    } satisfies ScmDiffSummaryGenerateSuccess;

    function observe(output: ScmDiffSummaryGenerateSuccess) {
        let state = applyScmDiffSummaryEvent(createInitialScmDiffSummaryState(), {
            type: 'request_started', key: 'progressive', sessionId: 'session_1', actionId: 'scm.diffSummary.generate',
            input: { ...input, outputs: ['walkthrough'] }, runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1',
            requestedAtMs: 100, intent: 'generate',
        });
        return applyScmDiffSummaryEvent(state, {
            type: 'run_snapshot', key: 'progressive', run: { ...runningRun(), retentionPolicy: 'resumable', runClass: 'long_lived' },
            structuredOutput: output, observedAtMs: 120,
        });
    }

    it('projects saved edits without a model call and refuses an older revision or a foreign result', () => {
        const original = observe({ ...pending, revision: 2 });
        const result = { resultId: 'result_1', revision: 3, canUndo: true, output: {
            ...pending, revision: 3, outputs: { walkthrough: { state: 'complete' as const, value: {
                title: 'My edited title', intro: '', stops: [], otherChangeRefs: ['change_1'],
            } } },
        } };
        const edited = applyScmDiffSummaryEvent(original, { type: 'saved_result', key: 'progressive', result, observedAtMs: 130 });
        expect(selectScmDiffSummaryViewModel(edited, 'progressive')).toMatchObject({ revision: 3, outputs: result.output.outputs, savedResult: result });
        expect(applyScmDiffSummaryEvent(edited, { type: 'saved_result', key: 'progressive', result: { ...result, revision: 1 }, observedAtMs: 140 })).toBe(edited);
        expect(applyScmDiffSummaryEvent(edited, { type: 'saved_result', key: 'progressive', result: { ...result, resultId: 'foreign' }, observedAtMs: 140 })).toBe(edited);
        const scoped = { ...edited, entriesByKey: { ...edited.entriesByKey, progressive: { ...edited.entriesByKey.progressive!, scopeKey: 'account-a' } } };
        const failedRefresh = applyScmDiffSummaryEvent(scoped, { type: 'request_failed', key: 'progressive', sessionId: 'session_1',
            actionId: 'scm.diffSummary.generate', input, error: 'Machine unavailable', failedAtMs: 145, intent: 'regenerate' });
        expect(failedRefresh.entriesByKey.progressive?.scopeKey).toBe('account-a');
        expect(selectScmDiffSummaryViewModel(failedRefresh, 'progressive')?.savedResult).toEqual(result);
        for (const structuredOutput of [
            { ...pending, resultId: 'foreign', revision: 4 },
            { ...pending, success: false as const, error: 'An old failure', errorCode: 'SUMMARY_FAILED' as const, revision: 2 },
        ]) {
            const observed = applyScmDiffSummaryEvent(edited, { type: 'run_snapshot', key: 'progressive', run: runningRun(), structuredOutput, observedAtMs: 150 });
            expect(selectScmDiffSummaryViewModel(observed, 'progressive')).toMatchObject({ status: 'succeeded', resultId: 'result_1', revision: 3, outputs: result.output.outputs });
        }
    });

    it('exposes inventory and analysis before prose without calling admission success output completion', () => {
        expect(selectScmDiffSummaryViewModel(observe(pending), 'progressive')).toMatchObject({
            status: 'running', comparison, outputs: pending.outputs, analysis: pending.analysis,
            summaryMarkdown: null, resultId: 'result_1', revision: 0, pendingIntent: 'generate',
        });
    });

    it('completes the requested output while its retained run remains running and other coverage remains incomplete', () => {
        const output = { ...pending, comparison: { ...comparison, inventory: { ...comparison.inventory, state: 'incomplete', reasons: ['missing page'] } },
            outputs: { walkthrough: { state: 'complete', value: { title: 'Walkthrough', intro: '', stops: [], otherChangeRefs: ['change_1'] } } },
        } satisfies ScmDiffSummaryGenerateSuccess;
        expect(selectScmDiffSummaryViewModel(observe(output), 'progressive')).toMatchObject({
            status: 'succeeded', comparison: output.comparison, analysis: pending.analysis, pendingIntent: null,
            latestRun: { status: 'running', retentionPolicy: 'resumable' },
        });
    });

    it('retains inventory and partial prose when generation fails and no structured snapshot follows', () => {
        let state = observe({ ...pending, outputs: { walkthrough: { state: 'partial', value: { title: 'Partial', intro: '', stops: [], otherChangeRefs: ['change_1'] } } } });
        state = applyScmDiffSummaryEvent(state, { type: 'run_snapshot', key: 'progressive',
            run: { ...runningRun(), status: 'failed', error: { message: 'Provider lost', code: 'MODEL_UNAVAILABLE' } },
            structuredOutput: { success: false, error: 'Provider lost', errorCode: 'MODEL_UNAVAILABLE', comparison,
                sourceKey: comparison.id, requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'failed' } }, analysis: pending.analysis },
            observedAtMs: 140,
        });
        state = applyScmDiffSummaryEvent(state, { type: 'run_snapshot', key: 'progressive', run: { ...runningRun(), status: 'failed' }, observedAtMs: 150 });
        expect(selectScmDiffSummaryViewModel(state, 'progressive')).toMatchObject({ status: 'failed', comparison, analysis: pending.analysis, isPartial: true,
            outputs: { walkthrough: { state: 'failed', value: { title: 'Partial' } } },
        });
    });

    it('keeps completed output readable when a later discussion run fails', () => {
        const complete = { ...pending, outputs: { walkthrough: { state: 'complete', value: { title: 'Saved', intro: '', stops: [], otherChangeRefs: ['change_1'] } } } } satisfies ScmDiffSummaryGenerateSuccess;
        let state = observe(complete);
        state = applyScmDiffSummaryEvent(state, { type: 'run_snapshot', key: 'progressive', run: { ...runningRun(), status: 'failed' }, observedAtMs: 150 });
        expect(selectScmDiffSummaryViewModel(state, 'progressive')).toMatchObject({ status: 'succeeded', outputs: complete.outputs, error: null });
    });

    it('keeps last-known prose visible while the newly admitted comparison is pending', () => {
        let state = applyScmDiffSummaryEvent(createInitialScmDiffSummaryState(), { type: 'cache_hit', key: 'summary-key', sessionId: 'session_1',
            actionId: 'scm.diffSummary.generate', input, output: finalSummary, observedAtMs: 100 });
        state = applyScmDiffSummaryEvent(state, { type: 'request_started', key: 'summary-key', sessionId: 'session_1',
            actionId: 'scm.diffSummary.generate', input, runId: 'run_2', structuredOutput: { ...pending, requestedOutputs: ['summary'], outputs: { summary: { state: 'pending' } } },
            requestedAtMs: 120, intent: 'regenerate' });
        expect(selectScmDiffSummaryViewModel(state, 'summary-key')).toMatchObject({ status: 'running', summaryMarkdown: finalSummary.summaryMarkdown, isShowingLastKnownSummary: true, comparison });
    });

    it('does not let a previous run snapshot replace a newly admitted request', () => {
        let state = observe(pending);
        state = applyScmDiffSummaryEvent(state, { type: 'request_started', key: 'progressive', sessionId: 'session_1',
            actionId: 'scm.diffSummary.generate', input: { ...input, outputs: ['walkthrough'] }, runId: 'run_2',
            structuredOutput: { ...pending, runId: 'run_2' }, requestedAtMs: 140, intent: 'regenerate' });
        const current = state;
        state = applyScmDiffSummaryEvent(state, { type: 'run_snapshot', key: 'progressive', run: runningRun('run_1'), structuredOutput: finalSummary, observedAtMs: 150 });
        expect(state).toBe(current);
        expect(selectScmDiffSummaryViewModel(state, 'progressive')).toMatchObject({ executionRunId: 'run_2', status: 'running' });
    });

    it('keys requests by canonical source, requested output and model analysis identity', () => {
        const key = (request: ScmDiffSummaryGenerateInput) => buildScmDiffSummaryRequestKey({ sessionId: 'session_1', input: request, resolvedSelector: { catalogId: 'agent:catalog' } });
        const branch = { cwd: '/repo', source: { kind: 'branch', head: 'feature', base: 'main' } } satisfies ScmDiffSummaryGenerateInput;
        expect(key(branch)).toContain(buildScmComparisonSourceKey(branch));
        expect(key(branch)).not.toBe(key({ ...branch, source: { ...branch.source, base: 'release' } }));
        expect(key(input)).not.toBe(key({ ...input, outputs: ['walkthrough'] }));
        expect(key({ ...input, modelSelector: { modelId: 'model_a' } })).not.toBe(key({ ...input, modelSelector: { modelId: 'model_b' } }));
        expect(key({ ...input, outputs: ['summary', 'walkthrough'] })).toBe(key({ ...input, outputs: ['walkthrough', 'summary'] }));
    });
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
