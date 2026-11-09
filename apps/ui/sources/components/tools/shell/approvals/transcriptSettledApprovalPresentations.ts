import type { ApprovalSettledPresentation } from '@/sync/domains/artifacts/approvalArtifacts';
import { presentsSettledResourceProposal } from '@/components/approvals/resourceProposal/readResourceProposalApproval';
import { readBrowserOpenAcceptance } from '@/sync/domains/browser/firstUse/browserFirstUse';
import { readCapabilityEnableApproval } from '@/components/sessions/capabilities/capabilityEnableApproval';
import { readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import { presentsApprovalVisualTranscriptOccurrence } from '@/components/approvals/approvalVisualTranscriptOccurrence';
import { readApprovedSavedSkillResult } from '@/components/tools/renderers/system/savedSkillResultModel';

/**
 * Approval bodies that keep rendering in the transcript after a decision (plan 60 AGW-8: a resource
 * proposal's receipt or declined line). Each entry is contributed by its body owner; module-stable so
 * the transcript projection keeps its selector identity.
 */
export const TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS: readonly ApprovalSettledPresentation[] = [
    // The Ask card is the visual's one transcript occurrence after replay; keep its live Artifact outcome here.
    presentsApprovalVisualTranscriptOccurrence,
    (approval) => readApprovedSavedSkillResult(approval) !== null,
    presentsSettledResourceProposal,
    // An Agent's enable request settles into its one line with Undo (P8 U8.5).
    (approval) => readCapabilityEnableApproval(approval) !== null,
    // An approved Browser open stays while its operation is still preparing, connecting or failed.
    (approval) => readBrowserOpenAcceptance(approval) !== null,
    // A declined request keeps its review at its originating call; failures retain their attention owner.
    (approval) => (approval.status === 'rejected' || approval.status === 'canceled')
        && approval.origin?.kind === 'transcript_tool_call',
];

/** Settled requests that remain actionable attention above the composer instead of moving rows. */
export const COMPOSER_SETTLED_APPROVAL_PRESENTATIONS: readonly ApprovalSettledPresentation[] = [
    (approval) => readApprovalExecutionFailure(approval) !== null,
];
