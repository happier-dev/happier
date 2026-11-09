import {
    ActionOperationSnapshotV1Schema,
    canAdvanceActionOperationSnapshotV1,
    projectActionOperationSnapshotForV1Reader,
    projectActionOperationListSnapshotV1,
    type ActionOperationGetV1Response,
    type ActionOperationRevisionEphemeralV1,
} from '@happier-dev/protocol/actions/operations/v1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { MACHINE_SETUP_APPLY_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';

import { actionOperationStore, type ActionOperationStore } from './actionOperationStore';
import {
    normalizeActionOperationServerId,
    actionOperationAddressKey,
    type QualifiedActionOperation,
} from './qualifiedActionOperation';

type PendingPushRefresh = Readonly<{ shouldContinue: () => boolean; promise: Promise<void> }>;
const pushRefreshes = new WeakMap<ActionOperationStore, Map<string, PendingPushRefresh>>();

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
    const snapshot = parsed.data;
    if (
        snapshot.scope.accountId !== params.accountId
        || snapshot.scope.machineId !== params.update.machineId
    ) return;

    const store = params.store ?? actionOperationStore;
    const address = actionOperationAddressKey({ serverId: sourceServerId, operationId: snapshot.operationId });
    const retained = store.getSnapshot().operationsByKey.get(address);
    if (retained && !canAdvanceActionOperationSnapshotV1(retained.snapshot, snapshot)
        && !(retained.snapshotComplete !== true && retained.snapshot.revision === snapshot.revision
            && sameStrictJsonValue(projectActionOperationListSnapshotV1(retained.snapshot),
                projectActionOperationListSnapshotV1(snapshot)))) return;
    // Reboot and successful Software Apply publish full Account-scoped facts
    // before the target daemon can disappear. Other notifications still need
    // the ordinary fresh read to supply their current domain facts.
    if (((snapshot.actionId === 'machines.reboot' && snapshot.domainRef?.kind === 'machineReboot'
        && snapshot.domainRef.basis?.dispatchStarted)
        || (snapshot.actionId === MACHINE_SETUP_APPLY_ACTION_ID_V1 && snapshot.state === 'succeeded'
            && snapshot.domainRef?.kind === 'machineSetup'))
        && snapshot.domainRef.machineId === snapshot.scope.machineId
        && areServerProfileIdentifiersEquivalent(snapshot.domainRef.serverId, sourceServerId)) {
        store.mergeSnapshots({ serverId: sourceServerId, snapshots: [snapshot], snapshotComplete: true });
    }

    let reads = pushRefreshes.get(store);
    if (!reads) { reads = new Map(); pushRefreshes.set(store, reads); }
    const key = JSON.stringify([address, snapshot.scope.accountId, snapshot.scope.machineId,
        snapshot.scope.sessionId, snapshot.actionId, snapshot.revision]);
    const pending = reads.get(key);
    if (pending?.shouldContinue()) { await pending.promise; return; }
    // Join copies of this notification only. A new revision retains its fresh
    // Machine admission; a retired Account observer cannot own a new read.
    const promise = refreshActionOperationSnapshot({ ...params, store,
        operation: { serverId: sourceServerId, snapshot } }).finally(() => {
        if (reads.get(key)?.promise === promise) reads.delete(key);
        if (reads.size === 0 && pushRefreshes.get(store) === reads) pushRefreshes.delete(store);
    });
    reads.set(key, { shouldContinue, promise });
    await promise;
}

/** Both notifications and terminal exit re-read the daemon through this admission path. */
export async function refreshActionOperationSnapshot(params: Readonly<{
    operation: QualifiedActionOperation;
    readSnapshot: (operationId: string) => Promise<ActionOperationGetV1Response>;
    store?: ActionOperationStore;
    shouldContinue?: () => boolean;
    onSnapshot?: (operation: QualifiedActionOperation) => void | Promise<void>;
}>): Promise<void> {
    const shouldContinue = params.shouldContinue ?? (() => true);
    if (!shouldContinue()) return;
    const sourceServerId = params.operation.serverId;
    let snapshot = params.operation.snapshot;
    const { accountId, machineId } = snapshot.scope;
    const store = params.store ?? actionOperationStore;
    const unavailable = () => store.setMachineObservation({ serverId: sourceServerId, machineId }, 'unavailable');
    let snapshotComplete = false;
    try {
        const response = await params.readSnapshot(snapshot.operationId);
        if (!shouldContinue()) return;
        if (response.kind !== 'found' || response.operation.operationId !== snapshot.operationId
            || response.operation.actionId !== snapshot.actionId
            || response.operation.scope.accountId !== accountId
            || response.operation.scope.machineId !== machineId
            || response.operation.scope.sessionId !== snapshot.scope.sessionId
            || response.operation.revision < snapshot.revision) {
            unavailable();
            return;
        }
        snapshot = response.operation;
        snapshotComplete = true;
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
    store.mergeSnapshots({ serverId: sourceServerId, snapshots: [snapshot], ...(snapshotComplete ? { snapshotComplete: true } : {}) });
    const operation = store.getSnapshot().operationsByKey.get(actionOperationAddressKey({
        serverId: sourceServerId, operationId: snapshot.operationId,
    }));
    // The store owns revision/lifecycle advancement. An earlier read may finish
    // after a newer observation; present only the accepted canonical snapshot.
    if (!operation || !sameStrictJsonValue(operation.snapshot, snapshot)) return;
    store.setMachineObservation({ serverId: sourceServerId, machineId }, 'available');
    await params.onSnapshot?.(operation);
}
