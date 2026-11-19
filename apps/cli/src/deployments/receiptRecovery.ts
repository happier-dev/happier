import type { ActionExecutorContext, ActionExecuteFailure, ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions';
import type { DeploymentContentV1, DeploymentReceiptHeaderV1, DeploymentStateV1 } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentTransitionResultForHost } from './deploymentTransitionResult';

/** Reconcile at the next preparation or receipt admission, through the signed writer.
 * Operation success alone cannot prove native activation or uniform settlement. */
export async function settleInterruptedDeploymentReceiptForHost(request: Readonly<{
    environmentId: string; accountId: string; machineId: string; installationId: string; context: ActionExecutorContext;
    operation: DeploymentReceiptHeaderV1['operation']; requestKey?: string;
}>, host: Readonly<{
    readInProgress(): Promise<readonly DeploymentReceiptHeaderV1[]>;
    readOperation(operationId: string, context: ActionExecutorContext): Promise<ActionOperationSnapshotV1 | null>;
    readReceipt(header: DeploymentReceiptHeaderV1, context: ActionExecutorContext):
        Promise<Readonly<{ content: DeploymentContentV1 }>>;
    writeTransition(request: Readonly<{ environmentId: string; deploymentId: string; receiptHeader: DeploymentReceiptHeaderV1;
        expectedRevision: number; state: DeploymentStateV1; context: ActionExecutorContext; content?: DeploymentContentV1 }>):
        Promise<DeploymentTransitionResultForHost>;
}>): Promise<ActionExecuteFailure | null> {
    for (const header of await host.readInProgress()) {
        const controller = header.acceptedExecution?.controller;
        // A scoped not_found says nothing about another requester's operation,
        // or an operation on a different captured controller installation.
        if (header.requestedByAccountId !== request.accountId || controller?.machineId !== request.machineId
            || controller.installationId !== request.installationId
            || header.actionOperationId === request.context.operationAcceptance?.operationId) continue;
        // Ask preparation can run before the operation runner matches a retry.
        // The same receipt intent can only rejoin or conflict at that owner.
        if (header.operation === request.operation && header.requestKey === request.requestKey) continue;
        const operation = await host.readOperation(header.actionOperationId, request.context);
        if (operation && operation.state !== 'failed' && operation.state !== 'cancelled' && operation.state !== 'succeeded') continue;
        const state = operation?.state === 'failed' ? 'failed' : operation?.state === 'cancelled' ? 'cancelled' : 'outcome_unknown';
        const receipt = state === 'outcome_unknown' ? await host.readReceipt(header, request.context) : null;
        // A finite controller operation can finish after handing work to a
        // provider. Its retained provider id belongs to the existing observer.
        if (receipt?.content.platform?.observation.providerDeploymentId) continue;
        const written = await host.writeTransition({ environmentId: request.environmentId, deploymentId: header.id,
            receiptHeader: header, expectedRevision: header.revision, state, context: request.context,
            ...(receipt && !receipt.content.failure ? { content: { ...receipt.content,
                failure: { code: 'deployment_activation_not_observed', phase: 'observe' } } } : {}) });
        if (!written.ok) return written;
    }
    return null;
}
