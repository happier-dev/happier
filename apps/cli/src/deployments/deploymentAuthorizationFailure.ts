import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

/** Closed, content-free labels for existing deployment authorization refusals. */
const DEPLOYMENT_AUTHORIZATION_SUBREASONS = [
    'child_root_derivation_refused', 'child_root_not_reviewed',
    'requester_runtime_unavailable', 'requester_account_mismatch', 'requester_context_unavailable',
    'installed_target_unavailable', 'installed_target_machine_mismatch', 'installed_target_not_current',
    'requester_http_projection_missing', 'requester_account_projection_missing', 'requester_authorization_missing',
    'requester_account_not_current', 'requester_http_not_current',
    'home_request_headers_refused', 'home_signed_authorization_rejected', 'home_deployment_http_forbidden',
    'home_secret_launch_headers_refused', 'home_secret_launch_http_forbidden', 'home_project_source_read_forbidden',
    'child_dispatch_context_missing', 'local_account_subject_missing',
] as const;
export type DeploymentAuthorizationSubreason = typeof DEPLOYMENT_AUTHORIZATION_SUBREASONS[number];

export function deploymentAuthorizationFailure(reason: DeploymentAuthorizationSubreason): ActionExecuteFailure {
    // The operation reader deliberately excludes arbitrary Action details. Its
    // existing message field carries only this closed reason, never operands.
    return { ok: false, errorCode: 'action_forbidden', error: `action_forbidden (${reason})` };
}

class DeploymentAuthorizationRefusal extends Error {
    readonly code = 'action_forbidden';
    constructor(readonly reason: DeploymentAuthorizationSubreason) { super(deploymentAuthorizationFailure(reason).error); }
}

export function refuseDeploymentAuthorization(reason: DeploymentAuthorizationSubreason): never {
    throw new DeploymentAuthorizationRefusal(reason);
}

/** Preserve the owning refusal across native exception-to-Action adapters. */
export function readDeploymentAuthorizationFailure(error: unknown): ActionExecuteFailure | null {
    if (error instanceof DeploymentAuthorizationRefusal) return deploymentAuthorizationFailure(error.reason);
    const refused = error instanceof Error ? ActionExecuteFailureSchema.safeParse(error.cause) : null;
    if (!refused?.success || refused.data.errorCode !== 'action_forbidden') return null;
    const reason = DEPLOYMENT_AUTHORIZATION_SUBREASONS.find(reason => refused.data.error === `action_forbidden (${reason})`);
    return reason ? deploymentAuthorizationFailure(reason) : null;
}
