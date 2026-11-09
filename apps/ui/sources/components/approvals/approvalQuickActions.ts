import type { OpenApprovalInboxEntry } from '@/sync/domains/artifacts/approvalArtifactAdmission';
import { readActionApprovalReview } from './actionApprovalReview';

export type ApprovalQuickActions = Readonly<{
    artifactId: string;
    serverId: string;
    actionId: 'approval.request.decide';
    decisions: readonly ['reject', 'approve'];
}>;

/** Full private input and requester authority are required; a stored projection cannot authorize a shortcut. */
export function readApprovalQuickActions(
    entry: OpenApprovalInboxEntry | null,
    serverId: string,
    requesterMayDecide?: boolean,
): ApprovalQuickActions | null {
    if (!entry?.artifact.isDecrypted || !serverId || entry.parsed.family !== 'built_in' || entry.parsed.request.v !== 2) return null;
    const request = entry.strictReviewRequest;
    if (!request) return null;
    if (!readActionApprovalReview(request).simple) return null;
    if (request.requesterConfirmation && requesterMayDecide !== true) return null;
    return { artifactId: entry.artifact.id, serverId, actionId: 'approval.request.decide', decisions: ['reject', 'approve'] };
}
