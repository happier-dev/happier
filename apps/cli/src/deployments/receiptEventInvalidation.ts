import type { UpdateBody } from '@happier-dev/protocol/updates';
import { readDeploymentAccountChangeV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { HostEventEnvelopeV1 } from '@happier-dev/protocol';

/** Project the existing committed receipt wake; never derive outcome from a socket hint. */
export function projectDeploymentReceiptInvalidationsForHost(body: Extract<UpdateBody, { t: 'account-change' }>):
    readonly HostEventEnvelopeV1<'@happier/deployment/receipt-invalidated'>[] {
    return [...new Set(body.entityIds ?? [])].flatMap(entityId => {
        const receipt = readDeploymentAccountChangeV1({ kind: 'account', entityId });
        return receipt?.deploymentId ? [{ eventId: '@happier/deployment/receipt-invalidated' as const,
            scope: { kind: 'account' as const }, payload: { environmentId: receipt.environmentId, deploymentId: receipt.deploymentId } }] : [];
    });
}
