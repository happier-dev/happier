import { readPetImportConfirmationV1 } from '@happier-dev/protocol/pets/importActionV1';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { isProjectSetupTrustRequestV1, PROJECT_ACTION_INPUT_SCHEMAS_V1, readProjectSetupTrustRequestOperationV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { readPluginInstallApprovalPendingReview } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { resolveApprovalRequestApproveAdmission, resolveApprovalVisualPreview } from './approvalFieldValues';
import { resolveApprovalExecutor, type ApprovalExecutor, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { t } from '@/text';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { isComputerApprovalAction } from './computerApprovalModel';
import { isConfidentialSecretApprovalAction, readConfidentialActionInputsApproval, readConfidentialSecretApproval } from './confidentialSecretApprovalModel';
import { readResourceProposalApproval } from './resourceProposal/readResourceProposalApproval';
import { readPromptDocUpdateApproval } from './promptDocApprovalModel';
import { readCapabilityEnableApproval } from '@/components/sessions/capabilities/capabilityEnableApprovalModel';
import { readApprovalFileSource } from './approvalFileSource';
import { readApprovalAutomaticChecksDecision } from './approvalAutomaticChecksDecision';
import { readDeploymentReviewApproval } from './DeploymentReviewApprovalFacts';
import { readActionApprovalConfirmLabel } from './actionApprovalPresentation';
import { readPluginInstallApprovalChange } from './pluginInstallApprovalFacts';
import { DocEditProposeResolvedInputV1Schema, type DocEditProposeResolvedInputV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';

/** Review reads protocol admission, executor availability and the retained setup fact used at decision time. */
export type ActionApprovalReviewAdmission = ReturnType<typeof resolveApprovalRequestApproveAdmission>
    | Readonly<{ status: 'unavailable'; reason: 'cannot_run'; cause: ApprovalExecutorUnavailableReason;
        presentation: ReturnType<typeof resolveApprovalRequestApproveAdmission>['presentation'] }>;

type ApprovalExecutorUnavailableReason = Extract<ApprovalExecutor, { kind: 'unavailable' }>['reason'] | 'project_setup_review_unavailable';

/** The reason every review surface shows while the request cannot run. */
export function readApprovalCannotRunReason(admission: ActionApprovalReviewAdmission | null | undefined): string | null {
    if (admission?.status === 'unavailable' && admission.reason === 'live_invocation_unavailable') {
        return t('approvals.cannotRun');
    }
    // A request kept in the earlier format can't be approved; the card says so instead of a silent grey Approve.
    // Details that cannot be shown safely already say why on their own.
    if (admission?.status === 'unavailable' && admission.reason === 'legacy_request' && !admission.presentation.unrepresentable) {
        return t('approvals.cannotRunLegacy');
    }
    if (admission?.status !== 'unavailable' || admission.reason !== 'cannot_run') return null;
    return admission.cause === 'missing_machine' ? t('approvals.cannotRunNoMachine') : t('approvals.cannotRun');
}

export type ActionApprovalReview = Readonly<{
    admission: ActionApprovalReviewAdmission | null;
    confidentialAction: boolean;
    confidential: ReturnType<typeof readConfidentialSecretApproval>;
    /** Declared secret inputs the consuming Action is waiting for; chosen privately, never by plain Approve. */
    confidentialInputs: ReturnType<typeof readConfidentialActionInputsApproval>;
    capabilityEnable: ReturnType<typeof readCapabilityEnableApproval>;
    petImport: ReturnType<typeof readPetImportConfirmationV1>;
    promptDocUpdate: ReturnType<typeof readPromptDocUpdateApproval>;
    docEditProposal: DocEditProposeResolvedInputV1 | null;
    resourceProposal: ReturnType<typeof readResourceProposalApproval>;
    visualPreview: ReturnType<typeof resolveApprovalVisualPreview>;
    simple: boolean;
    /** The Action's declared button word ("Delete"); null leaves each surface its own default. */
    approveVerb: string | null;
    /** Only an Action that declares it cannot be undone; never inferred from danger or policy. */
    irreversible: boolean;
    workspaceFileSource: ReturnType<typeof readApprovalFileSource>;
}>;

function readRetainedSetupRequest(request: ApprovalRequest | null) {
    if (!request || request.status !== 'open' || !isProjectSetupTrustRequestV1(request.actionId, request.actionArgs)) return null;
    const parsed = PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.prepare'].safeParse(request.actionArgs);
    return parsed.success ? parsed.data : null;
}

function resolveReviewApproveAdmission(request: ApprovalRequest, retainedOperation: ActionOperationProjection | null): ActionApprovalReviewAdmission {
    const admission = resolveApprovalRequestApproveAdmission(request);
    if (admission.status !== 'available') return admission;
    const executor = resolveApprovalExecutor(request);
    if (executor.kind === 'unavailable') return { status: 'unavailable', reason: 'cannot_run', cause: executor.reason, presentation: admission.presentation };
    const setup = readRetainedSetupRequest(request);
    if (setup && (!retainedOperation || retainedOperation.isUnavailableProjection
        || !readProjectSetupTrustRequestOperationV1(setup, { kind: 'found', operation: retainedOperation.snapshot }))) {
        return { status: 'unavailable', reason: 'cannot_run', cause: 'project_setup_review_unavailable', presentation: admission.presentation };
    }
    return admission;
}

/** Review consumes the existing retained-operation push; it never probes the target again. */
export function useActionApprovalReview(request: ApprovalRequest): ActionApprovalReview;
export function useActionApprovalReview(request: ApprovalRequest | null): ActionApprovalReview | null;
export function useActionApprovalReview(request: ApprovalRequest | null): ActionApprovalReview | null {
    const setup = readRetainedSetupRequest(request);
    const retained = useActionOperation({
        serverId: setup ? resolveServerProfileScopeIdForIdentifier(setup.workspace.serverId) : null,
        operationId: setup?.heldOperationId ?? '',
    });
    return request ? readActionApprovalReview(request, retained) : null;
}

/** The doc-edit family reads one resolved proposal for retained and immediate review. */
export function readApprovalDocEditProposal(request: Pick<ApprovalRequest, 'actionId' | 'actionArgs'>): DocEditProposeResolvedInputV1 | null {
    const parsed = request.actionId === 'doc.edit.propose' ? DocEditProposeResolvedInputV1Schema.safeParse(request.actionArgs) : null;
    return parsed?.success ? parsed.data : null;
}

/** Shared presentation only; the approval decision Action still owns execution admission. */
export function readActionApprovalReview(request: ApprovalRequest, retainedOperation: ActionOperationProjection | null = null): ActionApprovalReview {
    const admission = request.status === 'open' ? resolveReviewApproveAdmission(request, retainedOperation) : null;
    const confidentialAction = isConfidentialSecretApprovalAction(request.actionId);
    const confidential = readConfidentialSecretApproval(request);
    const confidentialInputs = readConfidentialActionInputsApproval(request);
    const capabilityEnable = readCapabilityEnableApproval(request);
    const petImport = readPetImportConfirmationV1(request);
    const promptDocUpdate = readPromptDocUpdateApproval(request);
    const docEditProposal = readApprovalDocEditProposal(request);
    const resourceProposal = readResourceProposalApproval(request);
    const visualPreview = resolveApprovalVisualPreview(request);
    const actionId = ActionIdSchema.safeParse(request.actionId);
    const spec = actionId.success ? getActionSpec(actionId.data) : null;
    // Specialized review owns its picker, private entry, refreshed resource selection or visual.
    // A compact row cannot substitute an unchanged decision for one of those interactions.
    const requiresReview = confidentialAction || confidentialInputs !== null || isComputerApprovalAction(request.actionId)
        || capabilityEnable !== null || promptDocUpdate !== null || docEditProposal !== null || resourceProposal !== null
        || visualPreview !== null || petImport !== null || request.handoffTargetReplacementApproval !== undefined
        || (request.v === 2 && readApprovalAutomaticChecksDecision(request.automaticChecks) !== null)
        || Boolean(spec?.approvalNarrowing || spec?.approvalInputCustody === 'live_only'
            || spec?.approvalResultCustody === 'live_only')
        || readPluginInstallApprovalPendingReview(request.preview) !== null
        // Remembering a Project's setup is a consequence the person reads on the page before deciding; a one-tap row hides it.
        || isProjectSetupTrustRequestV1(request.actionId, request.actionArgs)
        // A deploy's reviewed effect (Machine, services, risks, rollout) is read on the page before deciding.
        || readDeploymentReviewApproval(request) !== null;
    const simple = request.v === 2 && request.status === 'open' && admission?.status === 'available'
        && spec !== null && spec.inputSchema.safeParse(request.actionArgs).success && !requiresReview;
    return { admission, confidentialAction, confidential, confidentialInputs, capabilityEnable, petImport, promptDocUpdate, docEditProposal, resourceProposal,
        visualPreview, simple, workspaceFileSource: readApprovalFileSource(request),
        approveVerb: petImport ? t('settingsPets.store.add')
            : spec?.id === 'plugins.install' && readPluginInstallApprovalChange(request.preview) === 'update'
            ? t('common.update') : spec ? readActionApprovalConfirmLabel(spec.id) : null,
        irreversible: spec?.irreversible === true };
}
