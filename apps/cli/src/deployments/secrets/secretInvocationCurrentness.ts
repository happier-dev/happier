import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { refuseDeploymentAuthorization } from '../deploymentAuthorizationFailure';

export type InstalledSecretContext = Pick<ActionExecutorContext, 'signal' | 'externalActionExecutionAuthorization'
    | 'externalActionCredential' | 'rpcSessionAuthorization' | 'externalActionTarget' | 'originalActionEnvelope'> & Readonly<{
    operationAcceptance?: Pick<NonNullable<ActionExecutorContext['operationAcceptance']>, 'operationId'>;
}>;

const assertNotCancelled = (signal?: AbortSignal) => {
    if (signal?.aborted) throw createActionExecuteFailureError({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
};

async function assertSecretInvocationTransportCurrent(context: InstalledSecretContext, signal?: AbortSignal): Promise<void> {
    assertNotCancelled(signal);
    const authorization = context.externalActionExecutionAuthorization;
    if (authorization) {
        if (!authorization.requesterHttpProjection) return refuseDeploymentAuthorization('requester_http_projection_missing');
        if (!await authorization.requesterHttpProjection.isCurrent()) return refuseDeploymentAuthorization('requester_http_not_current');
    }
    if (!authorization && (context.externalActionCredential || context.rpcSessionAuthorization)) return refuseDeploymentAuthorization('requester_authorization_missing');
    assertNotCancelled(signal);
}

/** Author preparation requires the requester's admitted Account custody. */
export async function assertDeploymentSecretInvocationCurrent(context: InstalledSecretContext, signal = context.signal): Promise<void> {
    assertNotCancelled(signal);
    const authorization = context.externalActionExecutionAuthorization;
    if (authorization) {
        if (!authorization.requesterAccountProjection) return refuseDeploymentAuthorization('requester_account_projection_missing');
        if (!await authorization.requesterAccountProjection.isCurrent()) return refuseDeploymentAuthorization('requester_account_not_current');
    }
    await assertSecretInvocationTransportCurrent(context, signal);
}

/** Connector custody was selected by its owner; finite Setup may use the same Account's installed custody. */
export async function assertMachineConnectorSecretInvocationCurrent(input: Readonly<{
    context: InstalledSecretContext;
    signal: AbortSignal;
    assertCurrent(): Promise<void>;
}>): Promise<void> {
    await assertSecretInvocationTransportCurrent(input.context, input.signal);
    await input.assertCurrent();
    assertNotCancelled(input.signal);
}
