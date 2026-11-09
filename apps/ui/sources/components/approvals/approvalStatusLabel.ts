import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { ToolCall } from '@happier-dev/session-core/messages';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { t } from '@/text';
import { readConfidentialFillSettlement } from './confidentialSecretApprovalModel';

/** The request lifecycle uses the same words in its detail and retained tab. */
export function formatApprovalStatusLabel(status: string): string {
    switch (status) {
        case 'open': return t('approvals.status.open');
        case 'approved': return t('approvals.status.approved');
        case 'executing': return t('approvals.status.executing');
        case 'rejected': return t('approvals.status.rejected');
        case 'executed': return t('approvals.status.executed');
        case 'failed': return t('approvals.status.failed');
        case 'outcome_unknown': return t('automations.detail.runMeta.dispatchState.outcomeUnknown');
        case 'canceled': return t('approvals.status.canceled');
        case 'not_entered': return t('approvals.status.notEntered');
        default: return status;
    }
}

/** A person's decision keeps the request's vocabulary when projected into an Action result. */
export function formatApprovalDecisionFailureLabel(code: string): string | null {
    if (code === 'approval_rejected') return formatApprovalStatusLabel('rejected');
    if (code === 'approval_canceled') return formatApprovalStatusLabel('canceled');
    return null;
}

/** Shell permissions retain the same decision vocabulary as Action approvals. */
export function formatToolPermissionDecisionLabel(permission: ToolCall['permission']): string | null {
    if (permission?.status === 'canceled') return formatApprovalStatusLabel('canceled');
    if (permission?.status !== 'denied') return null;
    const actor = permission.decisionActor?.kind;
    if (actor !== 'accountUser' && actor !== 'externalHuman') return null;
    return formatApprovalStatusLabel(permission.decision === 'abort' ? 'canceled' : 'rejected');
}

/** A native answer reads as the exact offered label that was applied, never a normalized decision word. */
export function resolveNativePermissionAnswer(permission: ToolCall['permission']): Readonly<{ label: string; refused: boolean }> | null {
    const chosen = permission?.nativeChoice;
    if (!chosen || permission.status === 'pending' || permission.status === 'canceled') return null;
    const choice = permission.nativeChoices?.choices.find(candidate => candidate.id === chosen.choiceId);
    if (!choice) return null;
    return { label: choice.label, refused: choice.decision === 'denied' || choice.decision === 'abort' };
}

/**
 * The status a request reads as: an executed receipt whose Action refused its effect is Failed,
 * and a confidential entry reads as what became of the entry. The detail page and the retained tab
 * both read it, so they cannot disagree. Pass a failure the caller already read to avoid reading it twice.
 */
export function resolveApprovalDisplayStatus(
    request: ApprovalRequest,
    failure: ReturnType<typeof readApprovalExecutionFailure> = readApprovalExecutionFailure(request),
): string {
    if (request.status === 'outcome_unknown') return request.status;
    const fill = readConfidentialFillSettlement(request);
    if (fill && fill.status !== 'filled') {
        return fill.status === 'refused' ? 'not_entered' : fill.status === 'unknown' ? 'outcome_unknown' : 'canceled';
    }
    return failure ? 'failed' : request.status;
}

/** The tab's status: from the loaded request when this device holds its body, else the stored header's. */
export function readApprovalArtifactDisplayStatus(artifact: Pick<DecryptedArtifact, 'header' | 'body'>): string | null {
    const parsed = typeof artifact.body === 'string'
        ? approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body) : null;
    if (parsed?.family === 'built_in') return resolveApprovalDisplayStatus(parsed.request);
    return typeof artifact.header?.approvalStatus === 'string' ? artifact.header.approvalStatus : null;
}
