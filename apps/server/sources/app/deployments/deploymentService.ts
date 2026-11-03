import { DeploymentReceiptHeaderV1Schema } from '@happier-dev/protocol';
import type { Tx } from '@/storage/inTx';
import { deploymentContentReference } from './deploymentStoredContent';
import { readDeploymentAcceptedExecution } from './deploymentAcceptedExecution';

type Receipt = NonNullable<Awaited<ReturnType<Tx['deployment']['findUnique']>>>;
export function projectDeploymentReceiptHeader(row: Receipt) {
    const acceptedExecution = readDeploymentAcceptedExecution(row);
    return DeploymentReceiptHeaderV1Schema.parse({
        v: 1, id: row.id, environmentId: row.environmentId, targetLinkId: row.targetLinkId, revision: row.revision,
        operation: row.operation, state: row.state, requestKey: row.requestKey, requestedByAccountId: row.requestedByAccountId,
        actionOperationId: row.actionOperationId, ...deploymentContentReference(row),
        ...(acceptedExecution ? { acceptedExecution } : {}),
        ...(row.predecessorDeploymentId ? { predecessorDeploymentId: row.predecessorDeploymentId } : {}),
        ...(row.rollbackOfDeploymentId ? { rollbackOfDeploymentId: row.rollbackOfDeploymentId } : {}),
        ...(row.promotedFromDeploymentId ? { promotedFromDeploymentId: row.promotedFromDeploymentId } : {}),
        ...(row.cancelRequestedAt ? { cancelRequestedAtMs: row.cancelRequestedAt.getTime() } : {}),
        requestedAtMs: row.requestedAt.getTime(), ...(row.startedAt ? { startedAtMs: row.startedAt.getTime() } : {}),
        ...(row.settledAt ? { settledAtMs: row.settledAt.getTime() } : {}),
    });
}
