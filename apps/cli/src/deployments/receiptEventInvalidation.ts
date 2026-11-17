import type { UpdateBody } from '@happier-dev/protocol/updates';
import { readDeploymentAccountChangeV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { HostEventEnvelopeV1 } from '@happier-dev/protocol';

/** Project the existing committed receipt wake; never derive outcome from a socket hint. */
export async function projectDeploymentReceiptInvalidationsForHost(body: Extract<UpdateBody, { t: 'account-change' }>, resolveServerId: () => Promise<string>):
    Promise<readonly HostEventEnvelopeV1<'@happier/deployment/receipt-invalidated'>[]> {
    const receipts = [...new Set(body.entityIds ?? [])].flatMap(entityId => {
        const receipt = readDeploymentAccountChangeV1({ kind: 'account', entityId });
        return receipt?.deploymentId ? [{ environmentId: receipt.environmentId, deploymentId: receipt.deploymentId }] : [];
    });
    if (receipts.length === 0) return [];
    const serverId = await resolveServerId();
    return receipts.map(receipt => ({ eventId: '@happier/deployment/receipt-invalidated',
        scope: { kind: 'account' }, payload: { serverId, ...receipt } }));
}
