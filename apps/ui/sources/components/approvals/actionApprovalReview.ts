import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { isProjectSetupTrustRequestV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { resolveApprovalRequestApproveAdmission, resolveApprovalVisualPreview,
    readPluginInstallApprovalPendingReview } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { isComputerApprovalAction } from './computerApprovalModel';
import { isConfidentialSecretApprovalAction, readConfidentialActionInputsApproval, readConfidentialSecretApproval } from './confidentialSecretApprovalModel';
import { readResourceProposalApproval } from './resourceProposal/readResourceProposalApproval';
import { readPromptDocUpdateApproval } from './promptDocApprovalModel';
import { readCapabilityEnableApproval } from '@/components/sessions/capabilities/capabilityEnableApproval';
import { readApprovalFileSource } from './approvalFileSource';
import { resolveActionConfirmVerb } from '@/text/actionTitles';

export type ActionApprovalReview = Readonly<{
    admission: ReturnType<typeof resolveApprovalRequestApproveAdmission> | null;
    confidentialAction: boolean;
    confidential: ReturnType<typeof readConfidentialSecretApproval>;
    /** Declared secret inputs the consuming Action is waiting for; chosen privately, never by plain Approve. */
    confidentialInputs: ReturnType<typeof readConfidentialActionInputsApproval>;
    capabilityEnable: ReturnType<typeof readCapabilityEnableApproval>;
    promptDocUpdate: ReturnType<typeof readPromptDocUpdateApproval>;
    resourceProposal: ReturnType<typeof readResourceProposalApproval>;
    visualPreview: ReturnType<typeof resolveApprovalVisualPreview>;
    simple: boolean;
    /** The Action's declared button word ("Delete"); null leaves each surface its own default. */
    approveVerb: string | null;
    /** Only an Action that declares it cannot be undone; never inferred from danger or policy. */
    irreversible: boolean;
    workspaceFileSource: ReturnType<typeof readApprovalFileSource>;
}>;

/**
 * Presentation facts shared by full review, transcript cards and compact decisions.
 * This never grants authority: the existing approval decide Action re-reads and admits the decision.
 */
export function readActionApprovalReview(request: ApprovalRequest): ActionApprovalReview {
    const admission = request.status === 'open' ? resolveApprovalRequestApproveAdmission(request) : null;
    const confidentialAction = isConfidentialSecretApprovalAction(request.actionId);
    const confidential = readConfidentialSecretApproval(request);
    const confidentialInputs = readConfidentialActionInputsApproval(request);
    const capabilityEnable = readCapabilityEnableApproval(request);
    const promptDocUpdate = readPromptDocUpdateApproval(request);
    const resourceProposal = readResourceProposalApproval(request);
    const visualPreview = resolveApprovalVisualPreview(request);
    const actionId = ActionIdSchema.safeParse(request.actionId);
    const spec = actionId.success ? getActionSpec(actionId.data) : null;
    // Specialized review owns its picker, private entry, refreshed resource selection or visual.
    // A compact row cannot substitute an unchanged decision for one of those interactions.
    const requiresReview = confidentialAction || confidentialInputs !== null || isComputerApprovalAction(request.actionId)
        || capabilityEnable !== null || promptDocUpdate !== null || resourceProposal !== null
        || visualPreview !== null || request.handoffTargetReplacementApproval !== undefined
        || Boolean(spec?.approvalNarrowing || spec?.approvalInputCustody === 'live_only'
            || spec?.approvalResultCustody === 'live_only')
        || readPluginInstallApprovalPendingReview(request.preview) !== null
        // Remembering a Project's setup is a consequence the person reads on the page before deciding; a one-tap row hides it.
        || isProjectSetupTrustRequestV1(request.actionId, request.actionArgs);
    const simple = request.v === 2 && request.status === 'open' && admission?.status === 'available'
        && spec !== null && spec.inputSchema.safeParse(request.actionArgs).success && !requiresReview;
    return { admission, confidentialAction, confidential, confidentialInputs, capabilityEnable, promptDocUpdate, resourceProposal,
        visualPreview, simple, workspaceFileSource: readApprovalFileSource(request),
        approveVerb: spec?.confirmVerb !== undefined ? resolveActionConfirmVerb(spec.confirmVerb) : null,
        irreversible: spec?.irreversible === true };
}
