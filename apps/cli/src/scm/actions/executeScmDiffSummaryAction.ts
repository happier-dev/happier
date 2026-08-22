import {
    ExecutionRunStartResponseSchema,
    ScmDiffSummaryGenerateOutputSchema,
    readExecutionRunStartRunCreation,
    type ActionExecuteResult,
    type BackendTargetRefV2,
    type ScmDiffSummaryGenerateInput,
    type ScmDiffSummaryGenerateOutput,
} from '@happier-dev/protocol';

type ExecuteCanonicalAction = (
    actionId: 'execution.run.start' | 'execution.run.get',
    input: unknown,
) => Promise<ActionExecuteResult>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : {};
}

function failure(
    input: ScmDiffSummaryGenerateInput,
    errorCode: 'TURN_CHANGE_SET_REQUIRED' | 'MODEL_UNAVAILABLE' | 'SUMMARY_FAILED',
    error: string,
): ScmDiffSummaryGenerateOutput {
    const turnId = input.turnId?.trim() || 'unknown-turn';
    const receiptId = input.checkpointReceiptId?.trim() || 'unknown-receipt';
    return ScmDiffSummaryGenerateOutputSchema.parse({
        success: false,
        error,
        errorCode,
        sourceKey: input.source.kind === 'turnCheckpoint'
            ? `turnCheckpoint:${turnId}:${receiptId}`
            : `workingTree:${input.cwd}`,
        ...(input.checkpointReceiptId ? { checkpointReceiptId: input.checkpointReceiptId } : {}),
    });
}

function readBufferedOutput(value: unknown): ScmDiffSummaryGenerateOutput | null {
    const resultRecord = readRecord(value);
    const candidates = [
        resultRecord.latestToolResult,
        readRecord(resultRecord.structuredMeta).payload,
    ];
    for (const candidate of candidates) {
        const parsed = ScmDiffSummaryGenerateOutputSchema.safeParse(candidate);
        if (parsed.success) return parsed.data;
    }
    return null;
}

function observationFailureMessage(code: string): string {
    switch (code) {
        case 'cancelled':
            return 'Diff-summary execution run observation was cancelled';
        case 'timeout':
            return 'Diff-summary execution run observation deadline elapsed before terminal output';
        default:
            return `Diff-summary execution run observation failed: ${code}`;
    }
}

/** Thin Action adapter over the canonical scm_diff_summary.v1 execution-run profile. */
export async function executeScmDiffSummaryAction(params: Readonly<{
    request: ScmDiffSummaryGenerateInput;
    backendTarget: BackendTargetRefV2 | null;
    executeCanonicalAction: ExecuteCanonicalAction;
}>): Promise<ScmDiffSummaryGenerateOutput> {
    if (params.request.source.kind === 'turnCheckpoint') {
        return failure(
            params.request,
            'TURN_CHANGE_SET_REQUIRED',
            'TurnChangeSet evidence is required for checkpoint-backed diff summaries',
        );
    }
    if (!params.backendTarget) {
        return failure(params.request, 'MODEL_UNAVAILABLE', 'Diff-summary model target is unavailable');
    }

    const modelSelector = readRecord(params.request.modelSelector);
    const startResult = await params.executeCanonicalAction('execution.run.start', {
        kind: 'scm_diff_summary.v1',
        intent: 'scm_diff_summary',
        backendTarget: params.backendTarget,
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        ...(typeof modelSelector.profileId === 'string' ? { profileId: modelSelector.profileId } : {}),
        ...(typeof modelSelector.modelId === 'string' ? { modelId: modelSelector.modelId } : {}),
        intentInput: params.request,
        waitForCompletion: true,
    });
    if (!startResult.ok) {
        return readExecutionRunStartRunCreation(startResult.details) === 'noRunCreated'
            ? failure(params.request, 'MODEL_UNAVAILABLE', startResult.error)
            : failure(params.request, 'SUMMARY_FAILED', 'Diff-summary execution run start outcome is unknown');
    }
    const started = ExecutionRunStartResponseSchema.safeParse(startResult.result);
    if (!started.success) {
        return failure(params.request, 'SUMMARY_FAILED', 'Diff-summary execution run did not return a run id');
    }
    if (!started.data.wait) {
        return failure(params.request, 'SUMMARY_FAILED', 'Diff-summary execution run did not return an observation result');
    }
    if (!started.data.wait.ok) {
        return failure(params.request, 'SUMMARY_FAILED', observationFailureMessage(started.data.wait.code));
    }

    const outputResult = await params.executeCanonicalAction('execution.run.get', {
        runId: started.data.runId,
        includeStructured: true,
    });
    if (!outputResult.ok) {
        return failure(params.request, 'SUMMARY_FAILED', outputResult.error);
    }
    return readBufferedOutput(outputResult.result)
        ?? failure(params.request, 'SUMMARY_FAILED', 'Diff-summary execution run returned no buffered output');
}
