import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { logger } from '@/ui/logger';
import { readDeploymentAuthorizationFailure } from './deploymentAuthorizationFailure';
import { readDeploymentSystemToolFailure } from './deploymentSystemToolFailure';
import { readDeploymentOutputValidationFailure } from './outputValidation';
import { MachineNativeEffectAdmissionError } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { readPluginActionError, readPluginActionFailureAuthorPayload } from '@happier-dev/protocol/plugins/actions/invocation';
import { DeploymentSourceAdmissionFailureV1Schema } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';

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
    if (pluginError && sourceAdmission?.success) {
        return { ok: false, errorCode, error: pluginError.message ?? errorCode, details: sourceAdmission.data,
            ...(author?.failureCause ? { failureCause: author.failureCause } : {}) };
    }
    const carried = ActionExecuteFailureSchema.safeParse(error instanceof Error ? error.cause : error);
    if (carried.success && carried.data.errorCode === errorCode) return carried.data;
    const cause = error === undefined ? undefined : normalizeActionExecutorThrownError(error, phase).failureCause;
    return { ok: false, errorCode, error: errorCode,
        ...(error instanceof MachineNativeEffectAdmissionError && error.code === errorCode && error.details ? { details: error.details } : {}),
        ...(cause === undefined ? {} : { failureCause: cause }) };
}
