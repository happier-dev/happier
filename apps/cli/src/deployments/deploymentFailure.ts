import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { readDeploymentAuthorizationFailure } from './deploymentAuthorizationFailure';
import { readDeploymentSystemToolFailure } from './deploymentSystemToolFailure';
import { readDeploymentOutputValidationFailure } from './outputValidation';
import { MachineNativeEffectAdmissionError } from '@/daemon/local/services/launch/machineNativeEffectAdmission';

/** Preserve typed owner diagnostics across deployment exceptions and child transport. */
export function projectDeploymentFailure(errorCode: string, error?: unknown, phase = 'deployment.failure'): ActionExecuteFailure {
    const known = (errorCode === 'action_forbidden' ? readDeploymentAuthorizationFailure(error) : null)
        ?? readDeploymentSystemToolFailure(errorCode, error)
        ?? readDeploymentOutputValidationFailure(errorCode, error);
    if (known) return known;
    const carried = ActionExecuteFailureSchema.safeParse(error instanceof Error ? error.cause : error);
    if (carried.success && carried.data.errorCode === errorCode) return carried.data;
    const cause = error === undefined ? undefined : normalizeActionExecutorThrownError(error, phase).failureCause;
    return { ok: false, errorCode, error: errorCode,
        ...(error instanceof MachineNativeEffectAdmissionError && error.code === errorCode && error.details ? { details: error.details } : {}),
        ...(cause === undefined ? {} : { failureCause: cause }) };
}
