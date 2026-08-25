import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { actionOperationStore } from './actionOperationStore';

/** Canonical exact-operation acknowledgement for a foreground surface that visibly presents a terminal outcome. */
export function acknowledgeActionOperationPresented(snapshot: ActionOperationSnapshotV1): boolean {
    return actionOperationStore.markTerminalSeen(snapshot.operationId);
}
