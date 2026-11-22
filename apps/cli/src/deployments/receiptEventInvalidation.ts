import type { UpdateBody } from '@happier-dev/protocol/updates';
import { readDeploymentAccountChangeV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { HostEventEnvelopeV1 } from '@happier-dev/protocol';
import { readDeploymentReceiptCompletionWakeV1 } from '@happier-dev/protocol/plugins/events/hostReferencesV1';

/** Project the committed receipt wake. Home has already selected the first completion transition. */
export async function projectDeploymentReceiptInvalidationsForHost(body: Extract<UpdateBody, { t: 'account-change' }>, resolveServerId: () => Promise<string>):
    Promise<readonly HostEventEnvelopeV1<'@happier/deployment/receipt-invalidated'>[]> {
    const entityIds = [...new Set(body.entityIds ?? [])];
    const completions = new Map<string, NonNullable<ReturnType<typeof readDeploymentReceiptCompletionWakeV1>>>();
    for (const entityId of entityIds) {
        const transition = readDeploymentReceiptCompletionWakeV1(entityId);
        if (transition && (transition.completion || !completions.has(transition.deploymentId))) {
            completions.set(transition.deploymentId, transition);
        }
    }
    const receipts = entityIds.flatMap(entityId => {
        const receipt = readDeploymentAccountChangeV1({ kind: 'account', entityId });
        return receipt?.deploymentId ? [{ environmentId: receipt.environmentId, deploymentId: receipt.deploymentId }] : [];
    });
    if (receipts.length === 0) return [];
    const serverId = await resolveServerId();
    return receipts.map(receipt => {
        const transition = completions.get(receipt.deploymentId);
        return { eventId: '@happier/deployment/receipt-invalidated', scope: { kind: 'account' },
            payload: { serverId, ...receipt, ...(transition?.environmentId === receipt.environmentId
                ? { completion: transition.completion } : {}) } };
    });
}
