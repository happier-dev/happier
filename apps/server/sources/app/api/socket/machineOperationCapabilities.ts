import { isDeepStrictEqual } from 'node:util';
import type { Socket } from 'socket.io';
import type { Prisma } from '@prisma/client';
import {
    MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
    MachineUpdateOperationProtocolCapabilitiesRequestV1Schema,
    type MachineOperationProtocolCapabilitiesV1,
} from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { afterTx, inReadSnapshot, inTx, type Tx } from '@/storage/inTx';
import { markAccountsChanged } from '@/app/changes/markAccountChanged';
import { resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import { log } from '@/utils/logging/log';
import { acquireMachinePublicationLocksInTx, hasCurrentMachineSocketInstallation, resolveMachineScopedPayloadMachineId } from './machinePublication';

async function writeMachineCapabilitiesInTx(tx: Tx, input: Readonly<{
    accountId: string;
    machineId: string;
    installationId: string | null;
    expectedRevision: number | null;
    capabilities: Prisma.InputJsonObject;
    recipientAccountIds: string[];
}>): Promise<number | null> {
    const nextRevision = (input.expectedRevision ?? 0) + 1;
    const { count } = await tx.machine.updateMany({
        where: { accountId: input.accountId, id: input.machineId, installationId: input.installationId,
            revokedAt: null, replacedByMachineId: null, operationProtocolCapabilitiesRevision: input.expectedRevision },
        data: { operationProtocolCapabilities: input.capabilities, operationProtocolCapabilitiesRevision: nextRevision },
    });
    if (count !== 1) return null;
    await markAccountsChanged(tx, { accountIds: input.recipientAccountIds, kind: 'machine', entityId: input.machineId });
    return nextRevision;
}

/** A new daemon must negotiate connection facts itself, even when its installation is unchanged. */
export async function withdrawMachineConnectionCapabilitiesForSocketClaim(input: Readonly<{
    accountId: string;
    machineId: string;
    installationId: string | null;
    isCurrent: () => Promise<boolean>;
}>): Promise<boolean> {
    return inTx(async tx => {
        // Take the publication fence even for an absent leaf: an incumbent
        // publisher admitted before this claim must settle before this read.
        const recipientAccountIds = await acquireMachinePublicationLocksInTx(tx, input.machineId);
        if (!await input.isCurrent()) return false;
        const machine = await tx.machine.findFirst({
            where: { accountId: input.accountId, id: input.machineId, installationId: input.installationId },
            select: { operationProtocolCapabilities: true, operationProtocolCapabilitiesRevision: true,
                revokedAt: true, replacedByMachineId: true },
        });
        if (!machine || classifyMachineAvailabilityState(machine) !== 'available') return false;
        const stored = machine.operationProtocolCapabilities;
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)
            || !Object.hasOwn(stored, 'requesterExecutionIsolation')
                && !Object.hasOwn(stored, 'connectedAccountAuthentication')) return true;
        // These connection facts belong to the replacing daemon; retain other and newer sibling leaves.
        const capabilities = { ...stored };
        delete capabilities.requesterExecutionIsolation;
        delete capabilities.connectedAccountAuthentication;
        return await writeMachineCapabilitiesInTx(tx, { ...input, recipientAccountIds, capabilities,
            expectedRevision: machine.operationProtocolCapabilitiesRevision }) !== null;
    }, { isolationLevel: 'ReadCommitted', transactionClass: 'machine-operation-capabilities' });
}

async function readMachineCapabilitiesPublicationInTx(tx: Tx, input: Readonly<{
    accountId: string;
    machineId: string;
    socket: Socket;
    capabilities: MachineOperationProtocolCapabilitiesV1;
    isCurrent?: () => Promise<boolean>;
}>) {
    if (input.isCurrent && !await input.isCurrent()) return { kind: 'unavailable' as const };
    const admission = await resolveMachineAdmissionInTx(tx, { actorAccountId: input.accountId, machineId: input.machineId });
    if (admission.kind !== 'admitted' || admission.custodianAccountId !== input.accountId
        || !hasCurrentMachineSocketInstallation(input.socket, admission.installationId)) {
        return { kind: 'unavailable' as const };
    }
    const machine = await tx.machine.findFirst({
        where: { accountId: admission.custodianAccountId, id: input.machineId, installationId: admission.installationId },
        select: { operationProtocolCapabilities: true, operationProtocolCapabilitiesRevision: true,
            revokedAt: true, replacedByMachineId: true },
    });
    if (!machine || classifyMachineAvailabilityState(machine) !== 'available') {
        return { kind: 'unavailable' as const };
    }
    const expectedRevision = machine.operationProtocolCapabilitiesRevision;
    if (expectedRevision !== null && expectedRevision > 0
        && isDeepStrictEqual(machine.operationProtocolCapabilities, input.capabilities)) {
        return { kind: 'unchanged' as const, revision: expectedRevision };
    }
    return { kind: 'change_required' as const, expectedRevision, installationId: admission.installationId };
}

/** The installed current daemon replaces the complete projection; omission withdraws a leaf. */
export function registerMachineOperationCapabilitiesHandler(accountId: string, socket: Socket, options: Readonly<{
    isCurrent?: () => Promise<boolean>;
}>): void {
    socket.on(MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, async (
        request: unknown,
        callback?: (response: unknown) => void,
    ) => {
        const parsed = MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.safeParse(request);
        const machineId = parsed.success ? resolveMachineScopedPayloadMachineId(socket, parsed.data.machineId) : null;
        if (!parsed.success || !machineId) {
            callback?.({ v: 1, result: 'error', code: 'invalid_request' });
            return;
        }
        try {
            // Credential withdrawal closes this admitted stream through Socket.IO eviction.
            if (!socket.connected) {
                callback?.({ v: 1, result: 'error', code: 'machine_unavailable' });
                socket.disconnect(true);
                return;
            }
            const readPublication = (tx: Tx) => readMachineCapabilitiesPublicationInTx(tx, {
                accountId, machineId, socket, capabilities: parsed.data.capabilities, isCurrent: options.isCurrent,
            });
            let observed = await inReadSnapshot(readPublication, { transactionClass: 'machine-operation-capabilities-read' });
            if (observed.kind === 'unchanged') {
                if (!socket.connected) {
                    callback?.({ v: 1, result: 'error', code: 'machine_unavailable' });
                    socket.disconnect(true);
                    return;
                }
                observed = await inReadSnapshot(readPublication, { transactionClass: 'machine-operation-capabilities-read' });
            }
            if (observed.kind !== 'change_required') {
                callback?.(observed.kind === 'unchanged'
                    ? { v: 1, result: 'success', revision: observed.revision }
                    : { v: 1, result: 'error', code: 'machine_unavailable' });
                return;
            }
            await inTx(async tx => {
                const recipientAccountIds = await acquireMachinePublicationLocksInTx(tx, machineId);
                // Ownership is checked after the same fence as lifecycle withdrawal.
                const admitted = await readPublication(tx);
                if (admitted.kind === 'unavailable') {
                    afterTx(tx, () => callback?.({ v: 1, result: 'error', code: 'machine_unavailable' }));
                    return;
                }
                if (admitted.kind === 'unchanged') {
                    afterTx(tx, () => callback?.({ v: 1, result: 'success', revision: admitted.revision }));
                    return;
                }
                const { expectedRevision, installationId } = admitted;
                const nextRevision = await writeMachineCapabilitiesInTx(tx, { accountId, machineId, installationId,
                    expectedRevision, capabilities: parsed.data.capabilities, recipientAccountIds });
                if (nextRevision === null) {
                    const fresh = await tx.machine.findFirst({ where: { accountId, id: machineId },
                        select: { revokedAt: true, replacedByMachineId: true, installationId: true } });
                    afterTx(tx, () => callback?.({ v: 1, result: 'error', code:
                        classifyMachineAvailabilityState(fresh) === 'available' && fresh?.installationId === installationId
                            ? 'internal_error' : 'machine_unavailable' }));
                    return;
                }
                afterTx(tx, () => callback?.({ v: 1, result: 'success', revision: nextRevision }));
            }, { isolationLevel: 'ReadCommitted', transactionClass: 'machine-operation-capabilities' });
        } catch {
            log({ module: 'websocket', level: 'error', event: MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
                errorCode: 'internal_error' }, 'Machine operation protocol capability update failed.');
            callback?.({ v: 1, result: 'error', code: 'internal_error' });
        }
    });
}
