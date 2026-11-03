import type { Socket } from 'socket.io';
import { afterTx, inTx, type Tx } from '@/storage/inTx';
import { MachineUpdateStateRequestSchema, type MachineUpdateStateResponse } from '@happier-dev/protocol/machines/metadataUpdate';
import { machineUpdateMatchesStoredMode, machineStoredContentMatchesAccountMode } from '@happier-dev/protocol/machines/machineStoredContent';
import { resolveMachineAdmissionInTx, resolveMachineAccessForActorsInTx } from '@/app/machines/machineAccess';
import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import { recordMachineAliveInTx } from '@/app/presence/presenceRecorder';
import { readMachineDevcontainerChildInTx, acquireManagedMachinePublicationAccountsInTx, invalidateManagedMachineInTx,
    type StoredManagedMachine } from '@/app/machines/managed/managedRows';
import { readManagedGuestActivityPublicationRowInTx } from '@/app/machines/managed/managedGuestActivity';
import { markAccountsChanged } from '@/app/changes/markAccountChanged';
import { buildUpdateMachineUpdate, eventRouter } from '@/app/events/eventRouter';
import { serializeMachineKeyBasis } from '@/app/machines/machineSerialization';
import { randomKeyNaked } from '@/utils/keys/randomKeyNaked';
import { log } from '@/utils/logging/log';
import { readDatabaseErrorCode } from '@/storage/transactionErrors';
import { acquireMachinePublicationLocksInTx, resolveMachineScopedPayloadMachineId, hasCurrentMachineSocketInstallation, encodedMachineEnvelope, readMarkedMachineSocketUpgradeRequired, isSafePlainMachinePublication, publishMachineAliveObservation } from './machinePublication';

export function registerMachineDaemonStateHandler(userId: string, socket: Socket): void {
    // Machine daemon state update with optimistic concurrency control
    socket.on('machine-update-state', async (data: unknown, callback: (response: MachineUpdateStateResponse) => void) => {
        try {
            const parsed = MachineUpdateStateRequestSchema.safeParse(data);
            const machineId = parsed.success ? resolveMachineScopedPayloadMachineId(socket, parsed.data.machineId) : null;

            // Validate input
            if (!parsed.success || !machineId) {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }
            const { daemonState, expectedVersion, expectedDataEncryptionKey } = parsed.data;

            if (!socket.connected) {
                callback?.({ result: 'error', message: 'Forbidden' });
                socket.disconnect(true);
                return;
            }
            const response = (value: MachineUpdateStateResponse) => ({ kind: 'response' as const, value });
            const readContent = async (tx: Tx) => {
                const admission = await resolveMachineAdmissionInTx(tx, { actorAccountId: userId, machineId });
                if (admission.kind !== 'admitted'
                    || admission.custodianAccountId !== userId
                    || !hasCurrentMachineSocketInstallation(socket, admission.installationId)) {
                    return response({ result: 'error', message: 'Forbidden' });
                }
                const machine = await tx.machine.findFirst({
                    where: { accountId: admission.custodianAccountId, id: machineId, installationId: admission.installationId },
                    select: {
                        id: true,
                        accountId: true,
                        kind: true,
                        daemonStateVersion: true,
                        metadataVersion: true,
                        daemonState: true,
                        metadata: true,
                        dataEncryptionKey: true,
                        installationId: true,
                        revokedAt: true,
                        replacedByMachineId: true,
                        active: true,
                        lastActiveAt: true,
                    },
                });
                if (!machine) {
                    return response({ result: 'error', message: 'Machine not found' });
                }
                const machineState = classifyMachineAvailabilityState(machine);
                if (machineState === "revoked") {
                    return response({ result: 'error', message: 'Machine revoked' });
                }
                if (machineState === "replaced") {
                    return response({ result: 'error', message: 'Machine replaced' });
                }
                if (!hasCurrentMachineSocketInstallation(socket, machine.installationId)) {
                    return response({ result: 'error', message: 'Machine installation changed' });
                }
                if (encodedMachineEnvelope(machine.dataEncryptionKey) !== expectedDataEncryptionKey) {
                    return response({ result: 'key-mismatch' });
                }
                const upgradeRequired =
                    readMarkedMachineSocketUpgradeRequired(
                        socket,
                        machine.dataEncryptionKey,
                    );
                if (upgradeRequired) {
                    return response(upgradeRequired);
                }
                if (!machineUpdateMatchesStoredMode({ dataEncryptionKey: machine.dataEncryptionKey, daemonState })
                    || !machineStoredContentMatchesAccountMode({
                    mode: admission.encryptionMode,
                    metadata: machine.metadata,
                    daemonState,
                    dataEncryptionKey: machine.dataEncryptionKey,
                    storedRead: true,
                }) || (admission.encryptionMode === 'plain' && !isSafePlainMachinePublication(machine.metadata, daemonState))) {
                    return response({ result: 'error', message: 'Invalid parameters' });
                }

                if (machine.daemonStateVersion !== expectedVersion) {
                    return response({ result: 'version-mismatch', version: machine.daemonStateVersion, daemonState: machine.daemonState });
                }
                return { kind: machine.daemonState === daemonState ? 'unchanged' as const : 'change_required' as const, machine };
            };
            const acknowledgeRead = (tx: Tx, current: Awaited<ReturnType<typeof readContent>>) => {
                afterTx(tx, () => callback?.(current.kind === 'response' ? current.value
                    : { result: 'success', version: current.machine.daemonStateVersion, daemonState: current.machine.daemonState }));
            };
            type AdmittedMachine = Extract<Awaited<ReturnType<typeof readContent>>, { machine: object }>['machine'];
            const publishContent = async (tx: Tx, recipientAccountIds: string[], machine: AdmittedMachine,
                managedActivityRow: StoredManagedMachine | null) => {
                const { count } = await tx.machine.updateMany({
                    where: {
                        accountId: userId, id: machineId, daemonStateVersion: expectedVersion,
                        dataEncryptionKey: machine.dataEncryptionKey, installationId: machine.installationId,
                        revokedAt: null, replacedByMachineId: null,
                    },
                    data: {
                        daemonState,
                        daemonStateVersion: expectedVersion + 1,
                    },
                });

                if (count === 0) {
                    const fresh = await tx.machine.findFirst({
                        where: { accountId: userId, id: machineId },
                        select: { daemonStateVersion: true, daemonState: true, dataEncryptionKey: true, installationId: true, revokedAt: true, replacedByMachineId: true },
                    });
                    const freshState = classifyMachineAvailabilityState(fresh);
                    if (freshState === "revoked") {
                        afterTx(tx, () => callback?.({ result: 'error', message: 'Machine revoked' }));
                        return null;
                    }
                    if (freshState === "replaced") {
                        afterTx(tx, () => callback?.({ result: 'error', message: 'Machine replaced' }));
                        return null;
                    }
                    if (!fresh) {
                        afterTx(tx, () => callback?.({ result: 'error', message: 'Machine not found' }));
                        return null;
                    }
                    if (!hasCurrentMachineSocketInstallation(socket, fresh.installationId)) {
                        afterTx(tx, () => callback?.({ result: 'error', message: 'Machine installation changed' }));
                        return null;
                    }
                    if (encodedMachineEnvelope(fresh.dataEncryptionKey) !== expectedDataEncryptionKey) {
                        afterTx(tx, () => callback?.({ result: 'key-mismatch' }));
                        return null;
                    }
                    afterTx(tx, () => callback?.({ result: 'version-mismatch', version: fresh.daemonStateVersion, daemonState: fresh.daemonState }));
                    return null;
                }

                const daemonStateUpdate = { value: daemonState, version: expectedVersion + 1 };
                // The hint wakes policy only; signed exact activity still decides idle.
                if (managedActivityRow) await invalidateManagedMachineInTx(tx, managedActivityRow);
                const child = await readMachineDevcontainerChildInTx(tx, machineId);
                const recipientAccess = await resolveMachineAccessForActorsInTx(tx, { machineId, actorAccountIds: recipientAccountIds });
                const publications = await markAccountsChanged(tx, { accountIds: recipientAccountIds, kind: 'machine', entityId: machineId });
                for (const cursor of publications) {
                    const accountId = cursor.accountId;
                    const access = recipientAccess.get(accountId);
                    const devcontainerChild = access?.accessState === 'ready' ? child : null;
                    afterTx(tx, () => {
                        const updatePayload = buildUpdateMachineUpdate(
                            machineId, cursor.resolveCursor(), randomKeyNaked(12), undefined, daemonStateUpdate,
                            { keyBasis: serializeMachineKeyBasis({ ...machine, daemonStateVersion: expectedVersion + 1 }), devcontainerChild },
                        );
                        eventRouter.emitUpdate({
                            userId: accountId,
                            payload: updatePayload,
                            recipientFilter: { type: 'machine-scoped-only', machineId },
                        });
                    });
                }
                afterTx(tx, () => callback?.({ result: 'success', version: expectedVersion + 1, daemonState }));
                return { recipientAccountIds, wasOffline: !machine.active, lastActiveAt: machine.lastActiveAt };
            };
            const presence = await inTx(async tx => {
                // Rejected/stale CAS requests and exact equal encoded content
                // need no publication fence, content write or liveness update.
                // Re-admit equality after its observation so revocation or an
                // installation change cannot hide behind the no-op path.
                let observed = await readContent(tx);
                if (observed.kind === 'unchanged') observed = await readContent(tx);
                if (observed.kind !== 'change_required') {
                    acknowledgeRead(tx, observed);
                    return null;
                }
                // Keep the existing Account→Machine lock order of semantic publishers.
                const managedActivityRow = parsed.data.managedActivityChanged === true && observed.machine.installationId
                    ? await readManagedGuestActivityPublicationRowInTx(tx, { accountId: userId, machineId,
                        installationId: observed.machine.installationId }) : null;
                if (managedActivityRow) await acquireManagedMachinePublicationAccountsInTx(tx,
                    { homeId: managedActivityRow.homeId, managedId: managedActivityRow.id });
                const recipientAccountIds = await acquireMachinePublicationLocksInTx(tx, machineId);
                const current = await readContent(tx);
                if (current.kind !== 'change_required') {
                    acknowledgeRead(tx, current);
                    return null;
                }
                const timestamp = Date.now();
                const admission = await recordMachineAliveInTx(tx, { accountId: userId, machineId, timestamp },
                    (_, machine) => publishContent(tx, recipientAccountIds, { ...current.machine,
                        active: machine.active, lastActiveAt: machine.lastActiveAt }, managedActivityRow), current.machine);
                return admission ? { admission, timestamp } : null;
            }, {
                isolationLevel: "ReadCommitted",
                transactionClass: "machine-daemon-state",
            });
            if (presence?.admission.wasOffline) await publishMachineAliveObservation(userId, machineId, presence.timestamp, presence.admission);
        } catch (error) {
            const errorCode = readDatabaseErrorCode(error) ?? 'internal_error';
            log(
                {
                    module: 'websocket',
                    level: 'error',
                    event: 'machine-update-state',
                    errorCode,
                },
                'Machine state update failed.',
            );
            if (callback) {
                callback({ result: 'error', message: errorCode === 'internal_error' ? 'Internal error' : errorCode });
            }
        }
    });
}
