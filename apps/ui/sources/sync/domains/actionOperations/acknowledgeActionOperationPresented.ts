import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { actionOperationStore, type ActionOperationStore } from './actionOperationStore';

/** Marks an exact terminal operation seen after a foreground surface visibly presents its outcome. */
export function acknowledgeActionOperationPresented(
    snapshot: ActionOperationSnapshotV1,
    store: ActionOperationStore = actionOperationStore,
): boolean {
    if (
        snapshot.state !== 'succeeded'
        && snapshot.state !== 'failed'
        && snapshot.state !== 'cancelled'
    ) {
        return false;
    }
    return store.markSeen(snapshot.operationId);
}
