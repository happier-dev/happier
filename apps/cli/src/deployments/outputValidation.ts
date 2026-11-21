import { invalidActionOutputFailure, readActionOutputDiagnostic, normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { logger } from '@/ui/logger';
import { carryActionFailureDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { core } from 'zod/mini';
import { actionInputValidationFailure } from '@happier-dev/protocol/actions/executor/actionInputValidation';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentOutputValidationV1Schema } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';

/** The canonical issue projector excludes rejected values, unknown keys and custom prose. */
export function deploymentOutputValidationFailure(source: string, httpStatus: number | undefined, error?: core.$ZodError): ActionExecuteFailure {
    const failure = invalidActionOutputFailure(error, source);
    logger.warnLocalFile('[Deployment] Invalid action output', readActionOutputDiagnostic(failure));
    const details = error ? actionInputValidationFailure(error).details : undefined;
    const issues = details && typeof details === 'object' && !Array.isArray(details) && 'issues' in details ? details.issues : [];
    if (httpStatus === undefined) {
        return carryActionFailureDiagnostic({ ...failure, details: { issues } }, failure);
    }
    const validation = DeploymentOutputValidationV1Schema.parse({ source, httpStatus, issues });
    return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output', details: { validation } };
}

/** Preserve only this typed parser result through native exception/Action adapters. */
export function readDeploymentOutputValidation(failure: ActionExecuteFailure) {
    if (failure.errorCode !== 'invalid_action_output') return undefined;
    const details = failure.details;
    if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
    const parsed = DeploymentOutputValidationV1Schema.safeParse('validation' in details ? details.validation
        : 'issues' in details ? { source: failure.failureCause?.phase, issues: details.issues } : undefined);
    if (!parsed.success) return undefined;
    return { ...parsed.data, issues: parsed.data.issues.map(({ path, code }) => ({ path, code })) };
}

export function readDeploymentOutputValidationFailure(errorCode: string, error: unknown, phase = 'deployment.output'): ActionExecuteFailure | null {
    if (error instanceof core.$ZodError) {
        const failure = deploymentOutputValidationFailure(phase, undefined, error);
        const failureCause = normalizeActionExecutorThrownError(error, phase).failureCause;
        return carryActionFailureDiagnostic({ ...failure,
            ...(failureCause ? { failureCause } : {}) }, failure);
    }
    if (errorCode !== 'invalid_action_output' || !readActionOutputDiagnostic(error)) return null;
    return carryActionFailureDiagnostic<ActionExecuteFailure>({ ok: false, ...normalizeActionExecutorThrownError(error) }, error);
}
