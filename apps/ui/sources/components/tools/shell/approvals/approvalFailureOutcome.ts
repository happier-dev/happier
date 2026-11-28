import { DEPLOYMENT_RESTORE_AMCHECK_CREATE_DENIED_V1 } from '@happier-dev/deployments/contracts/v1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readDeploymentConnectionPermissionRemedy, readDeploymentRefusalRecovery } from '@/components/projects/deployments/deploymentPresentation';
import { readActionFailurePresentationV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { listActionSpecs } from '@happier-dev/protocol/actions';
import { readLocalServiceDeclarationName } from '@happier-dev/protocol/actions/specs/localServices';
import { DaemonLocalServiceLauncherStartRequestV1Schema, DaemonLocalServiceLauncherStartResponseV1Schema,
    type LocalServiceEstablishmentFailureV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { DeploymentExecutionFailureDetailsV1Schema, DeploymentReviewConflictFailureDetailsV1Schema, DeploymentSourceAdmissionFailureV1Schema,
    DeploymentReceiptSettlementFailureDetailsV1Schema } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { DeploymentDomainFailureDetailsV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainFailureV1';
import { DeploymentTeardownEnvironmentPartialDetailsV1Schema, DeploymentBackupFailureDetailsV1Schema,
    readDeploymentBackupMaintenanceFailureEvidenceV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTemplateInstantiationPartialV1Schema } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { DeploymentFailureRecoveryV1Schema,
    projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { isDeploymentActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentMissingRequiredSecretsV1Schema } from '@happier-dev/protocol/deployments/deploymentReviewV1';
import { FiniteCommandFailureDetailsV1Schema, MachineSetupFailureDetailsV1Schema } from '@happier-dev/protocol/actions/operations/v1';

import { OpenProjectRefusalV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { describeMachineSetupStoppedCommand } from '@/components/machines/setup/machineSetupReasonText';
import { t } from '@/text';
import { formatWorkflowProblemMessage } from '@/components/workflows/presentation/workflowProblemPresentation';
import { isWorkflowOperationErrorCode, WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { readSessionSpawnNewFailure, resolveSessionSpawnNewResultFailureMessage } from '@/sync/ops/actions/sessionSpawnFailurePresentation';
import { resolveLocalServiceOutput, type LocalServiceOutputRecovery } from '@/sync/domains/local/services/serviceFailure';
import { isApprovalDecisionStale, presentApprovalFailure, presentRecordedApprovalFailure } from './useApprovalDecisionHandler';
import { readConfidentialFillSettlement, resolveConfidentialFillOutcome } from '@/components/approvals/confidentialSecretApprovalModel';
import type { TechnicalDetailsLine } from '@/components/ui/lists/TechnicalDetailsDisclosure';

/** Both Action executions and durable operation failures carry these same diagnostic facts. */
export type ApprovalFailureDiagnostics = Pick<ActionExecuteFailure, 'error' | 'errorCode' | 'details' | 'failureCause' | 'effectAttempted' | 'requestId'>;

/** Project only named facts and owner-redacted diagnostics from the failure schemas, never arbitrary details. */
export function presentActionFailureTechnicalDetails(failure: ApprovalFailureDiagnostics, scope?: 'deployment'): readonly TechnicalDetailsLine[] {
    const lines: TechnicalDetailsLine[] = [];
    const add = (key: string, label: string, value: string | number | boolean | null | undefined) => {
        if (value !== undefined && value !== null) lines.push({ key, label, value: String(value) });
    };
    if (readActionFailurePresentationV1(failure.errorCode, failure.details)) {
        add('failure-code', t('common.error'), failure.errorCode);
        add('failure-request-id', t('approvals.failureTechnicalLabels.requestId'), failure.requestId);
        add('failure-effect-attempted', t('approvals.failureTechnicalLabels.effectAttempted'), failure.effectAttempted);
        return lines;
    }
    const presented = presentRecordedApprovalFailure(failure);
    if (presented.code !== null && failure.error !== failure.errorCode) {
        add('failure-message', t('detailPages.approval.failureTitle'), failure.error);
    }
    add('failure-code', t('common.error'), presented.code);
    const finiteCommand = FiniteCommandFailureDetailsV1Schema.safeParse(failure.details);
    const machineSetup = MachineSetupFailureDetailsV1Schema.safeParse(failure.details);
    const setupFailure = machineSetup.success ? machineSetup.data.failure : undefined;
    const projectOpen = OpenProjectRefusalV1Schema.safeParse(failure.details);
    const execution = DeploymentExecutionFailureDetailsV1Schema.safeParse(failure.details);
    const conflict = DeploymentReviewConflictFailureDetailsV1Schema.safeParse(failure.details);
    const domain = DeploymentDomainFailureDetailsV1Schema.safeParse(failure.details);
    const environmentRemoval = DeploymentTeardownEnvironmentPartialDetailsV1Schema.safeParse(failure.details);
    const backup = scope === 'deployment' ? DeploymentBackupFailureDetailsV1Schema.safeParse(failure.details) : null;
    const receiptFailure = execution.success ? execution.data.failure : null;
    const directSourceAdmission = DeploymentSourceAdmissionFailureV1Schema.safeParse(failure.details);
    const sourceAdmission = directSourceAdmission.success ? directSourceAdmission.data : receiptFailure?.sourceAdmission;
    const domainFailure = domain.success && 'failure' in domain.data ? domain.data.failure : undefined;
    const genericRecovery = DeploymentFailureRecoveryV1Schema.safeParse(failure.details);
    const settlementRecovery = DeploymentReceiptSettlementFailureDetailsV1Schema.safeParse(failure.details);
    const partial = DeploymentTemplateInstantiationPartialV1Schema.safeParse(failure.details);
    const authoredRecovery = conflict.success ? conflict.data : domain.success ? domain.data
        : environmentRemoval.success ? environmentRemoval.data : sourceAdmission ?? (backup?.success ? backup.data : genericRecovery.success ? genericRecovery.data
            : settlementRecovery.success ? settlementRecovery.data : partial.success ? partial.data : receiptFailure);
    // A deployment failure no named schema matched still carries its typed cause (a Compose file the revision lacks):
    // the recovery owner reads it, so the stored remedy line and the reason are one decision.
    const unnamedDeploymentFacts = scope === 'deployment' && typeof failure.details === 'object' && failure.details !== null
        && !Array.isArray(failure.details) ? failure.details as Record<string, unknown> : {};
    const recovery = scope === 'deployment' || authoredRecovery
        ? projectDeploymentFailureRecoveryV1(authoredRecovery ?? unnamedDeploymentFacts, failure.errorCode) : null;
    const cause = failure.failureCause ?? receiptFailure?.failureCause;
    add('failure-phase', t('approvals.failureTechnicalLabels.phase'), finiteCommand.success ? finiteCommand.data.phase
        : setupFailure && 'phase' in setupFailure ? setupFailure.phase : receiptFailure?.phase ?? (domain.success ? domain.data.step
        : environmentRemoval.success ? environmentRemoval.data.step : sourceAdmission?.phase ?? (backup?.success ? backup.data.step : undefined)));
    add('failure-step', t('approvals.failureTechnicalLabels.step'), finiteCommand.success && finiteCommand.data.step !== undefined
        ? finiteCommand.data.step + 1 : setupFailure && 'stepId' in setupFailure ? setupFailure.stepId : undefined);
    add('failure-request-id', t('approvals.failureTechnicalLabels.requestId'), failure.requestId);
    add('failure-signal', t('approvals.failureTechnicalLabels.signal'), finiteCommand.success && finiteCommand.data.signal !== 0
        ? finiteCommand.data.signal : undefined);
    add('failure-reason', t('approvals.failureTechnicalLabels.reason'), domainFailure?.reason ?? sourceAdmission?.reason);
    add('failure-cause-phase', t('approvals.failureTechnicalLabels.causePhase'), cause?.phase ?? sourceAdmission?.phase
        ?? (domainFailure && 'phase' in domainFailure ? domainFailure.phase : domainFailure?.nativeCommand?.phase));
    add('failure-error-class', t('approvals.failureTechnicalLabels.errorClass'), cause?.errorClass);
    // A cause code equal to the Error code says nothing new: the code is named once.
    const causeCode = cause?.errorCode ?? (domainFailure && 'errorCode' in domainFailure ? domainFailure.errorCode : undefined);
    add('failure-cause-code', t('approvals.failureTechnicalLabels.causeCode'), causeCode === presented.code ? undefined : causeCode);
    const nativeFailure = scope === 'deployment'
        ? readDeploymentBackupMaintenanceFailureEvidenceV1({ details: failure.details })?.nativeFailure : undefined;
    add('failure-native-exit-code', t('tools.structuredResult.exit'), finiteCommand.success ? finiteCommand.data.exitCode : nativeFailure?.exitCode);
    add('failure-native-stderr', t('tools.structuredResult.stderr'), nativeFailure?.stderr);
    add('failure-native-stderr-truncated', t('browserDiagnostics.host.fields.truncated'), nativeFailure?.stderrTruncated);
    add('failure-http-status', t('approvals.failureTechnicalLabels.httpStatus'), cause?.httpStatus ?? receiptFailure?.validation?.httpStatus);
    add('failure-effect-attempted', t('approvals.failureTechnicalLabels.effectAttempted'), failure.effectAttempted ?? receiptFailure?.effectAttempted);
    add('failure-required-fact', t('approvals.failureTechnicalLabels.requiredFact'), recovery?.requiredFact);
    add('failure-domain', t('projects.deployments.domainFieldHost'),
        domain.success && domain.data.step === 'removeDomain' ? domain.data.domainHostname ?? domain.data.domainId : undefined);
    add('failure-current-revision', t('approvals.failureTechnicalLabels.currentEnvironmentRevision'), conflict.success ? conflict.data.currentEnvironmentRevision : undefined);
    add('failure-remedy', t('approvals.failureTechnicalLabels.remedy'), setupFailure && 'remedy' in setupFailure ? setupFailure.remedy : projectOpen.success ? projectOpen.data.remediation?.label : recovery?.remedy);
    return lines;
}

export type ApprovalServiceStartFailure = Readonly<{
    reasonCode: 'plugin_managed_service_establishment_failed';
    serviceName: string | null;
    establishmentFailure?: LocalServiceEstablishmentFailureV1;
    recovery: LocalServiceOutputRecovery | null;
}>;

/** Read the native receipt, never a current feed that could describe a later retry. */
function readServiceStartFailure(approval: ApprovalRequest, failure: ActionExecuteFailure): ApprovalServiceStartFailure | null {
    if (approval.actionId !== 'localServices.launcher.start' || failure.errorCode !== 'plugin_managed_service_establishment_failed') return null;
    const request = createStoredReadSchema(DaemonLocalServiceLauncherStartRequestV1Schema).safeParse(approval.actionArgs);
    const response = createStoredReadSchema(DaemonLocalServiceLauncherStartResponseV1Schema).safeParse(approval.execution?.result);
    if (!request.success || !response.success || response.data.status === 'succeeded'
        || response.data.reasonCode !== failure.errorCode || response.data.machineId !== request.data.machineId
        || response.data.targetId !== request.data.targetId) return null;
    const target = response.data.snapshot.targets.find(entry => entry.id === response.data.targetId) ?? null;
    return {
        reasonCode: failure.errorCode,
        serviceName: target?.title ?? readLocalServiceDeclarationName(request.data.declaration),
        ...(response.data.establishmentFailure ? { establishmentFailure: response.data.establishmentFailure } : {}),
        recovery: resolveLocalServiceOutput(target, response.data.establishmentFailure),
    };
}

/** The Action's title, which names what was asked wherever the request is shown. */
export function resolveApprovalActionTitle(approval: ApprovalRequest): string {
    return listActionSpecs().find((spec) => spec.id === approval.actionId)?.title || approval.actionId;
}

/** A request that never reached its effect must not name that effect as attempted. */
function readFailureHeadline(approval: ApprovalRequest, failure: ActionExecuteFailure): string {
    if (approval.status === 'outcome_unknown') return t('automations.detail.runMeta.dispatchState.outcomeUnknown');
    if ((approval.v === 2 && approval.execution?.effectAttempted === false) || isApprovalDecisionStale(failure)) {
        // Named like its sibling "Couldn't finish: <Action>": what was not run, said once here for every kind.
        return t('approvals.failureNotRun', { action: resolveApprovalActionTitle(approval) });
    }
    const actionId = approval.actionId;
    switch (actionId) {
        case 'daemon.filesystem.writeFile': return t('approvals.failureFileWrite');
        case 'daemon.filesystem.readFile': return t('approvals.failureFileRead');
        default: return actionId.startsWith('daemon.filesystem.') ? t('approvals.failureFileOther') : t('approvals.failureNamed', { action: resolveApprovalActionTitle(approval) });
    }
}

/** The same failure reason and diagnostic projection for direct Actions and settled approvals. */
export function presentActionFailureOutcome(failure: ApprovalFailureDiagnostics, scope?: 'deployment' | 'workflowCheck', fallbackReason?: string) {
    const technicalDetails = presentActionFailureTechnicalDetails(failure, scope === 'deployment' ? scope : undefined);
    const refusal = readActionFailurePresentationV1(failure.errorCode, failure.details);
    if (refusal) return {
        reason: refusal.message ?? t('common.requestFailed'), message: null, code: failure.errorCode ?? null,
        technicalDetails, recoveryAction: null,
    };
    const childSession = scope === 'deployment' ? readSessionSpawnNewFailure(failure.details) : null;
    if (childSession) return {
        reason: resolveSessionSpawnNewResultFailureMessage(childSession),
        message: null, code: failure.errorCode ?? null, technicalDetails, recoveryAction: null,
    };
    const cause = failure.failureCause;
    if (scope === 'deployment' && failure.errorCode === 'restore_failed' && cause && 'nativeErrorReason' in cause
        && cause.nativeErrorReason === DEPLOYMENT_RESTORE_AMCHECK_CREATE_DENIED_V1) return {
        reason: t('projects.deployments.receipt.restoreAmcheckCreateDenied'),
        message: null, code: failure.errorCode, technicalDetails, recoveryAction: null,
    };
    if (scope === 'workflowCheck' && isWorkflowOperationErrorCode(failure.errorCode ?? null)) return {
        reason: formatWorkflowProblemMessage(new WorkflowActionError({ rawCode: failure.errorCode ?? null,
            message: failure.error, rawDetails: failure.details })),
        message: null, code: failure.errorCode ?? null, technicalDetails, recoveryAction: null,
    };
    const presented = presentApprovalFailure(failure, fallbackReason ?? failure.errorCode, '');
    const finiteCommand = FiniteCommandFailureDetailsV1Schema.safeParse(failure.details);
    const machineSetup = MachineSetupFailureDetailsV1Schema.safeParse(failure.details);
    const retiredDomain = technicalDetails.find(line => line.key === 'failure-domain')?.value;
    const remedy = technicalDetails.find(line => line.key === 'failure-remedy')?.value;
    const deploymentRecovery = scope === 'deployment'
        ? readDeploymentRefusalRecovery(failure.errorCode, failure.details, undefined, failure.failureCause?.errorCode,
            { failureCause: failure.failureCause })
        : null;
    // A deploy refused before review names the required secrets that have no value (names only, never values).
    const missingSecrets = scope === 'deployment' && failure.errorCode === 'secret_missing'
        ? DeploymentMissingRequiredSecretsV1Schema.safeParse(failure.details) : null;
    const targetReason = scope === 'deployment' && failure.errorCode === 'target_unavailable'
        ? resolveActionExecutionFailureMessage(failure, '', { closedCodesOnly: true }) || null : null;
    const stoppedSetupStep = failure.errorCode === 'machine_setup_setup_failed' && finiteCommand.success && finiteCommand.data.step !== undefined
        ? describeMachineSetupStoppedCommand(t('projects.scripts.setup.step', { n: finiteCommand.data.step + 1 }), finiteCommand.data)
        : null;
    // With only a code, retain its shared Action copy ahead of the generic deployment remedy.
    const fallback = scope === 'deployment' && failure.details != null
        ? remedy || presented.reason : presented.reason || remedy;
    const reason = targetReason ?? stoppedSetupStep ?? (finiteCommand.success && finiteCommand.data.exitCode !== null
            ? t('localServices.actions.failure.exitCode', { code: String(finiteCommand.data.exitCode) })
            : machineSetup.success && remedy ? remedy
            : missingSecrets?.success
            ? t('projects.deployments.receipt.missingSecrets', { names: missingSecrets.data.missingRequiredSecretNames.join(', ') })
            : retiredDomain ? `${retiredDomain} · ${remedy}`
            : deploymentRecovery?.remedy || fallback || null);
    return {
        reason: scope === 'deployment' ? readDeploymentConnectionPermissionRemedy(failure.errorCode, failure.details) ?? reason : reason,
        message: presented.code === null || failure.error === failure.errorCode ? null : failure.error,
        code: presented.code,
        technicalDetails: technicalDetails.filter(line => line.key !== 'failure-message' || line.value !== reason),
        recoveryAction: deploymentRecovery?.nextAction ?? null,
    };
}

/**
 * A recorded failure whose code has no sentence of its own still says what happened, from its typed phase:
 * refused before it was authorized, refused by the target Machine, or stopped before it finished. The code and
 * the executor's words stay in Technical details. Only a failure that recorded nothing at all says no reason.
 */
function readUnwordedFailureReason(failure: ActionExecuteFailure, message: string | null): string | null {
    const phase = failure.failureCause ? readActionFailureCauseV1(failure.failureCause).phase : null;
    if (phase === 'execution_authorization') return t('approvals.failureNotAuthorized');
    if (phase === 'dispatch') return t('approvals.failureDispatchRefused');
    return message !== null ? t('approvals.failureUnworded') : null;
}

/**
 * What a settled approval whose effect failed says to a person: a plain headline for the outcome, a readable
 * reason when the failure has one, and the executor's own words and code for the Details disclosure.
 */
export function presentApprovalFailureOutcome(approval: ApprovalRequest, failure: ActionExecuteFailure): Readonly<{
    headline: string;
    /** Readable failure copy or the typed projector's recovery; null when neither is recorded. */
    reason: string | null;
    /** The executor's raw error, kept apart from the headline; null when it adds nothing beyond the code. */
    message: string | null;
    code: string | null;
    technicalDetails: readonly TechnicalDetailsLine[];
    /** The same typed reason/output model used by the Service row and Browser. */
    serviceStartFailure?: ApprovalServiceStartFailure;
}> {
    // Executor prose stays in Details; only canonical copy or typed recovery leads the summary.
    const presented = presentActionFailureOutcome({ ...failure,
        requestId: failure.requestId ?? (approval.v === 2 ? approval.executionOriginV1.requestId : undefined),
    }, isDeploymentActionIdV1(approval.actionId) ? 'deployment' : undefined);
    const serviceStartFailure = readServiceStartFailure(approval, failure);
    // A refused or unconfirmed confidential entry is named by what became of it, not as a failed Action.
    const fill = readConfidentialFillSettlement(approval);
    const fillOutcome = fill && fill.status !== 'filled' ? resolveConfidentialFillOutcome(fill) : null;
    const { technicalDetails } = presented;
    return {
        headline: fillOutcome?.title ?? readFailureHeadline(approval, failure),
        reason: fillOutcome ? fillOutcome.detail
            : serviceStartFailure ? resolveReasonCopy({ kind: 'localServiceAction', ...serviceStartFailure,
                serviceName: serviceStartFailure.serviceName ?? undefined }).body
                    : approval.actionId === 'doc.edit.propose' && approval.status === 'outcome_unknown'
                ? t('artifacts.browser.proposal.publicationUnknown')
                // The Home refused the signed request before any effect: its cause, said once.
                : presented.reason ?? readUnwordedFailureReason(failure, presented.message),
        message: presented.message,
        code: presented.code,
        technicalDetails,
        ...(serviceStartFailure ? { serviceStartFailure } : {}),
    };
}
