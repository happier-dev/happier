import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

import { actionOperationStore } from './actionOperationStore';
import type { ActionOperationAddress } from './qualifiedActionOperation';

/** Canonical exact-operation acknowledgement for a foreground surface that visibly presents a terminal outcome. */
export function acknowledgeActionOperationPresented(
    snapshot: ActionOperationSnapshotV1,
    serverId: string,
): boolean {
    return actionOperationStore.markTerminalSeen({ serverId, operationId: snapshot.operationId });
}

/**
 * Canonical exact-operation acknowledgement when a mounted foreground surface visibly presents
 * a waited terminal settlement that may arrive before its Action operation snapshot lands in the store.
 */
export function acknowledgeActionOperationSettlementPresented(
    address: ActionOperationAddress,
): boolean {
    return actionOperationStore.markTerminalSeen(address, undefined, { bindOnTerminal: true });
}
