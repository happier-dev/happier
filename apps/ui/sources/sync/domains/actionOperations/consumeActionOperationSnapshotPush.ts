import {
    ActionOperationSnapshotV1Schema,
    canAdvanceActionOperationSnapshotV1,
    projectActionOperationSnapshotForV1Reader,
    projectActionOperationListSnapshotV1,
    type ActionOperationGetV1Response,
    type ActionOperationRevisionEphemeralV1,
    type ActionOperationSnapshotV1,
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

type QueuedPushRefresh = Readonly<{
    params: Parameters<typeof consumeActionOperationSnapshotPush>[0];
    shouldContinue: () => boolean;
    snapshot: ActionOperationSnapshotV1;
}>;
type PendingPushRefresh = {
    revision: number;
    shouldContinue: () => boolean;
    promise: Promise<void>;
    queued: QueuedPushRefresh | null;
};
const pushRefreshes = new WeakMap<ActionOperationStore, Map<string, PendingPushRefresh>>();

function needsSnapshotAdmission(
    retained: QualifiedActionOperation | undefined,
    snapshot: ActionOperationSnapshotV1,
): boolean {
    if (!retained) return true;
    if (canAdvanceActionOperationSnapshotV1(retained.snapshot, snapshot)) return true;
    return retained.snapshotComplete !== true
        && retained.snapshot.revision === snapshot.revision
        && sameStrictJsonValue(
            projectActionOperationListSnapshotV1(retained.snapshot),
            projectActionOperationListSnapshotV1(snapshot),
        );
}

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
    if (!needsSnapshotAdmission(retained, snapshot)) return;
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
        const operation = store.getSnapshot().operationsByKey.get(address);
        if (operation && sameStrictJsonValue(operation.snapshot, snapshot)) {
            await params.onSnapshot?.(operation);
        }
        return;
    }

    let reads = pushRefreshes.get(store);
    if (!reads) { reads = new Map(); pushRefreshes.set(store, reads); }
    const key = JSON.stringify([address, snapshot.scope.accountId, snapshot.scope.machineId,
        snapshot.scope.sessionId, snapshot.actionId]);
    const pending = reads.get(key);
    if (pending?.shouldContinue()) {
        if (snapshot.revision > pending.revision
            && (!pending.queued || !pending.queued.shouldContinue() || snapshot.revision >= pending.queued.snapshot.revision)) {
            pending.queued = { params, shouldContinue, snapshot };
        }
        await pending.promise;
        return;
    }
    // Coalesce per operation address so rapid revisions never fan out into
    // concurrent overlapping daemon reads, while preserving latest-revision
    // fresh Machine admission and retiring abandoned observers cleanly.
    const entry: PendingPushRefresh = {
        revision: snapshot.revision,
        shouldContinue,
        queued: null,
        promise: Promise.resolve(),
    };
    const run = async () => {
        let current: QueuedPushRefresh = { params, shouldContinue, snapshot };
        for (;;) {
            await refreshActionOperationSnapshot({ ...current.params, store,
                operation: { serverId: sourceServerId, snapshot: current.snapshot } });
            if (reads.get(key) !== entry) return;
            const next = entry.queued;
            entry.queued = null;
            if (!next || !next.shouldContinue()) return;
            if (!needsSnapshotAdmission(store.getSnapshot().operationsByKey.get(address), next.snapshot)) return;
            entry.revision = next.snapshot.revision;
            entry.shouldContinue = next.shouldContinue;
            current = next;
        }
    };
    entry.promise = run().finally(() => {
        if (reads.get(key) === entry) reads.delete(key);
        if (reads.size === 0 && pushRefreshes.get(store) === reads) pushRefreshes.delete(store);
    });
    reads.set(key, entry);
    await entry.promise;
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
    const address = { serverId: sourceServerId, operationId: snapshot.operationId };
    const key = actionOperationAddressKey(address);
    const retainedRevision = store.getSnapshot().operationsByKey.get(key)?.snapshot.revision;
    const unavailable = () => store.setMachineObservation({ serverId: sourceServerId, machineId }, 'unavailable');
    let snapshotComplete = false;
    try {
        const response = await params.readSnapshot(snapshot.operationId);
        if (!shouldContinue()) return;
        if (response.kind === 'not_found') {
            if (retainedRevision !== undefined && retainedRevision <= snapshot.revision) {
                store.markOperationUnavailable({ ...address, accountId, machineId,
                    actionId: snapshot.actionId, expectedRevision: retainedRevision });
            }
            return;
        }
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
        const retained = store.getSnapshot().operationsByKey.get(key)?.snapshot;
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
    const operation = store.getSnapshot().operationsByKey.get(key);
    // The store owns revision/lifecycle advancement. An earlier read may finish
    // after a newer observation; present only the accepted canonical snapshot.
    if (!operation || !sameStrictJsonValue(operation.snapshot, snapshot)) return;
    store.setMachineObservation({ serverId: sourceServerId, machineId }, 'available');
    await params.onSnapshot?.(operation);
}
