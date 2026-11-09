import { normalizeScmOperationOutcome, ScmFollowupActionSchema, type ScmOperationErrorCode, type ScmOperationOutcome, type ScmPullRequestOpenOrReuseResponse, type ScmPullRequestSummary } from '@happier-dev/protocol/scm';

export type ScmCreatePrResult =
    | Readonly<{ kind: 'created' | 'reused'; number?: number; url: string; pullRequest: ScmPullRequestSummary; outcome?: ScmOperationOutcome }>
    | Readonly<{ kind: 'provider-page'; url: string; outcome?: ScmOperationOutcome }>
    | Readonly<{ kind: 'failed'; errorCode: ScmOperationErrorCode; message: string; outcome?: ScmOperationOutcome }>;

export function selectScmCreatePrResult(response: ScmPullRequestOpenOrReuseResponse, _machineReachable: boolean): ScmCreatePrResult {
    const outcome = normalizeScmOperationOutcome(response);
    if (response.success && response.pullRequest && outcome.kind === 'succeeded') {
        return {
            kind: response.reused ? 'reused' : 'created',
            ...(response.pullRequest.number ? { number: response.pullRequest.number } : {}),
            url: response.pullRequest.url,
            pullRequest: response.pullRequest,
            outcome,
        };
    }
    const nextAction = ScmFollowupActionSchema.safeParse(response.nextAction).data;
    const composeUrl = response.composeUrl
        ?? (nextAction?.kind === 'openUrl' && nextAction.purpose === 'compose' ? nextAction.url : undefined);
    if (composeUrl && (response.success || response.result === 'opened_compose')) {
        return { kind: 'provider-page', url: composeUrl, outcome: response.outcome?.kind === 'needs_input' ? response.outcome : {
            v: 1, kind: 'needs_input', errorCode: !response.success && response.errorCode ? response.errorCode : 'FEATURE_UNSUPPORTED', nextActions: [{ kind: 'open_url', url: composeUrl }],
        } };
    }
    const failure = outcome.kind === 'succeeded'
        ? normalizeScmOperationOutcome({ success: false, errorCode: 'COMMAND_FAILED', error: 'The provider did not return a pull request or compose page' })
        : outcome;
    return { kind: 'failed', outcome: failure, errorCode: 'errorCode' in failure && failure.errorCode ? failure.errorCode : 'COMMAND_FAILED', message: failure.message ?? (!response.success ? response.error : '') };
}
