import {
    ActionOperationSnapshotV1Schema,
    type ActionOperationSnapshotEphemeralV1,
} from '@happier-dev/protocol/actions/operations/v1';

import { actionOperationStore, type ActionOperationStore } from './actionOperationStore';
import {
    normalizeActionOperationServerId,
    qualifyActionOperationSnapshot,
    type QualifiedActionOperation,
} from './qualifiedActionOperation';

export async function consumeActionOperationSnapshotPush(params: Readonly<{
    update: ActionOperationSnapshotEphemeralV1;
    accountId: string;
    sourceServerId: string | null;
    openSnapshot: (ciphertext: string) => unknown | Promise<unknown>;
    store?: ActionOperationStore;
    shouldContinue?: () => boolean;
    onSnapshot?: (operation: QualifiedActionOperation) => void | Promise<void>;
}>): Promise<void> {
    const shouldContinue = params.shouldContinue ?? (() => true);
    if (!shouldContinue()) return;
    const sourceServerId = normalizeActionOperationServerId(params.sourceServerId);
    if (!sourceServerId) return;

    const opened = await params.openSnapshot(params.update.ciphertext);
    if (!shouldContinue()) return;
    const parsed = ActionOperationSnapshotV1Schema.safeParse(opened);
    if (!parsed.success) return;
    const snapshot = parsed.data;
    if (
        snapshot.scope.accountId !== params.accountId
        || snapshot.scope.machineId !== params.update.machineId
    ) return;

    const store = params.store ?? actionOperationStore;
    const operation = qualifyActionOperationSnapshot(sourceServerId, snapshot);
    store.mergeSnapshots({ serverId: sourceServerId, snapshots: [snapshot] });
    store.setMachineObservation({ serverId: sourceServerId, machineId: params.update.machineId }, 'available');
    await params.onSnapshot?.(operation);
}
