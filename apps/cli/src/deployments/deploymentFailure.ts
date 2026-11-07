import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { logger } from '@/ui/logger';
import { readDeploymentAuthorizationFailure } from './deploymentAuthorizationFailure';
import { readDeploymentSystemToolFailure } from './deploymentSystemToolFailure';
import { readDeploymentOutputValidationFailure } from './outputValidation';
import { MachineNativeEffectAdmissionError } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { readPluginActionError, readPluginActionFailureAuthorPayload } from '@happier-dev/protocol/plugins/actions/invocation';
import { DeploymentSourceAdmissionFailureV1Schema, DeploymentReceiptFailureV1Schema,
    type DeploymentReceiptFailureV1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { DeploymentMissingRequiredSecretsV1Schema } from '@happier-dev/deployment-protocol';

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

/** Preserve typed owner diagnostics across deployment exceptions and child transport. */
export function projectDeploymentFailure(errorCode: string, error?: unknown, phase = 'deployment.failure'): ActionExecuteFailure {
    const failure = readAuthoredDeploymentFailure(errorCode, error, phase);
    return failure.details === undefined
        ? { ...failure, details: projectDeploymentFailureRecoveryV1({}) } : failure;
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
        ?? readDeploymentOutputValidationFailure(errorCode, error);
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
    const cause = error === undefined ? undefined : normalizeActionExecutorThrownError(error, phase).failureCause;
    return { ok: false, errorCode, error: errorCode,
        ...(error instanceof MachineNativeEffectAdmissionError && error.code === errorCode && error.details ? { details: error.details } : {}),
        ...(cause === undefined ? {} : { failureCause: cause }) };
}
