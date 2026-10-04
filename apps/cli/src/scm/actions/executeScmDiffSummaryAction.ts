import {
    ExecutionRunStartResponseSchema,
    ScmDiffSummaryGenerateOutputSchema,
    readExecutionRunStartRunCreation,
    buildBackendTargetKeyV2,
    buildScmDiffSummaryCacheKey,
    SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION,
    type ActionExecuteResult,
    type BackendTargetRefV2,
    type ScmDiffSummaryGenerateInput,
    type ScmDiffSummaryGenerateOutput,
    type ScmDiffSummaryOutputKind,
    type ScmDiffSummaryOutputs,
} from '@happier-dev/protocol';

import { captureScmComparison, readCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import type { ReadRepositoryCheckpointTranscriptPage } from '@/scm/checkpoints/readRepositoryCheckpointTranscriptPage';
import type { ReadPullRequestComparisonPage } from '@/scm/comparisons/readPullRequestComparisonPage';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';

type ExecuteCanonicalAction = (
    actionId: 'execution.run.start',
    input: unknown,
) => Promise<ActionExecuteResult>;

/** Capture once at the host, then admit the canonical retained analysis run. */
export async function executeScmDiffSummaryAction(params: Readonly<{
    request: ScmDiffSummaryGenerateInput;
    sessionId?: string;
    readTranscriptPage?: ReadRepositoryCheckpointTranscriptPage;
    readPullRequestComparisonPage?: ReadPullRequestComparisonPage;
    backendTarget: BackendTargetRefV2 | null;
    executeCanonicalAction: ExecuteCanonicalAction;
    signal?: AbortSignal;
}>): Promise<ScmDiffSummaryGenerateOutput> {
    const sessionId = params.sessionId ?? params.request.sessionId;
    const captured = params.request.comparisonId ? await readCapturedScmComparison({
        cwd: params.request.cwd, comparisonId: params.request.comparisonId, source: params.request.source,
        ...(sessionId ? { sessionId } : {}),
        turnId: params.request.turnId, checkpointReceiptId: params.request.checkpointReceiptId,
        turnEvidenceMode: params.request.turnEvidenceMode,
    }) : await captureScmComparison({
        ...params.request,
        ...(sessionId ? { sessionId } : {}),
        ...(params.readTranscriptPage ? { readTranscriptPage: params.readTranscriptPage } : {}),
        ...(params.readPullRequestComparisonPage ? { readPullRequestComparisonPage: params.readPullRequestComparisonPage } : {}),
    });
    const requestedOutputs: readonly ScmDiffSummaryOutputKind[] = params.request.outputs ?? ['summary'];
    const selector = params.request.modelSelector;
    const key = buildScmDiffSummaryCacheKey({ source: { kind: 'comparison', comparisonId: captured.comparison.id },
        summarySchemaVersion: SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION, outputs: requestedOutputs, scopeKey: sessionId,
        resolvedSelector: { catalogId: JSON.stringify({ backendTargetKey: params.backendTarget ? buildBackendTargetKeyV2(params.backendTarget) : null,
            modelId: selector?.modelId ?? 'default', ...(selector?.profileId ? { profileId: selector.profileId } : {}) }) },
    });
    return scmDiffSummaryResultStore.admitGeneration({ cwd: params.request.cwd, ...(sessionId ? { sessionId } : {}), key, outputs: requestedOutputs,
        bypass: params.request.cachePolicy?.mode === 'bypass', ...(params.signal ? { signal: params.signal } : {}) }, async () => {
        const remainingChangeRefs = captured.comparison.inventory.files.flatMap(file => file.occurrences.map(occurrence => occurrence.id));
        const envelope = (state: 'pending' | 'failed', reason?: string, runId?: string): ScmDiffSummaryGenerateOutput => {
            const outputs: ScmDiffSummaryOutputs = {};
            for (const kind of requestedOutputs) outputs[kind] = { state, ...(reason ? { reason } : {}) };
            return ScmDiffSummaryGenerateOutputSchema.parse({
                success: true,
                sourceKey: captured.metadata.sourceKey,
                metadata: captured.metadata,
                comparison: captured.comparison,
                requestedOutputs,
                outputs,
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs },
                ...(captured.metadata.checkpointReceiptId ? { checkpointReceiptId: captured.metadata.checkpointReceiptId } : {}),
                ...(runId ? { runId } : {}),
            });
        };
        const saved = await scmDiffSummaryResultStore.create({ cwd: params.request.cwd,
            ...(sessionId ? { sessionId } : {}), output: envelope('pending'),
            ...(params.backendTarget ? { generator: { backendTarget: params.backendTarget,
                ...(selector?.profileId ? { profileId: selector.profileId } : {}),
                ...(selector?.modelId ? { modelId: selector.modelId } : {}) } } : {}),
        });
        const scope = { cwd: params.request.cwd, resultId: saved.resultId, ...(sessionId ? { sessionId } : {}) };
        const latestOutput = async (runId?: string): Promise<ScmDiffSummaryGenerateOutput> => {
            const latest = await scmDiffSummaryResultStore.read(scope);
            const output = latest.success ? latest.result.output : saved.output;
            return ScmDiffSummaryGenerateOutputSchema.parse({ ...output, ...(runId ? { runId } : {}) });
        };
        const failed = async (reason: string): Promise<ScmDiffSummaryGenerateOutput> => {
            // A concurrent manual edit or started/terminal publication owns the newer revision.
            await scmDiffSummaryResultStore.publishProgress({ ...scope, expectedRevision: saved.revision, output: envelope('failed', reason) });
            return latestOutput();
        };
        if (!params.backendTarget) return failed('Diff-summary model target is unavailable');
        if (!sessionId) return failed('Diff-summary generation requires a selected session');
        const startResult = await params.executeCanonicalAction('execution.run.start', {
            kind: 'scm_diff_summary.v1',
            intent: 'scm_diff_summary',
            backendTarget: params.backendTarget,
            permissionMode: 'read_only',
            retentionPolicy: 'resumable',
            runClass: 'long_lived',
            ioMode: 'streaming',
            ...(selector?.profileId ? { profileId: selector.profileId } : {}),
            ...(selector?.modelId ? { modelId: selector.modelId } : {}),
            // Only a host-owned saved evidence id crosses admission, never client diff bytes.
            intentInput: { ...params.request, sessionId, comparisonId: captured.comparison.id,
                resultId: saved.resultId, expectedRevision: saved.revision },
            waitForCompletion: false,
        }).catch(() => null);
        if (!startResult) return failed('Diff-summary execution run start outcome is unknown');
        if (!startResult.ok) {
            return failed(readExecutionRunStartRunCreation(startResult.details) === 'noRunCreated'
                ? startResult.error
                : 'Diff-summary execution run start outcome is unknown');
        }
        const started = ExecutionRunStartResponseSchema.safeParse(startResult.result);
        return started.success
            ? latestOutput(started.data.runId)
            : failed('Diff-summary execution run did not return a run id');
    });
}
