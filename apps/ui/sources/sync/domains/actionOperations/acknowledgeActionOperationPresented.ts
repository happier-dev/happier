import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

import { actionOperationStore } from './actionOperationStore';

/** Canonical exact-operation acknowledgement for a foreground surface that visibly presents a terminal outcome. */
export function acknowledgeActionOperationPresented(
    snapshot: ActionOperationSnapshotV1,
    serverId: string,
): boolean {
    return actionOperationStore.markTerminalSeen({ serverId, operationId: snapshot.operationId });
}
