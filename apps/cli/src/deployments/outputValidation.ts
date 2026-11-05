import type { core } from 'zod/mini';
import { actionInputValidationFailure } from '@happier-dev/protocol/actions/executor/actionInputValidation';
import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentOutputValidationV1Schema } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';

/** The canonical issue projector excludes rejected values, unknown keys and custom prose. */
export function deploymentOutputValidationFailure(source: string, httpStatus: number, error?: core.$ZodError): ActionExecuteFailure {
    const details = error ? actionInputValidationFailure(error).details : undefined;
    const issues = details && typeof details === 'object' && !Array.isArray(details) && 'issues' in details ? details.issues : [];
    const validation = DeploymentOutputValidationV1Schema.parse({ source, httpStatus, issues });
    return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output', details: { validation } };
}

/** Preserve only this typed parser result through native exception/Action adapters. */
export function readDeploymentOutputValidation(error: unknown) {
    const failure = ActionExecuteFailureSchema.safeParse(error instanceof Error ? error.cause : error);
    if (!failure.success || failure.data.errorCode !== 'invalid_action_output') return undefined;
    const details = failure.data.details;
    if (!details || typeof details !== 'object' || Array.isArray(details) || !('validation' in details)) return undefined;
    const parsed = DeploymentOutputValidationV1Schema.safeParse(details.validation);
    return parsed.success ? parsed.data : undefined;
}

export function readDeploymentOutputValidationFailure(errorCode: string, error: unknown): ActionExecuteFailure | null {
    if (errorCode !== 'invalid_action_output') return null;
    const validation = readDeploymentOutputValidation(error);
    return validation ? { ok: false, errorCode, error: errorCode, details: { validation } } : null;
}
