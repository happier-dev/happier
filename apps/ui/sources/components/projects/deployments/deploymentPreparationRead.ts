import type { Message } from '@happier-dev/session-core/messages';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { SessionDisplayIdentity } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { readSessionWorkStateV1FromMetadata, type SessionWorkStateV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';
import { isScmPublicationActionIdV1,
    SCM_PULL_REQUEST_OPEN_OR_REUSE_ACTION_ID_V1, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ActionExecuteFailureSchema, isActionOutcomeUnknownErrorCodeV1,
    projectActionExecuteFailure, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ScmRemoteResponseSchema } from '@happier-dev/protocol/scm';
import { ScmPullRequestOpenOrReuseResponseSchema, ScmPullRequestSummarySchema,
    type ScmPullRequestSummary, type ScmPullRequestErrorResponse } from '@happier-dev/protocol/scm/pullRequests';
import { normalizeScmOperationOutcome, type ScmOperationOutcome } from '@happier-dev/protocol/scm/operationOutcome';
import { ScmOperationErrorCodeSchema } from '@happier-dev/protocol/scm/operationError';
import { isRecord, readHappierActionCallId, readHappierActionToolResultCandidates } from
    '@/components/sessions/transcript/references/happierActionToolResult';
import type { SessionPullRequestStatusResourceResultV1 } from '@happier-dev/triage-protocol/v1';

export type DeploymentPreparationPublication = Readonly<{
    messageId: string;
    actionId: ActionId;
    status: 'pending' | 'succeeded' | 'failed' | 'outcomeUnknown' | 'effectAppliedWithWarning' | 'cancelled' | 'unknown';
    outcome: ScmOperationOutcome | null;
    failure?: ActionExecuteFailure;
    remediation?: ScmPullRequestErrorResponse['remediation'];
    pullRequest: ScmPullRequestSummary | null;
    /** Only reported publication facts: token and unrelated metadata arrivals keep this key. */
    key: string;
}>;

export type DeploymentPreparationPullRequestRead = SessionPullRequestStatusResourceResultV1 | null;

export type DeploymentPreparationRead = Readonly<{
    phase: 'unknown' | 'session' | 'pullRequest' | 'publicationFailed' | 'unavailable';
    session: SessionAddress;
    agentId: string | null;
    machine: SessionDisplayIdentity | null;
    workState: SessionWorkStateV1 | null;
    publication: DeploymentPreparationPublication | null;
    pullRequests: DeploymentPreparationPullRequestRead;
    validation: Readonly<{ kind: 'unreported' }>;
}>;

/** Read the agent's recorded native Action results, never prose or a guessed checklist stage. */
export function readDeploymentPreparationPublication(messages: readonly Message[]): DeploymentPreparationPublication | null {
    let latest: DeploymentPreparationPublication | null = null;
    let latestAt = -Infinity;
    const visit = (message: Message) => {
        if (message.kind !== 'tool-call') return;
        const actionId = readHappierActionCallId(message.tool.name, message.tool.input);
        if (actionId && isScmPublicationActionIdV1(actionId)) {
            const facts: Omit<DeploymentPreparationPublication, 'key'> = {
                messageId: message.id, actionId, status: message.tool.state === 'running' ? 'pending' : 'unknown',
                outcome: null, pullRequest: null,
            };
            let reported = facts;
            for (const raw of readHappierActionToolResultCandidates(message.tool.result, message.tool.input)) {
                const failure = ActionExecuteFailureSchema.safeParse(raw);
                if (failure.success) {
                    const errorCode = ScmOperationErrorCodeSchema.safeParse(failure.data.errorCode);
                    const details = failure.data.details;
                    const committedPr = actionId === SCM_PULL_REQUEST_OPEN_OR_REUSE_ACTION_ID_V1
                        && isRecord(details) && details.scmEffectCommitted === true
                        ? ScmPullRequestSummarySchema.safeParse(details.pullRequest) : null;
                    if (committedPr?.success) {
                        const pullRequest = committedPr.data;
                        reported = { ...facts, status: 'effectAppliedWithWarning', failure: failure.data, pullRequest,
                            outcome: { v: 1, kind: 'effect_applied_with_warning',
                                errorCode: errorCode.success ? errorCode.data : 'COMMAND_FAILED',
                                effect: { kind: 'pull_request', url: pullRequest.url,
                                    ...(typeof pullRequest.number === 'number' ? { number: pullRequest.number } : {}) }, nextActions: [] } };
                    } else {
                        reported = { ...facts,
                            status: isActionOutcomeUnknownErrorCodeV1(failure.data.errorCode) ? 'outcomeUnknown' : 'failed',
                            failure: failure.data,
                            outcome: errorCode.success ? normalizeScmOperationOutcome({ success: false,
                                errorCode: errorCode.data }) : null };
                    }
                    break;
                }
                const value = isRecord(raw) && raw.ok === true ? raw.result : raw;
                const prParsed = actionId === SCM_PULL_REQUEST_OPEN_OR_REUSE_ACTION_ID_V1
                    ? ScmPullRequestOpenOrReuseResponseSchema.safeParse(value) : null;
                const parsed = prParsed ?? ScmRemoteResponseSchema.safeParse(value);
                if (!parsed.success) continue;
                const result = parsed.data;
                const prFailure = prParsed?.success && !prParsed.data.success ? prParsed.data : null;
                const outcome = normalizeScmOperationOutcome(result);
                reported = { ...facts, status: outcome.kind === 'outcome_unknown' ? 'outcomeUnknown'
                    : outcome.kind === 'effect_applied_with_warning' ? 'effectAppliedWithWarning'
                        : outcome.kind === 'cancelled' ? 'cancelled' : outcome.kind === 'succeeded' ? 'succeeded' : 'failed',
                    outcome,
                    pullRequest: prParsed?.success && prParsed.data.success ? prParsed.data.pullRequest ?? null : null,
                    ...(!result.success ? { failure: projectActionExecuteFailure({ ok: false,
                        errorCode: result.errorCode ?? 'COMMAND_FAILED', error: result.error ?? result.errorCode ?? 'COMMAND_FAILED',
                        ...(prFailure?.failureCause ? { failureCause: prFailure.failureCause } : {}) }),
                        ...(prFailure?.remediation ? { remediation: prFailure.remediation } : {}) } : {}),
                };
                break;
            }
            const publication = { ...reported, key: JSON.stringify(reported) };
            if (message.createdAt >= latestAt) { latestAt = message.createdAt; latest = publication; }
        }
        for (const child of message.children) visit(child);
    };
    for (const message of messages) visit(message);
    return latest;
}

export function projectDeploymentPreparationRead(input: Readonly<{
    session: SessionAddress;
    agentId?: string | null;
    machine?: SessionDisplayIdentity | null;
    ownerMetadata: unknown;
    messages: readonly Message[];
    pullRequests?: DeploymentPreparationPullRequestRead;
}>): DeploymentPreparationRead {
    const workState = readSessionWorkStateV1FromMetadata(input.ownerMetadata);
    const publication = readDeploymentPreparationPublication(input.messages);
    const pullRequests = input.pullRequests ?? null;
    const phase = publication?.status === 'failed' ? 'publicationFailed'
        : pullRequests?.kind === 'ready' && pullRequests.pullRequests.length > 0 ? 'pullRequest'
            : workState || publication ? 'session' : pullRequests?.kind === 'unavailable' ? 'unavailable' : 'unknown';
    return { phase, session: input.session, agentId: input.agentId ?? null, machine: input.machine ?? null,
        workState, publication, pullRequests, validation: { kind: 'unreported' } };
}
