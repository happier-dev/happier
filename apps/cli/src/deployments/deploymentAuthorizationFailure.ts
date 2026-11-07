import { ActionExecuteFailureSchema, projectActionFailureCauseV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { ExternalActionAuthorizationRefusalPhaseSchema } from '@happier-dev/protocol/actions/externalActionHttpError';
import { REQUESTER_CURRENTNESS_REFUSAL_BRANCHES } from '@/daemon/sessionEncryption/requesterCurrentness';
import { readHomeAuthorizationRefusalDetails } from '@/api/client/homeAuthorizationHttpFailure';

/** Closed, content-free labels for existing deployment authorization refusals. */
function deploymentAuthorizationSubreasons() {
    // Read owner vocabularies after the host import graph has initialized.
    return [
        'child_root_derivation_refused', 'child_root_not_reviewed',
        'requester_runtime_unavailable', 'requester_account_mismatch', 'requester_context_unavailable',
        'installed_target_unavailable', 'installed_target_machine_mismatch', 'installed_target_not_current',
        'requester_http_projection_missing', 'requester_account_projection_missing', 'requester_authorization_missing',
        'requester_account_not_current', 'requester_http_not_current',
        'home_request_headers_refused', 'home_signed_authorization_rejected', 'home_deployment_http_forbidden',
        ...ExternalActionAuthorizationRefusalPhaseSchema.options.map(phase => `home_signed_authorization_rejected:${phase}` as const),
        ...REQUESTER_CURRENTNESS_REFUSAL_BRANCHES.map(branch => `home_request_headers_refused:${branch}` as const),
        'home_secret_launch_headers_refused', 'home_secret_launch_http_forbidden', 'home_project_source_read_forbidden',
        'child_dispatch_context_missing', 'local_account_subject_missing',
    ] as const;
}
export type DeploymentAuthorizationSubreason = ReturnType<typeof deploymentAuthorizationSubreasons>[number];

export function deploymentAuthorizationFailure(reason: DeploymentAuthorizationSubreason): ActionExecuteFailure {
    // Recovery and the closed refusal reason expose no signed operands.
    const details = reason.startsWith('home_signed_authorization_rejected:')
        ? readHomeAuthorizationRefusalDetails(reason.slice('home_signed_authorization_rejected:'.length)) : undefined;
    return { ok: false, errorCode: 'action_forbidden', error: `action_forbidden (${reason})`,
        details: details ?? projectDeploymentFailureRecoveryV1({}),
        failureCause: projectActionFailureCauseV1(new Error('action_forbidden'),
            `deployment.authorization.${reason}`) };
}

class DeploymentAuthorizationRefusal extends Error {
    readonly code = 'action_forbidden';
    constructor(readonly reason: DeploymentAuthorizationSubreason, failure?: ActionExecuteFailure) {
        super(deploymentAuthorizationFailure(reason).error, { cause: failure });
    }
}

export function refuseDeploymentAuthorization(reason: DeploymentAuthorizationSubreason, failure?: ActionExecuteFailure): never {
    throw new DeploymentAuthorizationRefusal(reason, failure);
}

/** Preserve the owning refusal across native exception-to-Action adapters. */
export function readDeploymentAuthorizationFailure(error: unknown): ActionExecuteFailure | null {
    const refused = ActionExecuteFailureSchema.safeParse(error instanceof Error ? error.cause : error);
    const failure = refused.success && refused.data.errorCode === 'action_forbidden' ? refused.data : null;
    const reason = error instanceof DeploymentAuthorizationRefusal ? error.reason
        : failure && deploymentAuthorizationSubreasons().find(reason => failure.error === `action_forbidden (${reason})`);
    return reason ? {
        ...deploymentAuthorizationFailure(reason),
        ...(failure?.details === undefined ? {} : { details: failure.details }),
        ...(failure?.failureCause ? { failureCause: failure.failureCause } : {}),
    } : null;
}
