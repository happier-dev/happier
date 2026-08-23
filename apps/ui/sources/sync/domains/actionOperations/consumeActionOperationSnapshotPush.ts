import {
    ActionOperationSnapshotV1Schema,
    type ActionOperationSnapshotEphemeralV1,
    type ActionOperationSnapshotV1,
} from '@happier-dev/protocol';

import { actionOperationStore, type ActionOperationStore } from './actionOperationStore';

export async function consumeActionOperationSnapshotPush(params: Readonly<{
    update: ActionOperationSnapshotEphemeralV1;
    accountId: string;
    openSnapshot: (ciphertext: string) => unknown | Promise<unknown>;
    store?: ActionOperationStore;
    shouldContinue?: () => boolean;
    onSnapshot?: (snapshot: ActionOperationSnapshotV1) => void | Promise<void>;
}>): Promise<void> {
    const shouldContinue = params.shouldContinue ?? (() => true);
    if (!shouldContinue()) return;

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
    store.mergeSnapshots([snapshot]);
    store.setMachineObservation(params.update.machineId, 'available');
    await params.onSnapshot?.(snapshot);
}
