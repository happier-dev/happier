import { describe, expect, it, vi } from 'vitest';
import type { ExecutionRunPublicState, ScmComparison, ScmDiffSummaryGenerateInput, ScmDiffSummaryGenerateOutput, ScmDiffSummaryGenerateSuccess, TurnChangeSet } from '@happier-dev/protocol';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends';
import { createScmDiffSummaryOperations, getScmDiffSummaryOperationState, type ScmDiffSummaryGenerateRpc } from './generate';

// Execution-run RPCs are network boundaries; keep all domain and envelope logic real.
vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunGet: vi.fn(),
}));

const input = { cwd: '/repo', source: { kind: 'turnCheckpoint' }, turnId: 'turn_1', checkpointReceiptId: 'receipt_1' } satisfies ScmDiffSummaryGenerateInput;
const backendTarget = { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' } as const;
const turnChangeSet = {
    sessionId: 'session_1', turnId: 'turn_1', seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 }, status: 'completed',
    files: [{ filePath: 'src/a.ts', changeKind: 'modified', source: 'scm_checkpoint', confidence: 'exact', provider: 'checkpoint', unifiedDiff: 'fabricated client bytes' }],
    provider: 'checkpoint', derivedAt: 100,
    repositoryCheckpoint: { version: 1, scopeId: 'scope-1', baseRefSource: 'turn_start', contentConfidence: 'exact', attributionScope: 'shared_worktree',
        receipts: [{ id: 'checkpoint.diff_computed', ref: 'refs/happier/checkpoints/1' }] },
} satisfies TurnChangeSet;
const comparison = {
    id: 'comparison_1', source: input.source, repository: { rootPath: '/repo' }, endpoints: { before: 'before', after: 'after' },
    inventory: { state: 'complete', files: [], reasons: [] },
} satisfies ScmComparison;
const pending = {
    success: true, sourceKey: comparison.id, metadata: { source: input.source, sourceKey: comparison.id }, comparison,
    requestedOutputs: ['summary'], outputs: { summary: { state: 'pending' } },
    analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] }, runId: 'run_1', resultId: 'result_1', revision: 0,
} satisfies ScmDiffSummaryGenerateSuccess;
const complete = { ...pending, outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Host summary', risks: ['No tests were run.'] } } } } satisfies ScmDiffSummaryGenerateSuccess;
const run = {
    runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1', intent: 'scm_diff_summary', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 100,
} satisfies ExecutionRunPublicState;
const params = { sessionId: 'session_1', backendTarget, input, turnChangeSet };
const finalCheckpointParams = { ...params,
    input: { ...input, checkpointReceiptId: 'checkpoint.finalized' },
    turnChangeSet: { ...turnChangeSet, repositoryCheckpoint: { ...turnChangeSet.repositoryCheckpoint,
        startRef: 'refs/happier/checkpoints/start', finalRef: 'refs/happier/checkpoints/final',
        receipts: [{ id: 'checkpoint.finalized', phase: 'turn-final', ref: 'refs/happier/checkpoints/final' }],
    } },
    settings: { 'scm.diffSummary.prefetch': true },
} satisfies Parameters<ReturnType<typeof createScmDiffSummaryOperations>['prefetch']>[0];

describe('SCM diff summary operations', () => {
    it('rejects an explicitly unsupported stored choice without silently admitting the caller default', async () => {
        const generate = vi.fn<ScmDiffSummaryGenerateRpc>(async () => pending);
        const ops = createScmDiffSummaryOperations({ generateSummary: generate });
        const result = await ops.generateFromUserAction({ ...params,
            settings: { 'scm.diffSummary.modelProfileOverride': 'unsupported-profile' },
            catalogProfiles: [{ catalogId: 'unsupported-profile', title: 'Unavailable model', structuredOutput: 'unsupported' }],
        });
        expect(result).toMatchObject({ ok: false, errorCode: 'model_structured_output_unsupported' });
        expect(generate).not.toHaveBeenCalled();
    });
    it('consumes the shared picker preference as a canonical model selector rather than a raw backend key', async () => {
        const generate = vi.fn<ScmDiffSummaryGenerateRpc>(async () => pending);
        const ops = createScmDiffSummaryOperations({ generateSummary: generate });
        await ops.generateFromUserAction({ ...params, settings: { 'scm.diffSummary.modelProfileOverride':
            'model:{"backendTargetKey":"agent:happier.agent.codex/codex","modelId":"catalog-model"}' } });
        expect(generate.mock.calls[0]?.[1]?.modelSelector).toMatchObject({ backendTargetKey: 'agent:happier.agent.codex/codex', modelId: 'catalog-model' });
    });
    it('reopens a machine-saved result in its exact Account without admitting a model', () => {
        const generate = vi.fn<ScmDiffSummaryGenerateRpc>(async () => pending);
        const ops = createScmDiffSummaryOperations({ generateSummary: generate });
        const scope = { serverId: 'home', accountId: 'account' };
        const result = { resultId: 'result_1', revision: 3, canUndo: true, output: { ...complete, revision: 3 } };
        const key = ops.loadSavedResult({ sessionId: 'session_1', scope, result });
        expect(key).not.toBeNull();
        expect(getScmDiffSummaryOperationState(ops.getState(), key!)).toMatchObject({ resultId: 'result_1', revision: 3, savedResult: result });
        expect(generate).not.toHaveBeenCalled();
        const otherScope = { serverId: 'home', accountId: 'other-account' };
        const otherKey = ops.loadSavedResult({ sessionId: 'session_1', scope: otherScope, result });
        ops.deleteSavedResults(scope, ['result_1']);
        expect(ops.getState().entriesByKey[key!]).toBeUndefined();
        expect(ops.getState().entriesByKey[otherKey!]).toBeDefined();
        ops.retireScope(scope);
        expect(Object.keys(ops.getState().entriesByKey)).toEqual([otherKey]);
    });
    it('does not notify readers for identical saved-result echoes but publishes same-revision progress', () => {
        const ops = createScmDiffSummaryOperations();
        const scope = { serverId: 'home', accountId: 'account' };
        const result = { resultId: 'result_1', revision: 3, canUndo: true, output: { ...complete, revision: 3 } };
        const key = ops.loadSavedResult({ sessionId: 'session_1', scope, result })!;
        const original = ops.getState();
        const notifications = vi.fn();
        const unsubscribe = ops.subscribe(notifications);
        try {
            for (let index = 0; index < 10; index += 1) ops.applySavedResult(key, structuredClone(result));
            expect(notifications).not.toHaveBeenCalled();
            expect(ops.getState()).toBe(original);
            ops.applySavedResult(key, { ...result, canUndo: false });
            expect(notifications).toHaveBeenCalledTimes(1);
            expect(getScmDiffSummaryOperationState(ops.getState(), key).savedResult?.canUndo).toBe(false);
            ops.applySavedResult(key, { ...result, revision: 4, output: { ...result.output, revision: 4 } });
            expect(notifications).toHaveBeenCalledTimes(2);
            expect(getScmDiffSummaryOperationState(ops.getState(), key).revision).toBe(4);
        } finally {
            unsubscribe();
        }
    });
    it('does not publish a late admission after its captured Account has retired', async () => {
        let current = true;
        let resolve!: (output: ScmDiffSummaryGenerateOutput) => void;
        const ops = createScmDiffSummaryOperations({ generateSummary: () => new Promise((done) => { resolve = done; }) });
        const admission = ops.generateFromUserAction({ ...params, shouldContinue: () => current });
        current = false;
        resolve(pending);
        expect(await admission).toMatchObject({ ok: false, errorCode: 'SCM_DIFF_SUMMARY_SCOPE_RETIRED' });
        expect(ops.getState()).toEqual({ entriesByKey: {} });
    });
    it('captures Files evidence independently of disabled narration without admitting a model run', async () => {
        const capture = vi.fn(async () => ({ success: true as const, comparison, metadata: pending.metadata }));
        const generate = vi.fn<ScmDiffSummaryGenerateRpc>(async () => pending);
        const ops = createScmDiffSummaryOperations({ captureComparison: capture, generateSummary: generate });
        const result = await ops.captureComparison({ sessionId: 'session_1', input, serverId: ' server_1 ' });
        expect(result).toEqual({ success: true, comparison, metadata: pending.metadata });
        expect(capture).toHaveBeenCalledWith('session_1', { ...input, sessionId: 'session_1' }, { serverId: 'server_1' });
        expect(generate).not.toHaveBeenCalled();
        expect(ops.getState()).toEqual({ entriesByKey: {} });
    });
    it('withdraws late captured evidence when its Account or Session lifetime retires', async () => {
        let current = true;
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => { release = resolve; });
        const capture = vi.fn(async () => { await waiting; return { success: true as const, comparison, metadata: pending.metadata }; });
        const ops = createScmDiffSummaryOperations({ captureComparison: capture });
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        const controller = new AbortController();
        const request = { sessionId: 'session_1', input, scope, signal: controller.signal, shouldContinue: () => current };
        const result = ops.captureComparison(request);
        current = false;
        controller.abort();
        release();
        await expect(result).resolves.toMatchObject({ success: false, errorCode: 'SCM_DIFF_SUMMARY_SCOPE_RETIRED' });
        expect(capture).toHaveBeenCalledWith('session_1', { ...input, sessionId: 'session_1' }, { scope, signal: controller.signal });
        capture.mockClear();
        await expect(ops.captureComparison(request)).resolves.toMatchObject({ success: false, errorCode: 'SCM_DIFF_SUMMARY_SCOPE_RETIRED' });
        expect(capture).not.toHaveBeenCalled();
    });
    it('calls the authenticated generate Action and exposes inventory before prose without forwarding client evidence', async () => {
        const generate = vi.fn<ScmDiffSummaryGenerateRpc>(async () => pending);
        const ops = createScmDiffSummaryOperations({ generateSummary: generate, nowMs: () => 100 });
        const result = await ops.generateFromUserAction({ ...params, key: 'summary-key', serverId: ' server_1 ' });
        expect(generate).toHaveBeenCalledWith('session_1', {
            ...input, sessionId: 'session_1', modelSelector: { backendTargetKey: buildBackendTargetKeyV2(backendTarget) },
        }, { serverId: 'server_1' });
        expect(result).toMatchObject({ ok: true, runId: 'run_1', viewModel: {
            status: 'running', executionRunId: 'run_1', comparison, outputs: pending.outputs, resultId: 'result_1', summaryMarkdown: null,
        } });
    });

    it('preserves caller model selection and includes it in analysis identity', async () => {
        const generate = vi.fn<ScmDiffSummaryGenerateRpc>(async () => pending);
        const ops = createScmDiffSummaryOperations({ generateSummary: generate });
        const first = await ops.generateFromUserAction({ ...params, input: { ...input, modelSelector: { profileId: 'chosen', modelId: 'model_a' } } });
        const second = await ops.generateFromUserAction({ ...params, input: { ...input, modelSelector: { profileId: 'chosen', modelId: 'model_b' } } });
        expect(first.key).not.toBe(second.key);
        expect(generate.mock.calls[0]?.[1]).toMatchObject({ modelSelector: { profileId: 'chosen', modelId: 'model_a', backendTargetKey: buildBackendTargetKeyV2(backendTarget) } });
    });

    it('decodes retained run publication through the protocol envelope without waiting for run termination', async () => {
        const get = vi.fn(async () => ({ run, structuredMeta: { kind: 'scm_diff_summary.v1', payload: complete } }));
        const ops = createScmDiffSummaryOperations({ generateSummary: async () => pending, getExecutionRun: get });
        const admitted = await ops.generateFromUserAction(params);
        const refreshed = await ops.refreshRun({ key: admitted.key, sessionId: 'session_1', runId: 'run_1' });
        expect(get).toHaveBeenCalledWith('session_1', { runId: 'run_1', includeStructured: true });
        expect(refreshed.viewModel).toMatchObject({ status: 'succeeded', summaryMarkdown: 'Host summary', risks: ['No tests were run.'], latestRun: { status: 'running' } });
    });

    it('retains authenticated comparison evidence when model admission fails', async () => {
        const failure = { ...pending, success: false, error: 'Model unavailable', errorCode: 'MODEL_UNAVAILABLE', outputs: { summary: { state: 'failed' } } } satisfies ScmDiffSummaryGenerateOutput;
        const ops = createScmDiffSummaryOperations({ generateSummary: async () => failure });
        expect(await ops.generateFromUserAction(params)).toMatchObject({ ok: false, errorCode: 'MODEL_UNAVAILABLE', viewModel: { status: 'failed', comparison, outputs: failure.outputs } });
    });

    it('rejects malformed structured publication without discarding the captured inventory', async () => {
        const get = vi.fn(async () => ({ run, structuredMeta: { kind: 'scm_diff_summary.v1', payload: { ...complete, comparison: { ...comparison, id: 'wrong' } } } }));
        const ops = createScmDiffSummaryOperations({ generateSummary: async () => pending, getExecutionRun: get });
        const admitted = await ops.generateFromUserAction(params);
        await ops.refreshRun({ key: admitted.key, sessionId: 'session_1', runId: 'run_1' });
        expect(getScmDiffSummaryOperationState(ops.getState(), admitted.key)).toMatchObject({ status: 'running', comparison, summaryMarkdown: null });
    });

    it('asks the host again before reusing completed evidence and never returns summary as walkthrough', async () => {
        const generate = vi.fn<ScmDiffSummaryGenerateRpc>(async () => pending);
        const ops = createScmDiffSummaryOperations({ generateSummary: generate, getExecutionRun: async () => ({ run, structuredMeta: { kind: 'scm_diff_summary.v1', payload: complete } }) });
        const first = await ops.generateFromUserAction(params);
        await ops.generateFromUserAction({ ...params, key: 'pending-again' });
        expect(generate).toHaveBeenCalledTimes(2);
        await ops.refreshRun({ key: first.key, sessionId: 'session_1', runId: 'run_1' });
        const nextComparison = { ...comparison, id: 'comparison_2', endpoints: { before: 'before', after: 'new_after' } };
        generate.mockResolvedValueOnce({ ...pending, comparison: nextComparison, sourceKey: nextComparison.id, metadata: { ...pending.metadata, sourceKey: nextComparison.id } });
        const refreshed = await ops.generateFromUserAction({ ...params, key: 'cached' });
        expect(refreshed.viewModel).toMatchObject({ status: 'running', comparison: nextComparison, summaryMarkdown: null });
        expect(generate).toHaveBeenCalledTimes(3);
        await ops.generateFromUserAction({ ...params, input: { ...input, outputs: ['walkthrough'] } });
        expect(generate).toHaveBeenCalledTimes(4);
    });

    it('keeps checkpoint refs and selectors separated and regenerates with canonical bypass policy', async () => {
        const generate = vi.fn<ScmDiffSummaryGenerateRpc>(async () => complete);
        const ops = createScmDiffSummaryOperations({ generateSummary: generate });
        await ops.generateFromUserAction({ ...params, resolvedSelector: { catalogId: 'profile:first' } });
        await ops.generateFromUserAction({ ...params, turnChangeSet: { ...turnChangeSet, repositoryCheckpoint: { ...turnChangeSet.repositoryCheckpoint, receipts: [{ id: 'checkpoint.diff_computed', ref: 'refs/happier/checkpoints/2' }] } }, resolvedSelector: { catalogId: 'profile:first' } });
        await ops.generateFromUserAction({ ...params, resolvedSelector: { catalogId: 'profile:second' } });
        await ops.generateFromUserAction({ ...params, intent: 'regenerate', resolvedSelector: { catalogId: 'profile:first' } });
        expect(generate).toHaveBeenCalledTimes(4);
        expect(generate.mock.calls[3]?.[1]).toMatchObject({ cachePolicy: { mode: 'bypass' } });
    });

    it('prunes checkpoint projections through the existing cleanup owner', async () => {
        const generate = vi.fn<ScmDiffSummaryGenerateRpc>(async () => complete);
        const ops = createScmDiffSummaryOperations({ generateSummary: generate });
        await ops.generateFromUserAction(params);
        expect(ops.applyCheckpointCleanupReceipt({ id: 'checkpoint.cleanup_pruned', refs: ['refs/happier/checkpoints/1'], prunedCount: 1 })).toEqual({ prunedEntries: 1 });
        await ops.generateFromUserAction(params);
        expect(generate).toHaveBeenCalledTimes(2);
        await ops.generateFromUserAction({ ...params, turnChangeSet: { ...turnChangeSet, repositoryCheckpoint: { ...turnChangeSet.repositoryCheckpoint, receipts: [{ id: 'checkpoint.cleanup_pruned', refs: ['refs/happier/checkpoints/1'], prunedCount: 1 }] } } });
        expect(generate).toHaveBeenCalledTimes(3);
    });

    it('respects disabled generation and opt-in durable-checkpoint-only prefetch', async () => {
        const generate = vi.fn<ScmDiffSummaryGenerateRpc>(async () => pending);
        const ops = createScmDiffSummaryOperations({ generateSummary: generate });
        expect(await ops.generateFromUserAction({ ...params, settings: { 'scm.diffSummary.enabled': false } })).toMatchObject({ ok: false, errorCode: 'SCM_DIFF_SUMMARY_DISABLED' });
        expect(await ops.prefetch(params)).toMatchObject({ ok: false, errorCode: 'SCM_DIFF_SUMMARY_PREFETCH_DISABLED' });
        expect(await ops.prefetch({ ...params, input: { cwd: '/repo', source: { kind: 'workingTree' } }, settings: { 'scm.diffSummary.prefetch': true } })).toMatchObject({ ok: false, errorCode: 'SCM_DIFF_SUMMARY_PREFETCH_SOURCE_UNSUPPORTED' });
        expect(generate).not.toHaveBeenCalled();
        expect((await ops.prefetch(finalCheckpointParams)).ok).toBe(true);
    });

    it('admits a durable completed checkpoint only once across concurrent delivery and replay, with Account-scoped identity', async () => {
        let resolve!: (output: ScmDiffSummaryGenerateOutput) => void;
        const generate = vi.fn<ScmDiffSummaryGenerateRpc>(() => new Promise((done) => { resolve = done; }));
        const ops = createScmDiffSummaryOperations({ generateSummary: generate });
        const scoped = { ...finalCheckpointParams, scope: { serverId: 'home', accountId: 'account_a' } };
        const first = ops.prefetch(scoped);
        const concurrent = ops.prefetch(scoped);
        expect(generate).toHaveBeenCalledTimes(1);
        resolve(pending);
        const admitted = await first;
        expect(await concurrent).toEqual(admitted);
        expect(await ops.prefetch(scoped)).toMatchObject({ ok: true, key: admitted.key, runId: 'run_1' });
        expect(generate).toHaveBeenCalledTimes(1);
        const otherAccount = ops.prefetch({ ...scoped, scope: { serverId: 'home', accountId: 'account_b' } });
        expect(generate).toHaveBeenCalledTimes(2);
        resolve(pending);
        await otherAccount;
    });

    it('never prefetches interrupted turns, provider-only evidence, or arbitrary checkpoint receipts', async () => {
        const generate = vi.fn<ScmDiffSummaryGenerateRpc>(async () => pending);
        const ops = createScmDiffSummaryOperations({ generateSummary: generate });
        const invalid = [
            { ...finalCheckpointParams, turnChangeSet: { ...finalCheckpointParams.turnChangeSet, status: 'interrupted' as const } },
            { ...finalCheckpointParams, turnChangeSet: { ...turnChangeSet, repositoryCheckpoint: undefined } },
            { ...params, settings: finalCheckpointParams.settings },
            { ...finalCheckpointParams, turnChangeSet: { ...finalCheckpointParams.turnChangeSet, repositoryCheckpoint: {
                ...finalCheckpointParams.turnChangeSet.repositoryCheckpoint, receipts: [{ id: 'checkpoint.captured' as const, phase: 'turn-start' as const, ref: 'refs/happier/checkpoints/start' }],
            } } },
        ];
        for (const candidate of invalid) expect(await ops.prefetch(candidate)).toMatchObject({ ok: false, errorCode: 'SCM_DIFF_SUMMARY_PREFETCH_SOURCE_UNSUPPORTED' });
        expect(generate).not.toHaveBeenCalled();
    });
});
