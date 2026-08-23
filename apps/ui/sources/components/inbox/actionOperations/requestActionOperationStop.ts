import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { cancelActionOperation } from '@/sync/ops/actionOperations';

export async function requestActionOperationStop(operation: ActionOperationSnapshotV1): Promise<void> {
    const result = await cancelActionOperation({
        machineId: operation.scope.machineId,
        operationId: operation.operationId,
    });
    if (result.kind !== 'requested' && result.kind !== 'already_settled') {
        throw new Error(`Action operation stop was not accepted: ${result.kind}`);
    }
}
