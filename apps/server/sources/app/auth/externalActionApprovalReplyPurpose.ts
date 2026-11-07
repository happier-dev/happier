import { SessionMessageReplyAccountMutationV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { ExternalActionApprovalDecisionAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';

/** Non-publishing settlement performed by the installed approval decision owner. */
export function isExternalActionApprovalReplyPurpose(input: Readonly<{
    actionId: string; method: string; path: string; body?: unknown;
    admission?: ExternalActionApprovalDecisionAdmissionV1;
}>): boolean {
    if (input.actionId !== 'approval.request.decide' || input.method.toUpperCase() !== 'POST') return false;
    const url = new URL(input.path, 'http://home.invalid');
    if (url.search !== '' || url.hash !== ''
        || !/^\/v2\/sessions\/[^/]+\/messages\/by-local-id\/[^/]+\/reply$/u.test(url.pathname)) return false;
    const mutation = SessionMessageReplyAccountMutationV1Schema.safeParse(input.body);
    const admission = input.admission;
    if (!mutation.success || !admission) return false;
    if (mutation.data.kind === 'discussion_review') {
        return admission.decision !== 'approve' && mutation.data.decision === admission.decision;
    }
    if (mutation.data.kind !== 'discussion_publication'
        || mutation.data.approvalArtifactId !== admission.artifactId
        || mutation.data.publication.kind !== 'failed') return false;
    const failure = mutation.data.publication.failure;
    if (admission.decision === 'approve') {
        return failure.code !== 'approval_rejected' && failure.code !== 'approval_canceled';
    }
    return failure.code === (admission.decision === 'reject' ? 'approval_rejected' : 'approval_canceled')
        && failure.phase === 'action_admission' && failure.retryable === false;
}
