import {
    ActionOperationSnapshotV1Schema,
    projectActionOperationSnapshotForV1Reader,
    type ActionOperationGetV1Response,
    type ActionOperationRevisionEphemeralV1,
} from '@happier-dev/protocol/actions/operations/v1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';

import { actionOperationStore, type ActionOperationStore } from './actionOperationStore';
import {
    normalizeActionOperationServerId,
    actionOperationAddressKey,
    type QualifiedActionOperation,
} from './qualifiedActionOperation';

export async function consumeActionOperationSnapshotPush(params: Readonly<{
    update: ActionOperationRevisionEphemeralV1;
    accountId: string;
    accountEncryptionMode: 'plain' | 'e2ee';
    sourceServerId: string | null;
    openSnapshot?: (ciphertext: string) => unknown | Promise<unknown>;
    /** Existing qualified V2 reader; a released notification is not the complete current record. */
    readSnapshot: (operationId: string) => Promise<ActionOperationGetV1Response>;
    store?: ActionOperationStore;
    shouldContinue?: () => boolean;
    onSnapshot?: (operation: QualifiedActionOperation) => void | Promise<void>;
}>): Promise<void> {
    const shouldContinue = params.shouldContinue ?? (() => true);
    if (!shouldContinue()) return;
    const sourceServerId = normalizeActionOperationServerId(params.sourceServerId);
    if (!sourceServerId) return;

    const content = params.update.content;
    if (content.t === 'plain' ? params.accountEncryptionMode !== 'plain'
        : params.accountEncryptionMode !== 'e2ee' || !params.openSnapshot) return;
    const opened = content.t === 'plain' ? content.v : await params.openSnapshot!(content.c);
    if (!shouldContinue()) return;
    const parsed = ActionOperationSnapshotV1Schema.safeParse(opened);
    if (!parsed.success) return;
    let snapshot = parsed.data;
    if (
        snapshot.scope.accountId !== params.accountId
        || snapshot.scope.machineId !== params.update.machineId
    ) return;

    const store = params.store ?? actionOperationStore;
    const unavailable = () => store.setMachineObservation({ serverId: sourceServerId, machineId: params.update.machineId }, 'unavailable');
    try {
        const response = await params.readSnapshot(snapshot.operationId);
        if (!shouldContinue()) return;
        if (response.kind !== 'found' || response.operation.operationId !== snapshot.operationId
            || response.operation.actionId !== snapshot.actionId
            || response.operation.scope.accountId !== params.accountId
            || response.operation.scope.machineId !== params.update.machineId
            || response.operation.scope.sessionId !== snapshot.scope.sessionId
            || response.operation.revision < snapshot.revision) {
            unavailable();
            return;
        }
        snapshot = response.operation;
    } catch (error) {
        if (!shouldContinue()) return;
        const retained = store.getSnapshot().operationsByKey.get(actionOperationAddressKey({
            serverId: sourceServerId, operationId: snapshot.operationId,
        }))?.snapshot;
        // Supported ../0.2 has no V2 method. Never synthesize a partial rich record
        // or overwrite retained current facts with its released-reader projection.
        if (!(isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error))
            || !sameStrictJsonValue(snapshot, projectActionOperationSnapshotForV1Reader(snapshot))
            || retained && !sameStrictJsonValue(retained, projectActionOperationSnapshotForV1Reader(retained))) {
            unavailable();
            return;
        }
    }
    store.mergeSnapshots({ serverId: sourceServerId, snapshots: [snapshot] });
    const operation = store.getSnapshot().operationsByKey.get(actionOperationAddressKey({
        serverId: sourceServerId, operationId: snapshot.operationId,
    }));
    // The store owns revision/lifecycle advancement. An earlier read may finish
    // after a newer observation; present only the accepted canonical snapshot.
    if (!operation || !sameStrictJsonValue(operation.snapshot, snapshot)) return;
    store.setMachineObservation({ serverId: sourceServerId, machineId: params.update.machineId }, 'available');
    await params.onSnapshot?.(operation);
}
