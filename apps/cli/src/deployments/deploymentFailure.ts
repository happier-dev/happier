import { createActionExecuteFailureError, ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { withActionFailureDiagnostic, type ActionFailureDiagnosticInput } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { logger } from '@/ui/logger';
import { readDeploymentAuthorizationFailure } from './deploymentAuthorizationFailure';
import { readDeploymentSystemToolFailure } from './deploymentSystemToolFailure';
import { readDeploymentNativeResticFailure } from '@/daemon/local/services/launch/nativeResticFailure';
import { readDeploymentOutputValidationFailure } from './outputValidation';
import { MachineNativeEffectAdmissionError } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { readPluginActionError, readPluginActionFailureAuthorPayload } from '@happier-dev/protocol/plugins/actions/invocation';
import { DeploymentSourceAdmissionFailureV1Schema, DeploymentReceiptFailureV1Schema,
    type DeploymentReceiptFailureV1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { DeploymentMissingRequiredSecretsV1Schema, readDeploymentBackupMaintenanceFailureEvidenceV1 } from '@happier-dev/deployment-protocol';
import { MachineCarrierError } from '@/daemon/peer/iroh/machineCarrier';
import type { DeploymentArtifactReadFailureV1 } from '@happier-dev/protocol/deployments/deploymentArtifactContentReferenceV1';
import { ManagedMachineControllerError, readManagedNativeFailureDetails } from '@/machines/managed/controllerErrors';
import type { DeploymentTargetRoleResultV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';

/** Throwing host readers retain the Artifact owner's code-only validation cause. */
export function refuseDeploymentArtifactRead(failure: DeploymentArtifactReadFailureV1): never {
    throw createActionExecuteFailureError({ ok: false, errorCode: failure.error, error: failure.error,
        ...(failure.failureCause ? { failureCause: failure.failureCause } : {}) });
}

/** The acquisition boundary supplies context; arbitrary deployment network errors
 * are not reclassified as service-forward failures. */
export function privateServiceForwardAcquisitionError(error: unknown): Error & { code: string } {
    const original = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    const code = original === 'machine_carrier_unavailable' ? original
        : original === 'tcp_connect_failed' || original === 'ECONNREFUSED' || original === 'ENETUNREACH'
            || original === 'EHOSTUNREACH' || original === 'ETIMEDOUT' ? 'private_service_destination_unreachable'
        : error instanceof MachineCarrierError ? 'private_service_forward_refused' : original ?? 'private_service_destination_unreachable';
    return Object.assign(createActionExecuteFailureError({ ok: false, errorCode: code, error: code }), { cause: projectDeploymentFailure(code, error, 'deployment.reference.acquire') });
}

/** Source acquisition translates SCM selection failures once; capability and stale-approval refusals keep their codes. */
export function rethrowDeploymentSourceAcquisitionFailure(error: unknown): never {
    if (error instanceof Error && 'code' in error && error.code === 'git_selection_unavailable') {
        throw Object.assign(createActionExecuteFailureError({ ok: false, errorCode: 'deployment_source_unavailable', error: 'Deployment source is unavailable' }), { cause: projectDeploymentFailure('deployment_source_unavailable', error, 'deployment.source.acquire') });
    }
    throw error;
}

/** One receipt projection for provider failures, including their effect provenance. */
export function projectDeploymentReceiptFailure(result: ActionExecuteFailure,
    fallbackPhase: DeploymentReceiptFailureV1['phase']): DeploymentReceiptFailureV1 {
    const authorDetails = result.details && typeof result.details === 'object' && 'details' in result.details
        ? result.details.details : undefined;
    const phase = DeploymentReceiptFailureV1Schema.shape.phase.safeParse(
        authorDetails && typeof authorDetails === 'object' && 'phase' in authorDetails ? authorDetails.phase : undefined);
    const sourceAdmission = DeploymentSourceAdmissionFailureV1Schema.safeParse(authorDetails);
    return DeploymentReceiptFailureV1Schema.parse(projectDeploymentFailureRecoveryV1({ code: result.errorCode,
        phase: phase.success ? phase.data : fallbackPhase,
        ...(sourceAdmission.success ? { sourceAdmission: sourceAdmission.data } : {}),
        failureCause: result.failureCause ?? normalizeActionExecutorThrownError(result, `deployment.${fallbackPhase}`).failureCause,
        ...(typeof result.effectAttempted === 'boolean' ? { effectAttempted: result.effectAttempted } : {}) }));
}

/** Provider deletion settles only when the declared role confirms native absence. */
export function readProviderTeardownAbsenceFailure(
    observation: Pick<DeploymentTargetRoleResultV1, 'state' | 'providerResourceAbsent'>,
): ActionExecuteFailure | null {
    if ((observation.state !== 'succeeded' && observation.state !== 'running_unverified')
        || observation.providerResourceAbsent === true) return null;
    return { ...projectDeploymentFailure('outcome_unknown', createActionExecuteFailureError({ ok: false, errorCode: 'provider_absence_unconfirmed', error: 'provider_absence_unconfirmed' }), 'deployment.teardown.observe'), effectAttempted: true,
        details: { reason: 'provider_absence_unconfirmed' as const, requiredFact: 'providerResourceAbsent' } };
}

/** Preserve typed owner diagnostics across deployment exceptions and child transport. */
export function projectDeploymentFailure(errorCode: string, error?: unknown, phase = 'deployment.failure'): ActionExecuteFailure {
    const failure = readAuthoredDeploymentFailure(errorCode, error, phase);
    const projected = failure.details === undefined
        ? { ...failure, details: projectDeploymentFailureRecoveryV1({}) } : failure;
    return errorCode === 'deployment_unavailable'
        ? deploymentUnavailableDiagnostic(projected, phase, 'native_failure', error) : projected;
}

/**
 * The one exception-to-failure decision for deployment owners. A typed throw keeps its own code. An uncoded throw is
 * the shared Action owner's `action_failed`: it claims no content or Source cause nobody observed, keeps its class in
 * the code-only cause, and gives its class and redacted message only to the private diagnostic log.
 */
export function projectDeploymentException(error: unknown,
    options: Readonly<{ signal?: AbortSignal; phase?: string }> = {}): ActionExecuteFailure {
    if (options.signal?.aborted) return projectDeploymentFailure('cancelled', error, options.phase);
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    if (code) return projectDeploymentFailure(code, error, options.phase);
    const phase = options.phase ?? 'deployment.failure';
    return deploymentUnavailableDiagnostic(projectDeploymentFailure('action_failed', error, phase), phase, 'native_failure', error);
}

function readAuthoredDeploymentFailure(errorCode: string, error: unknown, phase: string): ActionExecuteFailure {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string'
        && 'syscall' in error && typeof error.syscall === 'string' && 'path' in error && typeof error.path === 'string') {
        logger.warnLocalFile('[Deployment] Filesystem operation failed', {
            errorClass: error.name, code: error.code, syscall: error.syscall, path: error.path,
        });
    }
    const known = (errorCode === 'action_forbidden' ? readDeploymentAuthorizationFailure(error) : null)
        ?? readDeploymentSystemToolFailure(errorCode, error)
        ?? readDeploymentNativeResticFailure(errorCode, error)
        ?? readDeploymentOutputValidationFailure(errorCode, error, phase);
    if (known) return known;
    const pluginError = readPluginActionError(error);
    const author = pluginError ? readPluginActionFailureAuthorPayload(pluginError.data) : undefined;
    const sourceAdmission = pluginError?.code === errorCode
        ? DeploymentSourceAdmissionFailureV1Schema.safeParse(author?.details) : undefined;
    const missingSecrets = pluginError?.code === errorCode && errorCode === 'secret_missing'
        ? DeploymentMissingRequiredSecretsV1Schema.safeParse(author?.details) : undefined;
    const details = sourceAdmission?.success ? sourceAdmission.data : missingSecrets?.success ? missingSecrets.data : undefined;
    if (pluginError && details) {
        return { ok: false, errorCode, error: pluginError.message ?? errorCode, details,
            ...(author?.failureCause ? { failureCause: author.failureCause } : {}) };
    }
    const carried = ActionExecuteFailureSchema.safeParse(error instanceof Error ? error.cause : error);
    if (carried.success && carried.data.errorCode === errorCode) return carried.data;
    const thrownCause = error === undefined ? undefined : normalizeActionExecutorThrownError(error, phase).failureCause;
    // Native owners throw their family code with a closed `reason` (Start First eligibility, origin
    // changes). That reason is the typed cause: it reaches the receipt and recovery, never prose.
    const reason = pluginError?.code === errorCode ? author?.details : undefined;
    const typedReason = reason && typeof reason === 'object' && !Array.isArray(reason) && 'reason' in reason
        && typeof reason.reason === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(reason.reason) ? reason.reason : undefined;
    const cause = thrownCause && typedReason && thrownCause.errorCode === errorCode
        ? { ...thrownCause, errorCode: typedReason } : thrownCause;
    const retainedDetails = readDeploymentBackupMaintenanceFailureEvidenceV1(error)
        ?? (error instanceof MachineNativeEffectAdmissionError && error.code === errorCode ? error.details : undefined)
        ?? (error instanceof ManagedMachineControllerError && error.code === errorCode && error.details?.kind === 'managedNative'
            ? error.details : undefined)
        ?? (pluginError?.code === errorCode ? readManagedNativeFailureDetails({
            ok: false, errorCode, error: errorCode, details: pluginError.data,
        }) : undefined);
    return { ok: false, errorCode, error: errorCode,
        ...(retainedDetails === undefined ? {} : { details: retainedDetails }),
        ...(cause === undefined ? {} : { failureCause: cause }) };
}

/** Deployment owners supply facts; the shared Action projector alone sanitizes them. */
export function deploymentUnavailableDiagnostic<T extends object>(value: T, phase: string,
    causeKind: ActionFailureDiagnosticInput['causeKind'], error?: unknown): T {
    return withActionFailureDiagnostic(value, { phase, causeKind, error }, diagnostic => {
        logger.warnLocalFile('[Deployment] Unavailable', diagnostic);
    });
}

export function deploymentUnavailableError(phase: string,
    causeKind: ActionFailureDiagnosticInput['causeKind'], error?: unknown): Error & { code: 'deployment_unavailable' } {
    return deploymentUnavailableDiagnostic(createActionExecuteFailureError({ ok: false, errorCode: 'deployment_unavailable' as const, error: 'deployment_unavailable' }), phase, causeKind, error);
}
